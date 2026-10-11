import { setupWorkerDatabase } from "../src/setup.js";

// The exact setup file the README prescribes to consumers, pointed at the library source
// instead of the package name. Registered as `setupFiles` for the integration project, so
// it re-runs in a fresh fork per test file.
//
// `tests/global-setup.ts` started one container for the whole run, migrated the Template
// Database and cloned one Worker Database per worker slot before any worker was forked.
// This points `DATABASE_URL` at this worker's clone, `prisma_test_<VITEST_POOL_ID>`.
// Files sharing a worker slot share that database, one file at a time; per-test
// isolation comes from `setupDatabase(db)`, whose Reset empties it around every test.
//
// This file keeps *zero* static imports of `./db/client.js`: ES imports hoist above
// statements, so one would build the client before the assignment below and throw. Only
// library imports are static here — they read no environment at import time.
setupWorkerDatabase();
