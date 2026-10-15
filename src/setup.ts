import { inject } from "vitest";

import { beginFile } from "./opt-in.js";
import { workerDatabaseUrl } from "./worker-database.js";

// The `/setup` entry: what a consumer's Vitest `setupFiles` module imports. It runs
// once per test file, inside the worker, before any app module loads — see the ordering
// note on `setupWorkerDatabase` — under `isolate: false` as under `isolate: true`, which
// makes it where a file's opt-in state starts (./opt-in.ts).

/**
 * What {@link setupWorkerDatabase} hands back. The harness itself reads both through the
 * environment and the provided context, so a setup file may ignore the return value.
 */
export interface WorkerDatabase {
  /** Connection URL of this worker's Worker Database — also set as `DATABASE_URL`. */
  databaseUrl: string;
  /** The Template Database name it was cloned from — the root of the guarded name shape. */
  databaseName: string;
}

/**
 * Point this worker at its own Worker Database.
 *
 * Call it from your Vitest setup file. It reads what `createGlobalSetup` provided,
 * rewrites the URI onto this worker's clone (`<template>_<VITEST_POOL_ID>`), sets
 * `process.env.DATABASE_URL`, and returns both halves — the URL and the template name.
 *
 * **Ordering matters.** The assignment below must happen before any module that reads
 * `DATABASE_URL` at import time is loaded, and ES imports hoist above statements — so
 * the setup file must keep *zero* static imports of your app; reach for app modules
 * with a dynamic `import()` if it ever needs one. A single static app import would
 * build your client against your dev `DATABASE_URL` and point the whole suite — and its
 * Reset — at your dev database; `setupDatabase(db)` would then refuse to run.
 *
 * @example
 * // tests/setup.ts
 * import { setupWorkerDatabase } from "@flefebvre/prisma-test-helper/setup";
 *
 * setupWorkerDatabase();
 */
export function setupWorkerDatabase(): WorkerDatabase {
  // First, before any check can throw: this call is the start of a test file, under
  // `isolate: false` too, where the worker's modules outlive the previous file.
  beginFile();

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
        '`globalSetup: ["tests/global-setup.ts"]`.',
    );
  }

  const databaseUrl = workerDatabaseUrl(templateUri, databaseName, poolId);
  process.env.DATABASE_URL = databaseUrl;
  return { databaseUrl, databaseName };
}
