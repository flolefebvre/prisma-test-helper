# API

Every export of `@flefebvre/prisma-test-helper`, with the entry point it comes from. The
`.d.ts` files in `dist/` carry the same documentation as doc comments.

## Entry points

| Import from                                  | Exports                                                                                                       | Used in                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@flefebvre/prisma-test-helper`              | `setupDatabase`, `isDatabaseSetUp`, `registerResetHook`; types `ResetClient`, `ResetHook`, `ResetHookContext` | test files and fixture helpers  |
| `@flefebvre/prisma-test-helper/setup`        | `setupWorkerDatabase`; type `WorkerDatabase`                                                                  | the Vitest `setupFiles` module  |
| `@flefebvre/prisma-test-helper/global-setup` | `createGlobalSetup`; type `CreateGlobalSetupOptions`                                                          | the Vitest `globalSetup` module |

Neither `setupWorkerDatabase` nor `createGlobalSetup` is on the package root: import them
from their subpaths. Both are wiring, already in place in a wired project; reach for them
only when changing the wiring itself.

## `setupDatabase(db)`

```ts
function setupDatabase(db: ResetClient): void;
```

Opts a test file into the database. Call it once, at the top level of the file, with the
Prisma client your app uses. It registers:

- a `beforeAll` that runs the Reset once, so the file starts clean whatever an earlier
  file on this worker left behind;
- a `beforeEach` that runs the Reset Hooks;
- an `afterEach` that runs the Reset after every test;
- an `afterAll` that vacuums the tables the file wrote to and every Baseline table, so
  the next file's Resets stay cheap. That `VACUUM` is best effort: it never fails the
  file.

The Reset empties every table but the Baseline tables, the ones your migrations or the
global-setup [`seed`](#the-seed-option) left rows in, which it restores when a test wrote
to them: see
[Rows your migrations insert](writing-tests.md#rows-your-migrations-insert).

It refuses, synchronously and before registering anything, unless `DATABASE_URL` names a
Worker Database (`<databaseName>_<pool id>`). Its `beforeAll` also refuses a client
connected to any other database than that one. Tests commit for real, so a misrouted
suite would otherwise empty a real database. A second call in the same file throws.

`db` is typed structurally as [`ResetClient`](#resetclient), so the package never imports
`@prisma/client` and any generated `PrismaClient` fits, extended or not.

How to use it in a file: [Writing tests](writing-tests.md#opting-a-file-in).

## `isDatabaseSetUp()`

```ts
function isDatabaseSetUp(): boolean;
```

Whether `setupDatabase(db)` has run in this file. Read it in your own fixture helpers to
fail loudly when a file forgot to opt in, rather than let them write rows that no Reset
clears between that file's tests.

```ts
if (!isDatabaseSetUp()) {
  throw new Error("call setupDatabase(db) at the top of this test file");
}
```

## `registerResetHook(hook)`

```ts
function registerResetHook(hook: ResetHook): void;
```

Registers a callback to run in every `beforeEach`, before the test body, against a
database the previous Reset already returned to its Baseline. Call it at module scope of
a fixture file.
Hooks are held in a `Set`, so registering the same function twice runs it once. They run
sequentially, in registration order, and are awaited. See
[Fixtures and seeded fake data](writing-tests.md#fixtures-and-seeded-fake-data).

## `setupWorkerDatabase()`

```ts
function setupWorkerDatabase(): WorkerDatabase;
```

Points this worker at its own Worker Database. Call it from your Vitest setup file. It
reads what `createGlobalSetup` provided, rewrites the URI onto this worker's clone
(`<databaseName>_<VITEST_POOL_ID>`), sets `process.env.DATABASE_URL`, and returns both
halves as a [`WorkerDatabase`](#workerdatabase). The harness reads them itself, so the
setup file may ignore the return value.

The setup file must keep zero static imports of your app: see
[Per-worker setup](setup.md#4-per-worker-setup).

## `createGlobalSetup(options?)`

```ts
function createGlobalSetup(
  options?: CreateGlobalSetupOptions,
): (project: TestProject) => Promise<() => Promise<void>>;
```

Builds the Vitest global setup that owns the container and the Template Database:
`export default createGlobalSetup()` from the file your `globalSetup` config points at. It
runs once per test run, in the main process, before any worker is forked. It starts one
throwaway Postgres, migrates the Template Database with your project's own
`prisma migrate deploy`, runs your `seed` if you gave one, clones one Worker Database per
Vitest worker slot, and removes the container when the run ends.

| Option         | Default              | What it does                                                                                                                                                                                        |
| -------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image`        | `postgres:18-alpine` | Postgres image to run. Pin it to the same major as your production database, so a test never runs against a different Postgres than you deploy on.                                                  |
| `databaseName` | `prisma_test`        | Name of the Template Database: migrated once per run, then cloned into `<databaseName>_1..N`. It never hosts a test.                                                                                |
| `seed`         | none                 | Your project's own seed function, run once per run on the Template Database, after migrate and before cloning. Every table it fills is a Baseline table: see [The `seed` option](#the-seed-option). |

### The `seed` option

```ts
seed?: (databaseUrl: string) => void | Promise<void>;
```

Feeds the [Baseline](writing-tests.md#rows-your-migrations-insert) with the reference data
your project already seeds outside tests: plans, roles, countries. The harness calls it
once per run, in the main process, after `prisma migrate deploy` and before the Baseline
snapshot and the cloning of Worker Databases. `databaseUrl` is the connection URI of the
Template Database. Build your own client from it, call the same function your real seed
calls, and disconnect:

```ts
// tests/global-setup.ts
import { PrismaPg } from "@prisma/adapter-pg";

import { createGlobalSetup } from "@flefebvre/prisma-test-helper/global-setup";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { seedReferenceData } from "../prisma/seed-reference-data.js";

export default createGlobalSetup({
  seed: async (databaseUrl) => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    try {
      await seedReferenceData(db); // the same function your real seed calls
    } finally {
      await db.$disconnect();
    }
  },
});
```

- **Every table the seed fills is a Baseline table.** Its rows are there at the start of
  every test and restored after any test that writes them, and its ids continue from the
  seed's last row.
- **Disconnect before returning.** The template cannot be cloned while anything is
  connected to it. If a session is still connected about two seconds after the seed
  returns, the run fails with `the seed left a connection open to the Template Database`.
- **Do not import your app's client module here.** This file runs in the main process,
  before any worker has a `DATABASE_URL`; a client module that reads it at import time
  throws, or points at your dev database.
- **A seed that throws fails the run** with `the seed failed:` and your error as `cause`.
  The container is stopped. The seed's output is not captured.
- **Seed reference data, not demo data.** The harness does not run `prisma db seed`. A
  seed that also creates demo rows, such as an admin user, makes their tables Baseline
  tables too, and every test that writes one of them pays that table's restore. Call your
  full seed script from this function only if every test should start with those rows.

This `seed` is unrelated to the Reset Hook's `seed`, the per-test number a
[Reset Hook](#registerresethookhook) receives.

### Typed `inject`

The global setup `provide`s two values to your tests, fully typed:

```ts
import { inject } from "vitest";

const uri = inject("templateDatabaseUri"); // connection URI of the Template Database
const name = inject("templateDatabaseName"); // the Template Database's name
```

Typing works only if your global-setup file is part of your TypeScript program: that file
carries the module augmentation that declares these keys. If it sits outside
`tsconfig.json`'s `include`, `inject("templateDatabaseUri")` does not typecheck.

## Types

### `ResetClient`

```ts
interface ResetClient {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}
```

The slice of a Prisma client the Reset drives. Any generated `PrismaClient` is
assignable.

### `ResetHook`

```ts
type ResetHook = (context: ResetHookContext) => void | Promise<void>;
```

A callback registered with `registerResetHook`. May be async; it is awaited.

### `ResetHookContext`

```ts
interface ResetHookContext {
  testName: string;
  seed: number;
}
```

What every Reset Hook receives. `testName` is Vitest's name for the running test,
`describe` blocks included. `seed` is a deterministic 32-bit hash of `testName` alone,
so rerunning one test with `-t` hands it the same seed a full-suite run did.

### `WorkerDatabase`

```ts
interface WorkerDatabase {
  databaseUrl: string;
  databaseName: string;
}
```

What `setupWorkerDatabase()` returns. `databaseUrl` is the connection URL of this worker's
Worker Database, also set as `DATABASE_URL`; `databaseName` is the Template Database name
it was cloned from.

### `CreateGlobalSetupOptions`

```ts
interface CreateGlobalSetupOptions {
  image?: string;
  databaseName?: string;
  seed?: (databaseUrl: string) => void | Promise<void>;
}
```

The options of [`createGlobalSetup`](#createglobalsetupoptions).
