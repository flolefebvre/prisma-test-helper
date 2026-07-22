---
name: prisma-test-helper
description: Write Vitest tests against a real Postgres database with @flefebvre/prisma-test-helper. Use when adding or editing a test that touches the database in a project depending on @flefebvre/prisma-test-helper; when a test fails with one of its guard errors ("no test transaction is installed", "the database was touched with no test transaction live", "refusing to open a test transaction on …"); when writing fixture or test-data helpers that plug into its per-test lifecycle; or when the user mentions prisma-test-helper.
---

# prisma-test-helper

`@flefebvre/prisma-test-helper` is the **Harness** for Prisma + Vitest: one throwaway Postgres container per run, migrations applied once to a **Template Database**, one **Worker Database** cloned per Vitest worker slot, and every test wrapped in a **Test Transaction** that is rolled back when it ends.

This skill covers writing tests in a project that is **already wired**. Wiring one from scratch is `prisma-test-helper-setup`.

> This skill documents **v0.1.0**. If the installed version differs, or a snippet here doesn't typecheck, trust the package's `.d.ts` in `node_modules` over this text.

## The shape of a test file

```ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase();

test("persists an author", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});
```

The rollback is the cleanup. The Worker Database never changes, so every test starts from the same pristine clone — no truncation, no ordering constraints, no leftover rows. Files that never call `setupDatabase()` are untouched by the harness.

## Iron rules

1. **Call `setupDatabase()` once, at the top of every database-touching file.** It is the opt-in — a file without it runs outside any transaction, where writes commit. A _second_ call in the same file throws `a test transaction is already live`, an error that never names the duplicate call, so check for an existing one before adding yours.

2. **Build test data inside tests.** `beforeAll` runs before any transaction is open, so writes there would commit to the Worker Database and leak into every later test. The harness throws rather than let that happen. `beforeEach` is fine — it runs inside the transaction.

3. **Per-test cleanup goes in `afterEach`, registered _after_ `setupDatabase()`.** Vitest runs `afterEach` hooks in reverse registration order, so one registered after that call still runs while the transaction is live. `onTestFinished` does **not** work: the runner fires those after every `afterEach`, landing past the rollback, where the database is out of reach.

4. **Leave the harness's Vitest settings alone.** `pool: "forks"` and `isolate: true` are load-bearing — together they re-run `setupFiles` in a fresh process per test file. Under `isolate: false`, module state leaks across files and the `setupDatabase()` opt-in guard misreports a neighbouring file's opt-in. Widening either breaks isolation silently.

5. **Keep the setup file free of static app imports.** ES imports hoist above statements, so a static `import { db } from "../src/db/client.js"` in the setup file builds the client _before_ `setupWorkerDatabase()` assigns `DATABASE_URL` — pointing the whole suite at the dev database. Reach app modules through the lazy `vi.mock` factory or a dynamic `import()`. Library imports are safe; they read no environment at import time.

## Fixtures and test-data helpers

The **Reset Hook** is the seam for wiring your own fixture and test-data libraries into the per-test lifecycle — reseeding a random generator, resetting a counter, priming a registry. Register a callback and it runs in every `beforeEach`, after the Test Transaction opens:

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

In a helper that assumes a live transaction, fail loudly when the calling file forgot to opt in:

```ts
import { isDatabaseSetUp } from "@flefebvre/prisma-test-helper";

if (!isDatabaseSetUp()) {
  throw new Error("call setupDatabase() at the top of this test file");
}
```

## API

| Export                                                      | Where it runs                  | What it does                                                                                                        |
| ----------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `setupDatabase()`                                           | top of a test file             | Opts the file in: a `beforeEach` opens the Test Transaction and runs the reset hooks, an `afterEach` rolls it back. |
| `isDatabaseSetUp()`                                         | anywhere                       | Whether `setupDatabase()` has run in this file.                                                                     |
| `registerResetHook(hook)`                                   | module scope of a fixture file | Runs `hook({ testName, seed })` in every `beforeEach`, after the transaction opens.                                 |
| `setupWorkerDatabase()`                                     | top of the setup file          | Points this worker at its own Worker Database; returns `{ databaseUrl, databaseName }`.                             |
| `installTestTransaction(client, databaseUrl, databaseName)` | the `vi.mock` factory          | Wraps the real client in the **Routing Proxy**, under the same type.                                                |
| `createGlobalSetup(options?)`                               | the global-setup file          | `image` (default `postgres:17-alpine`), `databaseName` (default `prisma_test`).                                     |

The last three are wiring, already in place in a wired project — reach for them only when changing the wiring itself.

### Two wiring traps worth knowing

**The `vi.mock` factory drops every export it doesn't return.** If the client module exports anything beyond the client — types, a re-exported `Prisma` namespace, helpers — spread the original. Without it, every call site that touches one of those exports fails with Vitest's own `No "Prisma" export is defined on the "../src/db/client.js" mock. Did you forget to return it from "vi.mock"?` — the fix is the spread, in the setup file, not in the test that reported it:

```ts
return { ...actual, db: installTestTransaction(actual.db, databaseUrl, databaseName) };
```

**Typed `inject("templateDatabaseUri")` requires the global-setup file to be part of the TypeScript program.** That file carries the module augmentation declaring these keys; if it sits outside `tsconfig.json`'s `include`, the call will not typecheck.

## When something is mis-wired

Every error below comes from this package. Find the one you got.

| Error                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The test suite could not reach a container runtime.`                   | Docker is not running. Start it and run the tests again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ``Could not resolve the `prisma` CLI from <cwd>.``                      | The `prisma` peer dependency is not installed. The harness migrates with the project's own Prisma.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `` `prisma migrate deploy` failed: ``                                   | The migrations failed to apply; Prisma's own output follows. If it reads `The datasource.url property is required in your Prisma config file`, `prisma.config.ts` is missing or lacks a `datasource.url`.                                                                                                                                                                                                                                                                                                                       |
| `cloning the Worker Databases from <name> failed:`                      | `CREATE DATABASE … TEMPLATE` failed — usually another connection to the template, or a Postgres image that does not support the clone.                                                                                                                                                                                                                                                                                                                                                                                          |
| `VITEST_POOL_ID is not set —`                                           | `setupWorkerDatabase()` ran outside a Vitest worker. It must run from a file listed in `setupFiles`, with `pool: "forks"` set.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `No Template Database was provided to this run —`                       | The global setup did not run. Register the global-setup file as `globalSetup: ["tests/global-setup.ts"]`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `refusing to open a test transaction on <name> — only Worker Databases` | The client is pointed at something that is not a Worker Database — **read `<name>` in the message first.** If it is the dev database, the setup file's ordering broke: a static app import ran before `setupWorkerDatabase()` (rule 5). If it is the template, or a near-miss name, the `databaseName` passed to `installTestTransaction` does not match the one `createGlobalSetup` used — pass the value `setupWorkerDatabase()` returned. This guard is the last line stopping a suite from running against a real database. |
| `no test transaction is installed —`                                    | The client module was imported without going through the setup file's `vi.mock` (the **Client Seam**). Check the mock path matches the import path the app uses.                                                                                                                                                                                                                                                                                                                                                                |
| `a test transaction is already live —`                                  | `setupDatabase()` was called twice in one file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `the database was touched with no test transaction live —`              | The file never called `setupDatabase()`, or data was built in `beforeAll` instead of inside a test.                                                                                                                                                                                                                                                                                                                                                                                                                             |
