---
name: prisma-test-helper
description: Write Vitest tests against a real Postgres database with @flefebvre/prisma-test-helper. Use when adding or editing a test that touches the database in a project depending on @flefebvre/prisma-test-helper; when a test fails with one of its guard errors ("refusing to reset …", "the client passed to setupDatabase() is connected to …", "setupDatabase() was called twice in this file", "the Reset could not empty …"); when writing fixture or test-data helpers that plug into its per-test lifecycle; or when the user mentions prisma-test-helper in a project that already depends on it.
---

# prisma-test-helper

`@flefebvre/prisma-test-helper` is the **Harness** for Prisma + Vitest: one throwaway Postgres container per run, migrations applied once to a **Template Database**, one **Worker Database** cloned per Vitest worker slot. Tests commit to it for real, and the **Reset** empties it again before a file's first test and after every test.

This skill covers writing tests in a project that is **already wired**. Wiring one from scratch is `prisma-test-helper-setup`.

> This skill documents the commit-and-reset harness. If a snippet here doesn't typecheck against the installed version, trust the package's `.d.ts` in `node_modules` over this text.

## The shape of a test file

```ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase(db);

test("persists an author", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});
```

The Reset is the cleanup. It empties every table and rewinds every sequence in one statement, so each test starts from an empty Worker Database with ids back at 1 — no truncation of your own, no ordering constraints, no leftover rows. Files that never call `setupDatabase(db)` register no hooks and are free to skip the database entirely.

Import the client the way the rest of the project does — the relative `.js` specifier above suits an ESM project, while a Next.js or Vite app typically writes an alias (`import { db } from "@/lib/db"`). Pass `setupDatabase` that same client: the Reset runs through it.

## Iron rules

1. **Call `setupDatabase(db)` once, at the top of every database-touching file, with the app's client.** It is the opt-in. A file without it gets no Reset between its own tests — rows from one test are still there in the next — though the next opted-in file on that worker starts clean anyway. A _second_ call in the same file throws `setupDatabase() was called twice in this file`.

2. **Build per-test data in the test, in `beforeEach`, or in a factory.** Writes in a `beforeAll` are allowed and commit, but they last only until the first test ends: that test's Reset removes them like any other row, so the second test does not see them.

3. **Write no cleanup code.** The Reset does it. An `afterEach` registered _after_ `setupDatabase(db)` still runs before the Reset (Vitest runs `afterEach` hooks in reverse registration order), so it sees the test's rows; `onTestFinished` callbacks run after the Reset: they may read the (empty) database, but rows they write survive into the next test, so keep database writes in `afterEach`.

4. **Finish what a test opens before it ends.** Await every query, and end every transaction a second client opened. The Reset waits at most 5 seconds for a lock, then fails the test with `the Reset could not empty …` — a leaked lock is loud, never a hang.

5. **Leave the harness's Vitest settings alone.** `pool: "forks"` and `isolate: true` are load-bearing — together they re-run `setupFiles` in a fresh process per test file. Under `isolate: false`, module state leaks across files and the `setupDatabase(db)` opt-in guard misreports a neighbouring file's opt-in. Widening either breaks isolation silently.

6. **Keep the setup file free of static app imports.** ES imports hoist above statements, so a static `import { db } from "../src/db/client.js"` in the setup file builds the client _before_ `setupWorkerDatabase()` assigns `DATABASE_URL` — pointing it at the dev database. `setupDatabase(db)` then refuses every file. Reach app modules from the setup file with a dynamic `import()` only. Library imports are safe; they read no environment at import time.

Because tests commit for real, app code needs no special treatment: `$transaction` — interactive, batched, nested, concurrent — behaves exactly as in production, and a second `PrismaClient`, a queue worker, or a deferred constraint sees committed rows the way it would there.

## Fixtures and test-data helpers

The **Reset Hook** is the seam for wiring your own fixture and test-data libraries into the per-test lifecycle — reseeding a random generator, resetting a counter, priming a registry. Register a callback and it runs in every `beforeEach`, against a database the previous Reset already emptied:

```ts
// tests/fixtures.ts
import { faker } from "@faker-js/faker";

import { registerResetHook } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

registerResetHook(({ seed }) => {
  faker.seed(seed);
});

export function createAuthor() {
  return db.author.create({ data: { name: faker.person.fullName() } });
}
```

`seed` is a deterministic 32-bit hash (FNV-1a) of `testName` alone — never the worker id, the file, or the run order. Rerunning one test with `-t` therefore hands it the same seed a full-suite run did, which is what makes seeded data reproducible in isolation.

No data-generation library is a dependency of this package. Faker above is one example of something that takes a numeric seed; anything seedable works the same way, and a hook that resets a plain counter is just as valid a use of the seam.

Hooks are held in a `Set`, so registering the same function twice runs it once. They run sequentially, in registration order, and are awaited.

In a helper that relies on the per-test Reset, fail loudly when the calling file forgot to opt in:

```ts
import { isDatabaseSetUp } from "@flefebvre/prisma-test-helper";

if (!isDatabaseSetUp()) {
  throw new Error("call setupDatabase(db) at the top of this test file");
}
```

## API

| Export                        | Where it runs                  | What it does                                                                                                                                       |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setupDatabase(db)`           | top of a test file             | Opts the file in: a `beforeAll` and an `afterEach` run the Reset through `db`, a `beforeEach` runs the reset hooks. Refuses a non-Worker Database. |
| `isDatabaseSetUp()`           | anywhere                       | Whether `setupDatabase(db)` has run in this file.                                                                                                  |
| `registerResetHook(hook)`     | module scope of a fixture file | Runs `hook({ testName, seed })` in every `beforeEach`.                                                                                             |
| `setupWorkerDatabase()`       | the setup file                 | Points this worker at its own Worker Database by setting `DATABASE_URL`; returns `{ databaseUrl, databaseName }`.                                  |
| `createGlobalSetup(options?)` | the global-setup file          | `image` (default `postgres:17-alpine`), `databaseName` (default `prisma_test`).                                                                    |

The first three import from `@flefebvre/prisma-test-helper`. The last two are wiring, already in place in a wired project — reach for them only when changing the wiring itself, and mind their subpaths: `setupWorkerDatabase` comes from `@flefebvre/prisma-test-helper/setup` and `createGlobalSetup` from `@flefebvre/prisma-test-helper/global-setup`; neither is on the package root.

`setupDatabase` types its argument structurally — anything with `$queryRawUnsafe` and `$executeRawUnsafe`, exported as the `ResetClient` type — so any generated `PrismaClient` fits, extended or not.

**Typed `inject("templateDatabaseUri")` requires the global-setup file to be part of the TypeScript program.** That file carries the module augmentation declaring these keys; if it sits outside `tsconfig.json`'s `include`, the call will not typecheck.

## When something is mis-wired

Every error below comes from this package. Find the one you got.

| Error                                                                 | Fix                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The test suite could not reach a container runtime.`                 | Docker is not running. Start it and run the tests again.                                                                                                                                                                                                                                                                                                               |
| ``Could not resolve the `prisma` CLI from <cwd>.``                    | The `prisma` peer dependency is not installed. The harness migrates with the project's own Prisma.                                                                                                                                                                                                                                                                     |
| `` `prisma migrate deploy` failed: ``                                 | The migrations failed to apply; Prisma's own output follows. If it reads `The datasource.url property is required in your Prisma config file`, `prisma.config.ts` is missing or lacks a `datasource.url`.                                                                                                                                                              |
| `cloning the Worker Databases from <name> failed:`                    | `CREATE DATABASE … TEMPLATE` failed — usually another connection to the template, or a Postgres image that does not support the clone.                                                                                                                                                                                                                                 |
| `VITEST_POOL_ID is not set —`                                         | `setupWorkerDatabase()` ran outside a Vitest worker. It must run from a file listed in `setupFiles`, with `pool: "forks"` set.                                                                                                                                                                                                                                         |
| `No Template Database was provided to this run —`                     | The global setup did not run. Register the global-setup file as `globalSetup: ["tests/global-setup.ts"]`.                                                                                                                                                                                                                                                              |
| `refusing to reset <name> — only Worker Databases`                    | `DATABASE_URL` does not name a Worker Database when `setupDatabase(db)` runs — **read `<name>` in the message first.** Usually the setup file is missing from `setupFiles`, so `DATABASE_URL` is still the dev one; otherwise something reassigned it after `setupWorkerDatabase()` ran. This guard is the last line stopping the Reset from emptying a real database. |
| `refusing to reset — no Worker Database is configured for this file.` | `DATABASE_URL` is unset, or the global setup provided no Template Database: register the setup file in `setupFiles` and the global-setup file in `globalSetup`.                                                                                                                                                                                                        |
| `the client passed to setupDatabase() is connected to <name>, but`    | The client is not on this worker's database. Either the setup file imports the app statically, so the client was built before `DATABASE_URL` was assigned (rule 6), or the client module reads another variable or a hard-coded URL — build it from `DATABASE_URL`.                                                                                                    |
| `setupDatabase() was called twice in this file`                       | Remove one of the calls; keep the one at the top of the file.                                                                                                                                                                                                                                                                                                          |
| `the Reset could not empty <name>:`                                   | Postgres's own message follows. If it is a lock timeout, a connection the test opened still holds a lock — an un-awaited query, or a transaction a second client never ended (rule 4).                                                                                                                                                                                 |
