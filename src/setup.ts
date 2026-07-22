import { inject } from "vitest";

// The `/setup` entry: what a consumer's Vitest `setupFiles` module imports. It runs
// once per test file, inside the worker, before any app module loads — see the ordering
// note on `setupWorkerDatabase`.

/** What {@link setupWorkerDatabase} hands back: everything the Client Seam needs. */
export interface WorkerDatabase {
  /** Connection URL of this worker's Worker Database — also set as `DATABASE_URL`. */
  databaseUrl: string;
  /** The Template Database name it was cloned from, for the Test Transaction guard. */
  databaseName: string;
}

/**
 * Point this worker at its own Worker Database.
 *
 * Call it at the top of your Vitest setup file, above the `vi.mock` that installs the
 * Client Seam. It reads what `createGlobalSetup` provided, rewrites the URI onto this
 * worker's clone (`<databaseName>_<VITEST_POOL_ID>`), sets `process.env.DATABASE_URL`,
 * and returns both halves — the URL and the template name — because
 * `installTestTransaction` needs both.
 *
 * **Ordering matters.** The assignment below must happen before any module that reads
 * `DATABASE_URL` at import time is loaded, and ES imports hoist above statements — so
 * the setup file must keep *zero* static imports of your app, and reach for them with a
 * dynamic `import()` (or a lazy `vi.mock` factory) instead. A single static app import
 * would parse the environment against your dev `DATABASE_URL` and point the whole suite
 * at your dev database.
 *
 * @example
 * // test/setup.ts
 * const { databaseUrl, databaseName } = setupWorkerDatabase();
 *
 * vi.mock("../src/db/client", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("../src/db/client")>();
 *   return { db: installTestTransaction(actual.db, databaseUrl, databaseName) };
 * });
 */
export function setupWorkerDatabase(): WorkerDatabase {
  const poolId = process.env.VITEST_POOL_ID;
  if (!poolId) {
    throw new Error(
      "VITEST_POOL_ID is not set — @flefebvre/prisma-test-helper could not tell which " +
        "Worker Database belongs to this worker. `setupWorkerDatabase()` must run inside " +
        'a Vitest worker, from a file listed in `setupFiles`, with `pool: "forks"` set ' +
        "in your Vitest config.",
    );
  }

  // Typed as `string`, but `inject` is a plain lookup in the context the main process
  // provided: an unregistered globalSetup yields `undefined` at runtime, not an error.
  const templateUri = inject("templateDatabaseUri") as string | undefined;
  const databaseName = inject("templateDatabaseName") as string | undefined;
  if (!templateUri || !databaseName) {
    throw new Error(
      "No Template Database was provided to this run — @flefebvre/prisma-test-helper's " +
        "global setup did not run. Add a global-setup file exporting " +
        "`createGlobalSetup()` and register it in your Vitest config as " +
        '`globalSetup: ["test/global-setup.ts"]`.',
    );
  }

  const databaseUrl = workerDatabaseUrl(templateUri, databaseName, poolId);
  process.env.DATABASE_URL = databaseUrl;
  return { databaseUrl, databaseName };
}

/**
 * Swap the database in a connection URI for this worker's clone, keeping everything
 * else — credentials, host, port, query parameters — untouched. Exported so the rewrite
 * can be unit-tested without a container.
 *
 * @example
 * workerDatabaseUrl("postgresql://u:p@host:5432/prisma_test", "prisma_test", "1");
 * // → "postgresql://u:p@host:5432/prisma_test_1"
 */
export function workerDatabaseUrl(
  templateUri: string,
  databaseName: string,
  poolId: string,
): string {
  const url = new URL(templateUri);
  url.pathname = `/${databaseName}_${poolId}`;
  return url.toString();
}
