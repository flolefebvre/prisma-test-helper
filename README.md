# @flolefebvre/prisma-test-helper

An isolated, fast Postgres test database for Prisma + Vitest projects: one throwaway
container per test run, migrations applied once to a Template Database, one Worker
Database cloned per Vitest worker, and every test wrapped in a transaction that is rolled
back.

**Postgres-only.** The harness starts a real Postgres in Docker and relies on
`CREATE DATABASE … TEMPLATE` for cloning; no other database is supported. Tested against
**Prisma 7** and **Vitest 4** on **Node >= 20**.

## What you get

- **No cleanup code.** Each test runs inside a transaction that is rolled back when it
  ends. The Worker Database never changes, so every test starts from the same pristine
  clone — no truncation, no ordering constraints, no leftover rows.
- **Real Postgres.** Not SQLite, not a mock. Your migrations, your constraints, your
  triggers, your `citext` columns.
- **Parallel by default.** One database per Vitest worker slot, so files running in
  parallel cannot see each other's writes.
- **Nothing to tear down.** The container is removed when the run ends, including after a
  crash.

## Requirements

- Node >= 20, ESM project
- Docker (or another container runtime Testcontainers can reach)
- Peer dependencies: `vitest` ^4 and `prisma` ^7, with your migrations committed
  (`prisma migrate deploy` is what the harness runs)

## Install

```sh
pnpm add -D @flolefebvre/prisma-test-helper
# or: npm i -D / yarn add -D / bun add -d
```

## Wiring

Four files. The blocks below are the wiring this repo's own test suite runs — see
`tests/global-setup.ts`, `tests/setup.ts`, `tests/db/client.ts`, and `vitest.config.ts`.

### 1. Your Prisma client module

The harness assumes your app reaches the database through a single module it can
intercept. If you already have one, use it as-is.

```ts
// src/db/client.ts
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
```

Throwing when `DATABASE_URL` is unset is worth keeping. It is the tripwire for the
ordering rule in step 2: if the setup file ever imports your app statically, this throw
fires loudly instead of silently pointing the suite at your dev database.

### 2. Global setup

```ts
// tests/global-setup.ts
import { createGlobalSetup } from "@flolefebvre/prisma-test-helper/global-setup";

export default createGlobalSetup();
```

### 3. Per-worker setup

```ts
// tests/setup.ts
import { vi } from "vitest";

import { installTestTransaction } from "@flolefebvre/prisma-test-helper";
import { setupWorkerDatabase } from "@flolefebvre/prisma-test-helper/setup";

const { databaseUrl, databaseName } = setupWorkerDatabase();

vi.mock("../src/db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client.js")>();
  return { db: installTestTransaction(actual.db, databaseUrl, databaseName) };
});
```

> **This file must keep zero static imports of your app.** ES imports hoist above
> statements, so a static `import { db } from "../src/db/client.js"` would build the
> client _before_ `setupWorkerDatabase()` assigns `DATABASE_URL` — pointing your whole
> suite at your dev database. Reach for app modules through the lazy `vi.mock` factory
> (as above) or a dynamic `import()`. Library imports are safe: they read no environment
> at import time.

### 4. Vitest config

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    // Both are Vitest defaults, set explicitly because the harness depends on them:
    // together they re-run `setupFiles` in a fresh process per test file.
    pool: "forks",
    isolate: true,
  },
});
```

`pool: "forks"` and `isolate: true` are load-bearing. Under `isolate: false` module state
leaks across files, and the `setupDatabase()` opt-in guard relies on its module
re-instantiating per file.

### Writing a test

```ts
// tests/author.test.ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flolefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase();

test("persists an author", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});
```

`setupDatabase()` is the opt-in: call it once, at the top of any file that touches the
database. Files that never call it are untouched by the harness.

## What happens per run

One tuned throwaway Postgres container starts (tmpfs data directory, `fsync=off`). Your
project's `prisma migrate deploy` runs once against the **Template Database**. One
**Worker Database** is cloned per Vitest worker slot (`<databaseName>_1..N`) before any
worker forks. Each worker points `DATABASE_URL` at its own clone. Each test opens a
transaction and rolls it back. The container is removed when the run ends.

## API

### `createGlobalSetup(options?)`

| Option         | Default              | What it does                                                                                                                                       |
| -------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image`        | `postgres:17-alpine` | Postgres image to run. Pin it to the same major as your production database, so a test never runs against a different Postgres than you deploy on. |
| `databaseName` | `prisma_test`        | Name of the Template Database: migrated once per run, then cloned into `<databaseName>_1..N`. It never hosts a test.                               |

The Template Database connection URI is `provide`d to your tests, fully typed:

```ts
import { inject } from "vitest";

const uri = inject("templateDatabaseUri");
```

Typing works only if your global-setup file is part of your TypeScript program — that
file carries the module augmentation that declares these keys. If it sits outside
`tsconfig.json`'s `include`, `inject("templateDatabaseUri")` will not typecheck.

### `setupWorkerDatabase(): { databaseUrl, databaseName }`

Points this worker at its own Worker Database. Call it at the top of your setup file,
above the `vi.mock`. It reads what `createGlobalSetup` provided, rewrites the URI onto
this worker's clone, sets `process.env.DATABASE_URL`, and returns both halves —
`installTestTransaction` needs both.

### `installTestTransaction(client, databaseUrl, databaseName): client`

Wraps your real Prisma client and returns a routing proxy under the same type. Every
importer of your client module receives it, so their queries land in whichever test
transaction is live. Called once per worker, from the `vi.mock` factory.

### `setupDatabase(): void`

Opts a test file into the database. Wraps every test in its own transaction: a
`beforeEach` opens it and runs the reset hooks, an `afterEach` rolls it back.

### `isDatabaseSetUp(): boolean`

Whether `setupDatabase()` has run in this file. Factories read it to fail loudly when a
file forgot to opt in, rather than run outside any transaction — where their writes would
commit.

```ts
if (!isDatabaseSetUp()) {
  throw new Error("call setupDatabase() at the top of this test file");
}
```

### `registerResetHook(hook): void`

Register a callback to run in every `beforeEach`, after the transaction opens. This is the
seam factories plug into. Hooks receive `{ testName, seed }`, where `seed` is a
deterministic 32-bit hash (FNV-1a) of the test name alone — never the worker id, the file,
or the run order. Rerunning one test with `-t` therefore hands it the same seed a
full-suite run did.

Faker is deliberately **not** a dependency of this package; the harness only hands you the
seed.

```ts
// tests/factories.ts
import { faker } from "@faker-js/faker";

import { registerResetHook } from "@flolefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

registerResetHook(({ seed }) => {
  faker.seed(seed);
});

export function buildAuthor() {
  return db.author.create({ data: { name: faker.person.fullName() } });
}
```

Hooks are held in a `Set`, so registering the same function twice runs it once. They run
sequentially, in registration order, and are awaited.

## Rules and caveats

**Per-test cleanup belongs in `afterEach`, registered after `setupDatabase()`.** Vitest
runs `afterEach` hooks in reverse registration order, so one your file registers _after_
that call still runs while the transaction is live. Cleanup registered with
`onTestFinished` does **not**: the runner fires those after every `afterEach`, so they land
past the rollback, where the database is out of reach.

**Call `setupDatabase()` once per file.** A second call in the same file fails with
`a test transaction is already live`, which does not point at the duplicate call.

**Build test data inside tests, not in `beforeAll`.** `beforeAll` runs before any
transaction is open, so writes there would commit to the Worker Database and leak into
every later test. The harness throws rather than let that happen.

## When something is mis-wired

Every error below comes from this package. Find the one you got.

| Error                                                                   | What is mis-wired                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The test suite could not reach a container runtime.`                   | Docker is not running. Start it and run the tests again.                                                                                                |
| ``Could not resolve the `prisma` CLI from <cwd>.``                      | The `prisma` peer dependency is not installed. The harness migrates with your project's own Prisma.                                                     |
| `` `prisma migrate deploy` failed: ``                                   | Your migrations failed to apply. The Postgres output follows the message.                                                                               |
| `cloning the Worker Databases from <name> failed:`                      | `CREATE DATABASE … TEMPLATE` failed — usually another connection to the template, or a Postgres image that does not support the clone.                  |
| `VITEST_POOL_ID is not set —`                                           | `setupWorkerDatabase()` ran outside a Vitest worker. It must run from a file listed in `setupFiles`, with `pool: "forks"` set.                          |
| `No Template Database was provided to this run —`                       | The global setup did not run. Register your global-setup file as `globalSetup: ["tests/global-setup.ts"]`.                                              |
| `refusing to open a test transaction on <name> — only Worker Databases` | The `databaseName` passed to `installTestTransaction` does not match the one `createGlobalSetup` used. Pass the value `setupWorkerDatabase()` returned. |
| `no test transaction is installed —`                                    | Your client module was imported without going through the setup file's `vi.mock`. Check the mock path matches the import path your app uses.            |
| `a test transaction is already live —`                                  | `setupDatabase()` was called twice in one file.                                                                                                         |
| `the database was touched with no test transaction live —`              | The file never called `setupDatabase()`, or data was built in `beforeAll` instead of inside a test.                                                     |

## License

MIT
