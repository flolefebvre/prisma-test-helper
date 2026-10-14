# Writing tests

This page covers writing tests in a project that is already wired. Wiring one from
scratch is [Setup](setup.md).

## The shape of a test file

```ts
// tests/author.test.ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase(db);

test("persists an author", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});

test("starts from a clean database: the author above is gone", async () => {
  expect(await db.author.count()).toBe(0);
});
```

The **Reset** is the cleanup. Before a file's first test and after every test, it empties
every table and rewinds every sequence in one statement, so each test starts from an
empty Worker Database with ids back at 1: no truncation of your own, no ordering
constraints, no leftover rows. The one exception is rows your migrations inserted, which
every test starts with: see [Rows your migrations insert](#rows-your-migrations-insert).

### Rows your migrations insert

A table that holds rows once `prisma migrate deploy` has run, such as a lookup table or
roles seeded in a migration, is a **Baseline table**. Global setup snapshots it before
it clones the Worker Databases. Every test starts with those rows:

- **Tests may write Baseline tables.** After a test that inserted, updated, deleted or
  truncated one, the Reset restores it from the snapshot. A test that wrote none pays
  next to nothing; a restore costs about the time it takes to copy that table's rows.
- **Ids continue from the snapshot.** A sequence a Baseline table owns goes back to
  where the migrations left it, so an insert into a lookup table with three migration
  rows gets id 4, in every test and every run order. Sequences of every other table
  restart at their start value, as before.
- **Partitioned Baseline tables are restored after every test**, written or not. A
  write aimed straight at a partition cannot be tracked, so the harness does not try.
- **There is no switch to empty them.** A test that needs a Baseline table empty deletes
  its rows itself. The next Reset restores them.
- Only `_prisma_migrations`, extension-owned tables such as PostGIS's
  `spatial_ref_sys`, and the harness's own schema are left out entirely.

The harness keeps the snapshot in a `prisma_test_helper` schema in every Worker
Database, and tracks writes with a `prisma_test_helper_dirty` trigger on each ordinary
Baseline table. Leave both alone. Your migrations must not create a schema by that name.
Why it works this way, and what it costs:
[ADR 0002](https://github.com/flolefebvre/prisma-test-helper/blob/main/docs/adr/0002-baseline-restore.md).

Import the client the way the rest of the project does. The relative `.js` specifier
above suits an ESM project, while a Next.js or Vite app typically writes an alias
(`import { db } from "@/lib/db"`). Pass `setupDatabase` that same client: the Reset runs
through it.

## Opting a file in

`setupDatabase(db)` is the opt-in. Call it **once, at the top level of every file that
touches the database**, outside any `test` or `describe` block, with your app's client.

- **A file without it gets no Reset between its own tests**: rows from one test are still
  there in the next. The next opted-in file on that worker starts clean anyway. Files
  that never touch the database are free to skip the call.
- **A second call in the same file throws** `setupDatabase() was called twice in this file`.
  Keep the one at the top.

## Where test data belongs

**Build per-test data in the test, in `beforeEach`, or in a factory.** Writes in your own
`beforeAll` are allowed and commit, but they last only until the first test ends: the
Reset after that test removes them like any other row, so the second test does not see
them.

## Hooks and the Reset

**Write no cleanup code.** The Reset does it. If you still need a hook at the end of a
test:

- An `afterEach` your file registers _after_ `setupDatabase(db)` runs **before** the
  Reset (Vitest runs `afterEach` hooks in reverse registration order), so it sees the
  test's rows.
- `onTestFinished` callbacks run **after** the Reset. They may read the (reset) database,
  but rows they write survive into the next test, so keep database writes in
  `afterEach`.

## Finish what a test opens

Await every query, and end every transaction a second client opened, before the test
ends. The Reset waits at most 5 seconds for a lock, then fails the test with
`the Reset could not empty …`: a leaked lock is a loud failure, never a hang.

## Transactions and other connections

Tests commit for real and nothing is wrapped or mocked, so app code needs no special
treatment. A `$transaction` (interactive, batched, nested, or fired concurrently with
`Promise.all`) runs exactly as it does in production: on its own connection, committing
or rolling back for real. A second `PrismaClient`, a queue worker polling a table, or a
deferred constraint sees committed rows the way it would there.

## Fixtures and seeded fake data

Reference data every test needs belongs in a migration: the
[Baseline](#rows-your-migrations-insert) then puts it back for every test. Data a test
builds for itself, through factories, is a different matter.

Test-data factories live in your project, not in the harness. The **Reset Hook** is the
seam for wiring them, and any other fixture library, into the per-test lifecycle:
reseeding a random generator, resetting a counter, priming a registry. Register a
callback with `registerResetHook` and it runs in every `beforeEach`, before the test
body, against a database the previous Reset already returned to its Baseline:

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

Each hook receives `{ testName, seed }`. `seed` is a deterministic 32-bit hash (FNV-1a)
of `testName` alone, never of the worker id, the file, or the run order. Rerunning one
test with `-t` therefore hands it the same seed a full-suite run did, which is what makes
seeded data reproducible in isolation.

No data-generation library is a dependency of this package; the harness only hands you
the seed. Faker above is one example of something that takes a numeric seed. Anything
seedable works the same way, and a hook that resets a plain counter is just as valid a
use of the seam.

Hooks are held in a `Set`, so registering the same function twice runs it once. They run
sequentially, in registration order, and are awaited.

A helper that relies on the per-test Reset should fail loudly when the calling file
forgot to opt in, rather than write rows that no Reset clears between that file's tests:

```ts
import { isDatabaseSetUp } from "@flefebvre/prisma-test-helper";

if (!isDatabaseSetUp()) {
  throw new Error("call setupDatabase(db) at the top of this test file");
}
```

## Leave the wiring alone

Two wiring rules hold for as long as the harness is installed:

- **Keep `pool: "forks"` and `isolate: true`.** Together they re-run `setupFiles` in a
  fresh process per test file. Under `isolate: false`, module state leaks across files
  and the `setupDatabase(db)` opt-in guard misreports a neighbouring file's opt-in.
  Widening either breaks isolation silently. See [Vitest config](setup.md#5-vitest-config).
- **Keep the setup file free of static app imports.** A static app import there builds
  your client before `setupWorkerDatabase()` assigns `DATABASE_URL`, and
  `setupDatabase(db)` then refuses every file. Reach app modules from the setup file with
  a dynamic `import()` only. See [Per-worker setup](setup.md#4-per-worker-setup).

Every export used on this page, with its entry point, is in the [API reference](api.md).
