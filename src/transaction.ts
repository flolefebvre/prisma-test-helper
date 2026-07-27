import { AsyncLocalStorage } from "node:async_hooks";

// The engine never imports the consumer's generated client (or `@prisma/client`): it is
// structurally typed against the two interfaces below — the subset of a Prisma client it
// actually drives. Everything else (model delegates, raw methods) is reached dynamically
// through the Routing Proxy, under the consumer's own client type.

/**
 * The transaction-side surface the engine drives directly: savepoints are raw SQL. Any
 * interactive-transaction client exposing `$executeRawUnsafe` qualifies — a generated
 * `Prisma.TransactionClient` does.
 */
export interface MinimalTransactionClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/**
 * The client-side surface the engine drives directly: opening the one interactive
 * transaction it parks per test. Declared with method syntax so the check is bivariant —
 * a generated `PrismaClient`, whose callback receives its own richer transaction client,
 * is assignable.
 */
export interface MinimalClient {
  $transaction(
    fn: (tx: MinimalTransactionClient) => Promise<unknown>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<unknown>;
}

/**
 * Guard the entry to every Test Transaction. A throwaway container is not enough: if the
 * `DATABASE_URL` wiring in the consumer's setup file ever fails, a client still points at
 * the dev database and every test would run its transaction there. Only Worker Databases
 * — named `<databaseName>_<pool id>` after the Template Database they were cloned from —
 * may host one: even a rolled-back transaction advances sequences and takes locks, so the
 * template and the dev database are refused. The name is matched literally (no regex
 * built from config). Exported so it can be unit-tested without a real connection to a
 * wrongly-named database.
 */
export function assertWorkerDatabase(url: string, databaseName: string): void {
  const name = new URL(url).pathname.slice(1);
  const prefix = `${databaseName}_`;
  const workerId = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  if (!/^\d+$/.test(workerId)) {
    throw new Error(
      `refusing to open a test transaction on ${name} — only Worker Databases ` +
        `(${prefix}<pool id>) may host one`,
    );
  }
}

// The worker's one engine, installed by the consumer's module mock (the Client Seam)
// when the first import of their client module resolves, and driven per-test by the
// harness: `start()` before each test, `rollback()` after.
let current: TestTransaction<MinimalClient> | null = null;

/**
 * Build the worker's engine around the real client and hand back its Routing Proxy —
 * what every importer of the consumer's client module receives instead of the raw
 * client, under the same type. Called once per worker, from the `vi.mock` block in the
 * consumer's test setup file.
 *
 * `databaseName` is the Template Database name the Worker Database was cloned from
 * (the `databaseName` given to `createGlobalSetup`, `"prisma_test"` by default); the
 * guard derives the accepted `<databaseName>_<pool id>` shape from it.
 */
export function installTestTransaction<Client extends MinimalClient>(
  prisma: Client,
  databaseUrl: string,
  databaseName: string,
): Client {
  const engine = new TestTransaction(prisma, databaseUrl, databaseName);
  current = engine;
  return engine.client;
}

/** The engine `installTestTransaction` built for this worker. */
export function testTransaction(): TestTransaction<MinimalClient> {
  if (!current) {
    throw new Error(
      "no test transaction is installed — the app's Prisma client module was not " +
        "imported through the test setup's module mock",
    );
  }
  return current;
}

// Thrown into the parked transaction callback to end it; `start()` recognises it as the
// one expected way the transaction ends, so real errors still surface.
class Rollback extends Error {}

// Raw-query methods route into the live transaction like model delegates do; the
// remaining `$`-methods (`$connect`, `$disconnect`, `$on`, `$extends`, …) are
// connection-level and pass through to the underlying client.
const RAW_METHODS = new Set(["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"]);

// One savepoint scope's turn-taking state: the scope's direct children chain onto
// `tail`, one at a time.
type ScopeQueue = { tail: Promise<void> };

/**
 * One test's database transaction. `start()` opens an interactive transaction and parks
 * it; `client` is a stand-in for the app's Prisma client that routes every query into
 * the parked transaction *at call time* — so a delegate captured at import (a factory's
 * `db.user`) still lands inside whichever transaction is live when the query actually
 * runs; `rollback()` ends the transaction, discarding every write.
 *
 * @example
 * const engine = new TestTransaction(prisma, databaseUrl, "prisma_test");
 * await engine.start();
 * await engine.client.user.create({ data: … }); // inside the transaction
 * await engine.rollback(); // gone
 */
export class TestTransaction<Client extends MinimalClient> {
  private tx: MinimalTransactionClient | null = null;
  private release: (() => void) | null = null;
  private running: Promise<unknown> | null = null;
  private savepointSeq = 0;
  // Serializes savepoint scopes: they share one connection and Postgres savepoints are
  // stack-like, so two interleaved scopes would corrupt each other's rollback —
  // releasing an earlier savepoint destroys every one established after it. Every scope
  // owns a queue its direct children take turns on; top-level scopes take turns on this
  // root queue. A scope waits only on its elder siblings, never on the turn its own
  // parent holds, so nesting cannot deadlock while concurrent siblings serialize.
  private rootScope: ScopeQueue = { tail: Promise.resolve() };
  // The queue owned by the savepoint scope running on the current async path, inherited
  // across awaits so a $transaction nested within another queues on its parent.
  private readonly scopeQueue = new AsyncLocalStorage<ScopeQueue>();

  constructor(
    private readonly prisma: Client,
    private readonly databaseUrl: string,
    private readonly databaseName: string,
  ) {}

  /** Open the transaction and park it until `rollback()`. Refuses a non-worker database. */
  async start(): Promise<void> {
    assertWorkerDatabase(this.databaseUrl, this.databaseName);
    if (this.running) {
      throw new Error(
        "a test transaction is already live — `start()` must be paired with a `rollback()`",
      );
    }

    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));

    this.running = this.prisma
      .$transaction(
        async (tx) => {
          this.tx = tx;
          ready();
          // Park until `rollback()` rejects with `Rollback`. The timeout only bounds a
          // transaction whose `rollback()` never came — a leaked one — so it is far
          // above any test's runtime.
          await new Promise<never>((_, reject) => {
            this.release = () => reject(new Rollback());
          });
        },
        { maxWait: 5_000, timeout: 3_600_000 },
      )
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });

    // `running` settles first only when the transaction failed to open (e.g. the pool
    // handed out a dead connection); racing it turns that failure into a loud `start()`
    // rejection instead of a hang on `isReady`. The reset keeps the failure to this one
    // test — leaving state behind would make every later `start()` claim a transaction
    // is live when none is.
    try {
      await Promise.race([isReady, this.running]);
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  /**
   * End the transaction, discarding its writes. A no-op when none is live. State resets
   * before the transaction's own error (if any) surfaces, so a transaction that died
   * mid-test fails that test alone instead of wedging the engine.
   */
  async rollback(): Promise<void> {
    const running = this.running;
    this.release?.();
    this.reset();
    if (running) await running;
  }

  private reset(): void {
    this.tx = null;
    this.release = null;
    this.running = null;
    this.savepointSeq = 0;
    this.rootScope = { tail: Promise.resolve() };
  }

  private proxy: Client | null = null;

  /**
   * The Routing Proxy: a drop-in for the app's Prisma client. Model delegates and
   * raw-query methods route into the live transaction at call time; everything else
   * passes through to the underlying client. One stable object — consumers may capture
   * it, or any of its delegates, once and forever.
   */
  get client(): Client {
    return (this.proxy ??= new Proxy(this.prisma, {
      get: (target, prop) => {
        if (prop === "$transaction") {
          return (arg: unknown) => {
            this.requireTx();
            if (typeof arg === "function") {
              return this.withSavepoint(() =>
                (arg as (tx: MinimalTransactionClient) => Promise<unknown>)(this.tx!),
              );
            }
            // The batch form: its operations were built through this client, so awaiting
            // them runs them on the live transaction; the savepoint makes the batch
            // atomic, and sequential awaiting keeps the order.
            return this.withSavepoint(async () => {
              const results: unknown[] = [];
              for (const operation of arg as Promise<unknown>[]) {
                results.push(await operation);
              }
              return results;
            });
          };
        }
        if (typeof prop === "string" && RAW_METHODS.has(prop)) {
          return (...args: unknown[]) => {
            const tx = this.requireTx() as unknown as Record<string, (...a: unknown[]) => unknown>;
            return tx[prop]!(...args);
          };
        }
        if (typeof prop === "string" && !prop.startsWith("$")) {
          const value = Reflect.get(target, prop);
          if (value !== null && typeof value === "object") {
            return this.routeDelegate(prop);
          }
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Client);
  }

  private requireTx(): MinimalTransactionClient {
    if (!this.tx) {
      throw new Error(
        "the database was touched with no test transaction live — call `setupDatabase()` " +
          "at the top of the test file, and build test data inside tests, not in `beforeAll`",
      );
    }
    return this.tx;
  }

  /**
   * Run `op` inside its own savepoint on the live transaction: released on success,
   * rolled back — restoring a healthy transaction — when `op` throws. A scope takes a
   * turn on its parent's queue — the root queue when opened outside any scope — so
   * concurrent siblings serialize instead of interleaving savepoints on the shared
   * connection, while a scope nested sequentially starts at once: its parent's queue
   * is empty, and it never waits on the turn its own parent holds.
   */
  private withSavepoint<T>(op: () => Promise<T>): Promise<T> {
    const parent = this.scopeQueue.getStore() ?? this.rootScope;
    const scope: ScopeQueue = { tail: Promise.resolve() };
    const run = parent.tail.then(() => this.scopeQueue.run(scope, () => this.savepointScope(op)));
    parent.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async savepointScope<T>(op: () => Promise<T>): Promise<T> {
    const tx = this.requireTx();
    const name = `test_savepoint_${++this.savepointSeq}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
    try {
      const result = await op();
      await this.drainChildren();
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.drainChildren();
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  }

  // A scope's `op` can settle while children are still queued — `Promise.all` rejects
  // on the first sibling failure, leaving later siblings waiting for their turn. They
  // must finish inside this scope's savepoint before it releases or rolls back, or
  // their savepoints would interleave with its exit. Runs inside the scope's own
  // `scopeQueue.run`, so the store is this scope's queue; the loop re-checks because a
  // draining child can enqueue children of its own. Waiting on children cannot
  // deadlock: a child never waits on the turn its parent holds.
  private async drainChildren(): Promise<void> {
    const scope = this.scopeQueue.getStore();
    if (!scope) return;
    let tail: Promise<void>;
    do {
      tail = scope.tail;
      await tail;
    } while (scope.tail !== tail);
  }

  /**
   * A stand-in for one model delegate (`db.user`). Method calls resolve the live
   * transaction when invoked, which is what makes eagerly captured delegates safe.
   */
  private routeDelegate(model: string): object {
    const source = this.prisma as unknown as Record<string, Record<string | symbol, unknown>>;
    return new Proxy(source[model]!, {
      get: (target, method) => {
        const value = Reflect.get(target, method);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const delegate = this.requireTx() as unknown as Record<
            string,
            Record<string | symbol, (...a: unknown[]) => unknown>
          >;
          return delegate[model]![method]!(...args);
        };
      },
    });
  }
}
