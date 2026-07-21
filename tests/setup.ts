import { vi } from "vitest";

import { installTestTransaction } from "../src/index.js";
import { setupWorkerDatabase } from "../src/setup.js";

// The exact setup file the README prescribes to consumers, pointed at the library source
// instead of the package name. Registered as `setupFiles` for the integration project, so
// it re-runs in a fresh fork per test file.
//
// --- Per-worker database -------------------------------------------------------
//
// `tests/global-setup.ts` started one container for the whole run, migrated the Template
// Database and cloned one Worker Database per worker slot before any worker was forked.
// This points `DATABASE_URL` at this worker's clone, `prisma_test_<VITEST_POOL_ID>`.
// Files sharing a worker slot share that database; per-test isolation comes from
// `setupDatabase()`, which wraps every test in a transaction that is rolled back.
//
// This file keeps *zero* static imports of `./db/client.js`: ES imports hoist above
// statements, so one would build the client before the assignment below and throw. Only
// library imports are static here — they read no environment at import time.
const { databaseUrl, databaseName } = setupWorkerDatabase();

// --- The Client Seam -----------------------------------------------------------
//
// Every importer of `./db/client.js` receives the Routing Proxy instead of the raw
// client, so their queries land in whichever Test Transaction is live. The factory is
// lazy — it runs on the first import of the module by a test file, well after the
// assignment above — which is what lets `importOriginal` build the real client against
// this worker's database.
vi.mock("./db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db/client.js")>();
  return { db: installTestTransaction(actual.db, databaseUrl, databaseName) };
});
