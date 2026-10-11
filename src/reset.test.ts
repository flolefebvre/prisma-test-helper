import { describe, expect, test } from "vitest";

import {
  assertWorkerDatabase,
  buildResetStatement,
  prepareReset,
  type DiscoveredRelation,
  type ResetClient,
} from "./reset.js";

// Everything here runs without a database: the guard and the builder are pure, and
// `prepareReset` is driven through a stub client that answers the two raw reads. That
// the statement actually empties a real database is proven by
// tests/integration/reset.test.ts.

const WORKER_URL = "postgresql://u:p@localhost:5432/prisma_test_1";

// Worker Databases are named `<templateName>_<pool id>`, so the guard admits exactly
// that shape: every near-miss below is refused, including the Template Database itself
// and — the case the guard exists for — the dev database.
describe("assertWorkerDatabase", () => {
  test.each([
    ["prisma_test_1", "prisma_test"],
    ["prisma_test_12", "prisma_test"],
    ["myapp_test_3", "myapp_test"],
  ])("admits %s for template %s and returns its name", (name, template) => {
    expect(assertWorkerDatabase(`postgresql://u:p@localhost:5432/${name}`, template)).toBe(name);
  });

  test.each([
    ["prisma_test", "prisma_test", "the Template Database itself"],
    ["prisma_test_", "prisma_test", "an underscore with no pool id"],
    ["prisma_test_1x", "prisma_test", "a pool id that is not digits only"],
    ["prisma_testx", "prisma_test", "a longer name sharing the prefix"],
    ["myapp", "myapp_test", "the dev database"],
    ["prisma_test_1", "myapp_test", "another template's Worker Database"],
    ["myxapp_1", "my.app", "a `.` in the template name read as a regex wildcard"],
  ])("refuses %s for template %s — %s", (name, template) => {
    expect(() => assertWorkerDatabase(`postgresql://u:p@localhost:5432/${name}`, template)).toThrow(
      `refusing to reset ${name} — only Worker Databases (${template}_<pool id>) may be reset`,
    );
  });

  test("refuses a URL with no path — the database name is empty", () => {
    expect(() => assertWorkerDatabase("postgresql://u:p@localhost:5432", "prisma_test")).toThrow(
      "refusing to reset  —",
    );
  });

  test("throws on a string that is not a URL", () => {
    expect(() => assertWorkerDatabase("", "prisma_test")).toThrow(/Invalid URL/);
    expect(() => assertWorkerDatabase("not a url", "prisma_test")).toThrow(/Invalid URL/);
  });
});

describe("buildResetStatement", () => {
  const author = { schema: "public", name: "Author" };
  const authorSeq = { schema: "public", name: "Author_id_seq" };

  test("is one DO block that relaxes FK triggers and bounds lock waits, both locally", () => {
    const statement = buildResetStatement([author], [authorSeq]);

    expect(statement.startsWith("DO $reset$\n")).toBe(true);
    expect(statement.endsWith("\nEND\n$reset$")).toBe(true);
    expect(statement).toContain(
      "PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);",
    );
    expect(statement).toContain("PERFORM pg_catalog.set_config('lock_timeout', '5s', true);");
  });

  test("probes each table and deletes only when it holds rows, quoting via %I", () => {
    const statement = buildResetStatement([author, { schema: "billing", name: "order" }], []);

    expect(statement).toContain(
      "EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', 'public', 'Author') INTO nonempty;\n" +
        "  IF nonempty THEN EXECUTE format('DELETE FROM %I.%I', 'public', 'Author'); END IF;",
    );
    expect(statement).toContain("format('DELETE FROM %I.%I', 'billing', 'order')");
  });

  test("doubles single quotes, so a name cannot end its literal early", () => {
    const statement = buildResetStatement([{ schema: "public", name: "it's" }], []);

    expect(statement).toContain("'public', 'it''s'");
    expect(statement).not.toContain("'it's'");
  });

  test("rewinds only owned sequences that moved, to their own start value", () => {
    const statement = buildResetStatement(
      [author],
      [authorSeq, { schema: "public", name: "Post_id_seq" }],
    );

    expect(statement).toContain(
      "WHERE last_value IS NOT NULL AND (schemaname, sequencename) IN " +
        "(('public', 'Author_id_seq'), ('public', 'Post_id_seq'))",
    );
    expect(statement).toContain("seq.start_value, false);");
  });

  test("omits the sequence pass when no sequence is owned", () => {
    expect(buildResetStatement([author], [])).not.toContain("pg_sequences");
  });

  test("stays a valid block for an empty schema", () => {
    expect(buildResetStatement([], [])).toMatch(/BEGIN\n(.*\n){2}END\n\$reset\$$/);
  });

  test("refuses a name containing its dollar-quote tag", () => {
    expect(() => buildResetStatement([{ schema: "public", name: "a$reset$b" }], [])).toThrow(
      "contains $reset$",
    );
  });
});

describe("prepareReset", () => {
  /** A client whose raw reads answer like Postgres would, recording every raw write. */
  function stubClient(currentDatabase: string, relations: DiscoveredRelation[] = []) {
    const queries: string[] = [];
    const executed: string[] = [];
    const client: ResetClient = {
      $queryRawUnsafe: async (query: string) => {
        queries.push(query);
        return query.includes("current_database()") ? [{ name: currentDatabase }] : relations;
      },
      $executeRawUnsafe: async (query: string) => {
        executed.push(query);
        return 0;
      },
    };
    return { client, queries, executed };
  }

  test("refuses a non-worker URL before sending a single query", async () => {
    const { client, queries } = stubClient("prisma_test");

    await expect(
      prepareReset(client, "postgresql://u:p@localhost:5432/prisma_test", "prisma_test"),
    ).rejects.toThrow("refusing to reset prisma_test");
    expect(queries).toEqual([]);
  });

  test("refuses a client connected elsewhere than DATABASE_URL names, before discovery", async () => {
    const { client, queries } = stubClient("myapp");

    await expect(prepareReset(client, WORKER_URL, "prisma_test")).rejects.toThrow(
      "the client passed to setupDatabase() is connected to myapp, but DATABASE_URL names prisma_test_1",
    );
    expect(queries).toHaveLength(1);
  });

  test("builds the statement from discovery once and sends it per Reset", async () => {
    const { client, queries, executed } = stubClient("prisma_test_1", [
      { kind: "table", schema: "public", name: "Author" },
      { kind: "sequence", schema: "public", name: "Author_id_seq" },
    ]);

    const reset = await prepareReset(client, WORKER_URL, "prisma_test");
    await reset();
    await reset();

    expect(queries).toHaveLength(2);
    expect(executed).toEqual([
      buildResetStatement(
        [{ schema: "public", name: "Author" }],
        [{ schema: "public", name: "Author_id_seq" }],
      ),
      executed[0],
    ]);
  });

  test("a failed Reset names itself and the lock it most likely hit", async () => {
    const { client } = stubClient("prisma_test_1");
    client.$executeRawUnsafe = async () => {
      throw new Error("canceling statement due to lock timeout");
    };

    const reset = await prepareReset(client, WORKER_URL, "prisma_test");

    await expect(reset()).rejects.toThrow(
      /^the Reset could not empty prisma_test_1: canceling statement due to lock timeout\n/,
    );
  });
});
