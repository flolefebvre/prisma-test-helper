import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, inject, test } from "vitest";

import { installTestTransaction } from "../../src/index.js";
import { TestTransaction, testTransaction } from "../../src/transaction.js";
import { PrismaClient } from "../generated/prisma/client.js";

// Ported from pvm3.0's engine suite: the tests drive `TestTransaction` directly against
// this worker's Worker Database (`prisma_test_<pool id>`, provisioned by the repo's own
// globalSetup). `rawDb` is an unwrapped client on the same database — its reads happen
// over its own connection, outside any transaction, so it sees only committed rows.
// Nothing this file writes survives: every write happens inside an engine transaction
// that the test rolls back. Guard-only behavior lives in src/transaction.test.ts.

let workerUrl: string;
let rawDb: PrismaClient;

beforeAll(() => {
  const url = new URL(inject("templateDatabaseUri"));
  url.pathname = `/prisma_test_${process.env.VITEST_POOL_ID}`;
  workerUrl = url.toString();
  rawDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: workerUrl }) });
});

afterAll(() => rawDb.$disconnect());

/** Build an engine on the Worker Database, run `fn` inside a live transaction, always roll back. */
async function withEngine(
  fn: (engine: TestTransaction<PrismaClient>) => Promise<void>,
): Promise<void> {
  const engine = new TestTransaction(rawDb, workerUrl, "prisma_test");
  await engine.start();
  try {
    await fn(engine);
  } finally {
    await engine.rollback();
  }
}

describe("installTestTransaction", () => {
  test("returns the Routing Proxy under the concrete client type and installs the engine", async () => {
    // Act: the exact call the consumer's Client Seam makes.
    const proxy = installTestTransaction(rawDb, workerUrl, "prisma_test");

    // Assert: the generic preserves the consumer's client type — `tsc` fails here if
    // the proxy degrades to the structural constraint.
    expectTypeOf(proxy).toEqualTypeOf<PrismaClient>();

    // Assert: the installed engine drives the proxy end to end.
    const engine = testTransaction();
    await engine.start();
    try {
      await proxy.author.create({ data: { name: "tx-install" } });
      expect(await proxy.author.count({ where: { name: "tx-install" } })).toBe(1);
      expect(await rawDb.author.count({ where: { name: "tx-install" } })).toBe(0);
    } finally {
      await engine.rollback();
    }
  });
});

describe("lifecycle", () => {
  test("a write through the engine client is readable back through it", async () => {
    await withEngine(async (engine) => {
      // Act
      await engine.client.author.create({ data: { name: "tx-lifecycle" } });

      // Assert
      const found = await engine.client.author.findMany({ where: { name: "tx-lifecycle" } });
      expect(found).toHaveLength(1);
    });
  });

  test("the write is invisible to the raw client while the transaction is live", async () => {
    await withEngine(async (engine) => {
      // Act
      await engine.client.author.create({ data: { name: "tx-invisible" } });

      // Assert: the raw client reads over its own connection, outside the transaction,
      // so an uncommitted row must not be there.
      const seen = await rawDb.author.findMany({ where: { name: "tx-invisible" } });
      expect(seen).toHaveLength(0);
    });
  });

  test("rollback() discards the write", async () => {
    // Arrange
    const engine = new TestTransaction(rawDb, workerUrl, "prisma_test");
    await engine.start();
    await engine.client.author.create({ data: { name: "tx-discard" } });

    // Act
    await engine.rollback();

    // Assert
    const seen = await rawDb.author.findMany({ where: { name: "tx-discard" } });
    expect(seen).toHaveLength(0);
  });

  test("the engine restarts for the next test", async () => {
    // Arrange: a full start → write → rollback cycle has already happened.
    const engine = new TestTransaction(rawDb, workerUrl, "prisma_test");
    await engine.start();
    await engine.client.author.create({ data: { name: "tx-restart" } });
    await engine.rollback();

    // Act
    await engine.start();

    // Assert: the second transaction is fresh — the first one's write is gone.
    try {
      const seen = await engine.client.author.findMany({ where: { name: "tx-restart" } });
      expect(seen).toHaveLength(0);
    } finally {
      await engine.rollback();
    }
  });

  test("start() twice throws", async () => {
    await withEngine(async (engine) => {
      await expect(engine.start()).rejects.toThrow(/already live/);
    });
  });

  test("a transaction killed server-side does not wedge the engine", async () => {
    // Arrange: a parked transaction whose backend is terminated from another
    // connection — the pool cannot notice, so the dead connection goes back into it on
    // rollback and is handed to a later `start()`.
    const engine = new TestTransaction(rawDb, workerUrl, "prisma_test");
    await engine.start();
    const [row] = await engine.client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await rawDb.$queryRaw`SELECT pg_terminate_backend(${row!.pid})`;

    // Act: end the test the way the harness would. Whether the death surfaces here or
    // on a later `start()` depends on pool timing; what must never happen is the engine
    // staying wedged.
    await engine.rollback().catch(() => undefined);

    // Assert: the engine serves the next test. The pool may hand back the dead
    // connection once — a failed `start()` must reset, so one retry succeeds; a wedged
    // engine fails both with "already live". The count is scoped to a name nothing
    // writes, so it holds however the pool assigns files to this Worker Database. Since
    // the dogfood conversion no integration file commits into it — harness.test.ts
    // depends on that, asserting bare table counts — and a new one that did would flake
    // that file first.
    await engine.start().catch(() => engine.start());
    try {
      expect(await engine.client.author.count({ where: { name: "tx-killed" } })).toBe(0);
    } finally {
      await engine.rollback();
    }
  });
});

describe("call-time routing", () => {
  test("a delegate captured before start() still writes inside the transaction", async () => {
    // Arrange: capture the delegate while no transaction is live — exactly what a
    // consumer factory does at module import.
    const engine = new TestTransaction(rawDb, workerUrl, "prisma_test");
    const authors = engine.client.author;
    await engine.start();

    try {
      // Act
      await authors.create({ data: { name: "tx-eager" } });

      // Assert: the row is in the transaction (engine sees it), not autocommitted
      // (the raw client does not).
      expect(await engine.client.author.count({ where: { name: "tx-eager" } })).toBe(1);
      const committed = await rawDb.author.findMany({ where: { name: "tx-eager" } });
      expect(committed).toHaveLength(0);
    } finally {
      await engine.rollback();
    }
  });

  test("connection-level $-methods execute through the proxy on the underlying client", async () => {
    // Arrange: a dedicated client, so disconnecting it cannot break other tests.
    const extra = new PrismaClient({ adapter: new PrismaPg({ connectionString: workerUrl }) });
    const engine = new TestTransaction(extra, workerUrl, "prisma_test");

    // Act + Assert: `$connect`/`$disconnect` need no live transaction — they pass
    // through and run on the real client, not on a routed stand-in.
    await expect(engine.client.$connect()).resolves.toBeUndefined();
    await expect(engine.client.$disconnect()).resolves.toBeUndefined();
    expect(typeof engine.client.$on).toBe("function");
  });

  test("$queryRaw routes to the live transaction", async () => {
    await withEngine(async (engine) => {
      // Arrange
      await engine.client.author.create({ data: { name: "tx-raw" } });

      // Act: a raw query through the engine client must see the uncommitted row.
      const rows = await engine.client.$queryRaw<
        { name: string }[]
      >`SELECT name FROM "Author" WHERE name = 'tx-raw'`;

      // Assert
      expect(rows).toHaveLength(1);
    });
  });
});

describe("nested $transaction", () => {
  test("$transaction(fn) writes land in the outer transaction, not the database", async () => {
    await withEngine(async (engine) => {
      // Act
      await engine.client.$transaction(async (tx) => {
        await tx.author.create({ data: { name: "tx-nested" } });
      });

      // Assert: visible inside the test transaction, never committed.
      expect(await engine.client.author.count({ where: { name: "tx-nested" } })).toBe(1);
      expect(await rawDb.author.count({ where: { name: "tx-nested" } })).toBe(0);
    });
  });

  test("a throwing callback undoes only its own writes; the outer transaction stays usable", async () => {
    await withEngine(async (engine) => {
      // Arrange
      await engine.client.author.create({ data: { name: "tx-outer" } });

      // Act
      await expect(
        engine.client.$transaction(async (tx) => {
          await tx.author.create({ data: { name: "tx-inner" } });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // Assert: the inner write is gone, the outer one is not, and the outer
      // transaction still answers queries.
      expect(await engine.client.author.count({ where: { name: "tx-inner" } })).toBe(0);
      expect(await engine.client.author.count({ where: { name: "tx-outer" } })).toBe(1);
    });
  });

  test("a constraint violation inside $transaction(fn) is catchable and the outer transaction stays healthy", async () => {
    await withEngine(async (engine) => {
      // Arrange
      await engine.client.author.create({ data: { name: "tx-fk-outer" } });

      // Act: the orphan post violates the `Post.authorId` foreign key. Without a
      // savepoint the error would abort the whole test transaction (SQLSTATE 25P02)
      // and the count below would fail.
      await expect(
        engine.client.$transaction(async (tx) => {
          await tx.post.create({ data: { title: "orphan", authorId: 424242 } });
        }),
      ).rejects.toThrow();

      // Assert
      expect(await engine.client.author.count({ where: { name: "tx-fk-outer" } })).toBe(1);
    });
  });

  test("$transaction inside $transaction nests", async () => {
    await withEngine(async (engine) => {
      // Act: the inner call goes through the global client, the way app code holding
      // the client singleton would.
      await engine.client.$transaction(async () => {
        await engine.client.$transaction(async (tx) => {
          await tx.author.create({ data: { name: "tx-deep" } });
        });
      });

      // Assert
      expect(await engine.client.author.count({ where: { name: "tx-deep" } })).toBe(1);
      expect(await rawDb.author.count({ where: { name: "tx-deep" } })).toBe(0);
    });
  });

  test("$transaction([...]) resolves results in order", async () => {
    await withEngine(async (engine) => {
      // Act
      const [a, b] = await engine.client.$transaction([
        engine.client.author.create({ data: { name: "tx-batch-a" } }),
        engine.client.author.create({ data: { name: "tx-batch-b" } }),
      ]);

      // Assert
      expect(a.name).toBe("tx-batch-a");
      expect(b.name).toBe("tx-batch-b");
      expect(await rawDb.author.count({ where: { name: { contains: "tx-batch-" } } })).toBe(0);
    });
  });

  test("$transaction([...]) with a failing operation undoes the batch; the outer transaction stays usable", async () => {
    await withEngine(async (engine) => {
      // Act: the second operation violates the foreign key.
      await expect(
        engine.client.$transaction([
          engine.client.author.create({ data: { name: "tx-batch-ok" } }),
          engine.client.post.create({ data: { title: "orphan", authorId: 424242 } }),
        ]),
      ).rejects.toThrow();

      // Assert: the batch is atomic — its successful member is undone too.
      expect(await engine.client.author.count({ where: { name: "tx-batch-ok" } })).toBe(0);
    });
  });

  test("concurrent sibling $transaction(fn) calls inside an outer one serialize and all land", async () => {
    await withEngine(async (engine) => {
      // Act: the consumer shape from issue #13 — an outer scope whose callback fires
      // several inner scopes together. Their savepoints must not interleave.
      await engine.client.$transaction(async () => {
        await Promise.all(
          [1, 2, 3].map((i) =>
            engine.client.$transaction(async (tx) => {
              await tx.author.create({ data: { name: `tx-sibling-${i}` } });
            }),
          ),
        );
      });

      // Assert: every sibling's write is in the test transaction, none committed.
      expect(
        await engine.client.author.count({ where: { name: { contains: "tx-sibling-" } } }),
      ).toBe(3);
      expect(await rawDb.author.count({ where: { name: { contains: "tx-sibling-" } } })).toBe(0);
    });
  });

  test("a throwing sibling undoes only its own writes; the others and the outer scope survive", async () => {
    await withEngine(async (engine) => {
      // Act: two siblings race inside an outer scope that has already written; one
      // sibling fails after writing.
      await engine.client.$transaction(async (outer) => {
        await outer.author.create({ data: { name: "tx-sib-outer" } });
        const [ok, boom] = await Promise.allSettled([
          engine.client.$transaction(async (tx) => {
            await tx.author.create({ data: { name: "tx-sib-ok" } });
          }),
          engine.client.$transaction(async (tx) => {
            await tx.author.create({ data: { name: "tx-sib-boom" } });
            throw new Error("boom");
          }),
        ]);
        expect(ok!.status).toBe("fulfilled");
        expect(boom!.status).toBe("rejected");
      });

      // Assert: only the throwing sibling's write is gone.
      expect(await engine.client.author.count({ where: { name: "tx-sib-outer" } })).toBe(1);
      expect(await engine.client.author.count({ where: { name: "tx-sib-ok" } })).toBe(1);
      expect(await engine.client.author.count({ where: { name: "tx-sib-boom" } })).toBe(0);
    });
  });

  test("a scope inside a concurrent sibling nests under that sibling, not the outer scope", async () => {
    await withEngine(async (engine) => {
      // Act: the second sibling completes a grandchild scope, then throws — its
      // rollback must take the grandchild's released savepoint down with it.
      await engine.client.$transaction(async () => {
        await Promise.allSettled([
          engine.client.$transaction(async (tx) => {
            await tx.author.create({ data: { name: "tx-gc-keep" } });
          }),
          engine.client.$transaction(async (tx) => {
            await tx.author.create({ data: { name: "tx-gc-sibling" } });
            await engine.client.$transaction(async (inner) => {
              await inner.author.create({ data: { name: "tx-gc-inner" } });
            });
            throw new Error("boom");
          }),
        ]);
      });

      // Assert: the healthy sibling survives; the throwing one's own write and its
      // grandchild's are both gone.
      expect(await engine.client.author.count({ where: { name: "tx-gc-keep" } })).toBe(1);
      expect(await engine.client.author.count({ where: { name: "tx-gc-sibling" } })).toBe(0);
      expect(await engine.client.author.count({ where: { name: "tx-gc-inner" } })).toBe(0);
    });
  });

  test("two concurrent $transaction(fn) calls serialize and both land", async () => {
    await withEngine(async (engine) => {
      // Act: fired together; the engine must not interleave their savepoints.
      await Promise.all([
        engine.client.$transaction(async (tx) => {
          await tx.author.create({ data: { name: "tx-conc-1" } });
        }),
        engine.client.$transaction(async (tx) => {
          await tx.author.create({ data: { name: "tx-conc-2" } });
        }),
      ]);

      // Assert
      expect(await engine.client.author.count({ where: { name: { contains: "tx-conc-" } } })).toBe(
        2,
      );
    });
  });
});
