# @flefebvre/prisma-test-helper

Fast, isolated Postgres for Prisma + Vitest tests: a real database per worker, a
rolled-back transaction per test, zero cleanup code.

[![npm version](https://img.shields.io/npm/v/%40flefebvre%2Fprisma-test-helper)](https://www.npmjs.com/package/@flefebvre/prisma-test-helper)
[![CI](https://github.com/flolefebvre/prisma-test-helper/actions/workflows/ci.yml/badge.svg)](https://github.com/flolefebvre/prisma-test-helper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

Testing against a real database usually forces a trade-off. Either you serialize your
suite and truncate tables between tests — slow, and one forgotten cleanup poisons every
test after it — or you swap the database for SQLite or a mock, and stop testing your
actual migrations, constraints, and queries.

This harness removes the trade-off. Each test run gets one throwaway Postgres container;
each Vitest worker gets its own database; each test runs inside a transaction that is
rolled back when it ends. Your tests look like this:

```ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase();

test("persists an author", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});

test("starts from a clean database — the author above is gone", async () => {
  expect(await db.author.count()).toBe(0);
});
```

- **No cleanup code.** Every test starts from the same pristine database — no truncation,
  no ordering constraints, no leftover rows.
- **Real Postgres.** Not SQLite, not a mock. Your migrations, your constraints, your
  triggers, your `citext` columns.
- **Parallel by default.** One database per Vitest worker slot, so files running in
  parallel cannot see each other's writes.
- **Nothing to tear down.** The container is removed when the run ends, including after a
  crash.

**Postgres-only.** The harness starts a real Postgres in Docker and relies on
`CREATE DATABASE … TEMPLATE` for cloning; no other database is supported.

## How it works

One run of your test suite goes through this lifecycle:

1. Vitest's global setup starts one tuned throwaway Postgres container (tmpfs data
   directory, `fsync=off`) through [Testcontainers](https://testcontainers.com/).
2. Your project's own `prisma migrate deploy` runs once against a **Template Database**
   inside that container.
3. Before any worker forks, one **Worker Database** per Vitest worker slot is cloned from
   the template (`<databaseName>_1..N`) with `CREATE DATABASE … TEMPLATE` — a fast
   file-level copy.
4. Each worker points `DATABASE_URL` at its own clone and wraps your Prisma client in a
   routing proxy. Each test opens a transaction, runs inside it, and rolls it back.
5. The container is removed when the run ends.

Migrations run once, clones are cheap, and rollback is instant — so the per-test overhead
is a `BEGIN`/`ROLLBACK` pair, not a container or a truncation pass.

## Requirements

- **Node >= 20.** The package ships ESM only, but your project need not be — the wiring
  runs under Vitest, which transforms modules through Vite, so a CommonJS project (a
  stock Next.js app, say) works too.
- **Docker** (or another container runtime Testcontainers can reach).
- Peer dependencies: **Vitest ^4** and **Prisma ^7**, with your migrations committed
  (`prisma migrate deploy` is what the harness runs).

## Installation

```sh
pnpm add -D @flefebvre/prisma-test-helper
# or: npm i -D / yarn add -D / bun add -d
```

## Setup

Five files. The blocks below are the wiring this repo's own test suite runs — see
`prisma.config.ts`, `tests/global-setup.ts`, `tests/setup.ts`, `tests/db/client.ts`, and
`vitest.config.ts`. If you use an AI coding agent, the
[`prisma-test-helper-setup` skill](#ai-agent-skills) can do all of this for you.

### 1. Prisma config

Prisma 7 reads the datasource URL from `prisma.config.ts`, not from the schema — and
`prisma migrate deploy` **fails without it**. The harness runs your project's own
`migrate deploy` with `DATABASE_URL` pointed at the throwaway container, so read it from
the environment here. The placeholder keeps database-free commands (`prisma generate`)
working.

```ts
// prisma.config.ts
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://unset:unset@localhost:5432/unset",
  },
});
```

### 2. Your Prisma client module

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

The import path follows your own `generator client { output = … }` — adjust it to wherever
your schema emits the client.

Throwing when `DATABASE_URL` is unset is worth keeping. It is the tripwire for the
ordering rule in step 4: if the setup file ever imports your app statically, this throw
fires loudly instead of silently pointing the suite at your dev database.

### 3. Global setup

```ts
// tests/global-setup.ts
import { createGlobalSetup } from "@flefebvre/prisma-test-helper/global-setup";

export default createGlobalSetup();
```

### 4. Per-worker setup

```ts
// tests/setup.ts
import { vi } from "vitest";

import { installTestTransaction } from "@flefebvre/prisma-test-helper";
import { setupWorkerDatabase } from "@flefebvre/prisma-test-helper/setup";

const { databaseUrl, databaseName } = setupWorkerDatabase();

vi.mock("../src/db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client.js")>();
  return { db: installTestTransaction(actual.db, databaseUrl, databaseName) };
});
```

The factory returns `{ db }` because the client module above exports only `db`. If yours
exports anything else — types, a re-exported `Prisma` namespace, helpers — spread the
original too, or every call site touching one of them fails with Vitest's
`No "Prisma" export is defined on the "../src/db/client.js" mock`:

```ts
return { ...actual, db: installTestTransaction(actual.db, databaseUrl, databaseName) };
```

> **This file must keep zero static imports of your app.** ES imports hoist above
> statements, so a static `import { db } from "../src/db/client.js"` would build the
> client _before_ `setupWorkerDatabase()` assigns `DATABASE_URL` — pointing your whole
> suite at your dev database. Reach for app modules through the lazy `vi.mock` factory
> (as above) or a dynamic `import()`. Library imports are safe: they read no environment
> at import time.

### 5. Vitest config

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

## Writing tests

`setupDatabase()` is the opt-in: call it once, at the top of any file that touches the
database. Files that never call it are untouched by the harness.

```ts
// tests/author.test.ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase();

test("persists an author", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});
```

Three rules keep the isolation guarantees intact:

- **Build test data inside tests, not in `beforeAll`.** `beforeAll` runs before any
  transaction is open, so writes there would commit to the Worker Database and leak into
  every later test. The harness throws rather than let that happen.
- **Per-test cleanup belongs in `afterEach`, registered after `setupDatabase()`.** Vitest
  runs `afterEach` hooks in reverse registration order, so one your file registers
  _after_ that call still runs while the transaction is live. Cleanup registered with
  `onTestFinished` does **not**: the runner fires those after every `afterEach`, so they
  land past the rollback, where the database is out of reach.
- **Call `setupDatabase()` once per file.** A second call in the same file fails with
  `a test transaction is already live`, which does not point at the duplicate call.

### Fixtures and seeded fake data

`registerResetHook` is the seam for wiring your own fixture and test-data libraries into
the per-test lifecycle. Hooks run in every `beforeEach` after the transaction opens, and
receive `{ testName, seed }` — `seed` is a deterministic 32-bit hash of the test name
alone, so rerunning one test with `-t` hands it the same seed a full-suite run did.

No data-generation library is a dependency of this package; the harness only hands you
the seed. Below, Faker — but anything that takes a numeric seed works the same way.

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

## API

### `createGlobalSetup(options?)`

Creates the Vitest global setup that owns the container and Template Database. Exported
from `@flefebvre/prisma-test-helper/global-setup`.

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
`installTestTransaction` needs both. Exported from
`@flefebvre/prisma-test-helper/setup`.

### `installTestTransaction(client, databaseUrl, databaseName): client`

Wraps your real Prisma client and returns a routing proxy under the same type. Every
importer of your client module receives it, so their queries land in whichever test
transaction is live. Called once per worker, from the `vi.mock` factory.

### `setupDatabase(): void`

Opts a test file into the database. Wraps every test in its own transaction: a
`beforeEach` opens it and runs the reset hooks, an `afterEach` rolls it back.

### `isDatabaseSetUp(): boolean`

Whether `setupDatabase()` has run in this file. Useful in your own fixture helpers — read
it to fail loudly when a file forgot to opt in, rather than let them run outside any
transaction, where their writes would commit.

```ts
if (!isDatabaseSetUp()) {
  throw new Error("call setupDatabase() at the top of this test file");
}
```

### `registerResetHook(hook): void`

Register a callback to run in every `beforeEach`, after the transaction opens (see
[Fixtures and seeded fake data](#fixtures-and-seeded-fake-data)). Hooks are held in a
`Set`, so registering the same function twice runs it once. They run sequentially, in
registration order, and are awaited.

## Troubleshooting

Every error below comes from this package. Find the one you got.

| Error                                                                   | What is mis-wired                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The test suite could not reach a container runtime.`                   | Docker is not running. Start it and run the tests again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ``Could not resolve the `prisma` CLI from <cwd>.``                      | The `prisma` peer dependency is not installed. The harness migrates with your project's own Prisma.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `` `prisma migrate deploy` failed: ``                                   | Your migrations failed to apply; Prisma's own output follows. If it reads `The datasource.url property is required in your Prisma config file`, you are missing the `prisma.config.ts` from step 1.                                                                                                                                                                                                                                                                                                                                    |
| `cloning the Worker Databases from <name> failed:`                      | `CREATE DATABASE … TEMPLATE` failed — usually another connection to the template, or a Postgres image that does not support the clone.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `VITEST_POOL_ID is not set —`                                           | `setupWorkerDatabase()` ran outside a Vitest worker. It must run from a file listed in `setupFiles`, with `pool: "forks"` set.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `No Template Database was provided to this run —`                       | The global setup did not run. Register your global-setup file as `globalSetup: ["tests/global-setup.ts"]`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `refusing to open a test transaction on <name> — only Worker Databases` | Your client is pointed at something that is not a Worker Database — **check `<name>` in the message first**. If it is your dev database, the setup file's ordering broke: a static app import ran before `setupWorkerDatabase()` (see step 4). If it is the template, or a near-miss name, the `databaseName` passed to `installTestTransaction` does not match the one `createGlobalSetup` used — pass the value `setupWorkerDatabase()` returned. This guard is the last line stopping a suite from running against a real database. |
| `no test transaction is installed —`                                    | Your client module was imported without going through the setup file's `vi.mock`. Check the mock path matches the import path your app uses.                                                                                                                                                                                                                                                                                                                                                                                           |
| `a test transaction is already live —`                                  | `setupDatabase()` was called twice in one file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `the database was touched with no test transaction live —`              | The file never called `setupDatabase()`, or data was built in `beforeAll` instead of inside a test.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## AI agent skills

If you use an AI coding agent (Claude Code, Cursor, Codex, …), this repo ships two installable skills that teach it this harness — split so you keep only what you still need:

| Skill                                                                  | What it does                                                                                                                                                                                                                                                            | Keep it?          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [`prisma-test-helper-setup`](skills/prisma-test-helper-setup/SKILL.md) | Wires the harness into a project: installs the package, finds your Prisma client module, scaffolds the five files above (merging existing configs rather than clobbering them), pins the Postgres image from your `docker-compose.yml`, and verifies with a smoke test. | Remove once wired |
| [`prisma-test-helper`](skills/prisma-test-helper/SKILL.md)             | The rules for writing tests in a wired project: the per-file `setupDatabase()` opt-in, where test data belongs, the Reset Hook seam, and every guard error above with its fix.                                                                                          | Keep installed    |

```sh
# wiring a project for the first time
npx skills add flolefebvre/prisma-test-helper --skill prisma-test-helper-setup

# writing tests in a project that is already wired
npx skills add flolefebvre/prisma-test-helper --skill prisma-test-helper
```

(Uses the [skills CLI](https://github.com/vercel-labs/skills); or just copy the skill directory into your agent's skills directory, e.g. `.claude/skills/`.)

## Contributing

Issues and pull requests are welcome —
[open one here](https://github.com/flolefebvre/prisma-test-helper/issues). The package is
dogfooded: this repo's own test suite runs through the exact wiring documented above.

```sh
git clone https://github.com/flolefebvre/prisma-test-helper.git
cd prisma-test-helper
pnpm install
pnpm run generate      # generate the fixture Prisma client
pnpm test              # unit + integration (integration needs Docker)
pnpm run gate          # everything CI runs: typecheck, lint, duplication, tests, build
```

## License

MIT — see [`LICENSE`](LICENSE).
