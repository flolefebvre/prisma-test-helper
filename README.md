# @flefebvre/prisma-test-helper

Fast, isolated Postgres for Prisma + Vitest tests: a real database per worker, an empty
database for every test, zero cleanup code.

[![npm version](https://img.shields.io/npm/v/%40flefebvre%2Fprisma-test-helper)](https://www.npmjs.com/package/@flefebvre/prisma-test-helper)
[![CI](https://github.com/flolefebvre/prisma-test-helper/actions/workflows/ci.yml/badge.svg)](https://github.com/flolefebvre/prisma-test-helper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

Testing against a real database usually forces a trade-off. Either you serialize your
suite and truncate tables between tests — slow, and one forgotten cleanup poisons every
test after it — or you swap the database for SQLite or a mock, and stop testing your
actual migrations, constraints, and queries.

This harness removes the trade-off. Each test run gets one throwaway Postgres container;
each Vitest worker gets its own database; tests commit for real, and after every test the
harness empties that database again in one batched statement. Your tests look like this:

```ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase(db);

test("persists an author", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});

test("starts from a clean database — the author above is gone", async () => {
  expect(await db.author.count()).toBe(0);
});
```

- **No cleanup code.** Every test starts from an empty database with its sequences
  rewound — no truncation of your own, no ordering constraints, no leftover rows.
- **Real commits.** Nothing is wrapped or faked: `$transaction` behaves as in production,
  and a second client, a queue worker, or a deferred constraint sees exactly what it
  would there.
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
4. Each worker points `DATABASE_URL` at its own clone. Tests commit to it for real.
5. Before a file's first test, and after every test, the **Reset** empties that clone
   again: one `DO` block, sent through your own Prisma client, that empties every table
   and rewinds every sequence in a single statement.
6. The container is removed when the run ends.

Migrations run once, clones are cheap, and the Reset is one planned statement — so the
per-test overhead is a few milliseconds (about 5 ms at 73 tables, 9 ms with 20 workers
resetting at once), nearly flat in the size of your schema. Why `DELETE` and not
`TRUNCATE`, with the benchmark behind it:
[ADR 0001](docs/adr/0001-commit-and-reset-instead-of-rollback.md).

## Requirements

- **Node ^22.12, ^24 or >= 26**, as Vitest 5 requires. The package ships ESM only, but
  your project need not be — the wiring runs under Vitest, which transforms modules
  through Vite, so a CommonJS project (a stock Next.js app, say) works too.
- **Docker** (or another container runtime Testcontainers can reach).
- Peer dependencies: **Vitest ^5.0.3** and **Prisma ^7**, with your migrations committed
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

Your tests hand the harness the same Prisma client your app uses, so it needs to live in
one module. If you already have one, use it as-is.

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

Build the client from `DATABASE_URL`: that is the variable the harness points at this
worker's database. Throwing when it is unset is worth keeping. It is the tripwire for the
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
import { setupWorkerDatabase } from "@flefebvre/prisma-test-helper/setup";

setupWorkerDatabase();
```

> **This file must keep zero static imports of your app.** ES imports hoist above
> statements, so a static `import { db } from "../src/db/client.js"` would build the
> client _before_ `setupWorkerDatabase()` assigns `DATABASE_URL` — pointing it at your dev
> database. `setupDatabase(db)` refuses to reset a client connected anywhere but this
> worker's database, so the mistake fails loudly, but it fails every file. If the setup
> file ever needs an app module, reach for it with a dynamic `import()`. Library imports
> are safe: they read no environment at import time.

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
leaks across files, and the `setupDatabase(db)` opt-in guard relies on its module
re-instantiating per file.

If you split your config into `projects`, put these four settings on the project that runs
database tests, not at the root: inline projects inherit the root's `setupFiles`, so every
project would load `tests/setup.ts`.

## Writing tests

`setupDatabase(db)` is the opt-in: call it once, at the top of any file that touches the
database, with the client your app uses. Files that never call it are untouched by the
harness.

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
```

What to know when writing them:

- **Build per-test data in the test, in `beforeEach`, or in a factory.** Writes in your
  own `beforeAll` are allowed, but they last only until the first test ends: the Reset
  after that test removes them like any other row.
- **No cleanup code.** An `afterEach` your file registers _after_ `setupDatabase(db)` still
  runs before the Reset (Vitest runs `afterEach` hooks in reverse registration order),
  so it sees the test's rows. `onTestFinished` callbacks run after the Reset: they may
  read the (empty) database, but rows they write survive into the next test, so keep
  database writes in `afterEach`.
- **Finish what you open before the test ends.** Await every query, and end every
  transaction a second client opened. The Reset waits at most 5 seconds for a lock
  before failing the test, so a leaked lock is a loud failure, not a hang.
- **Call `setupDatabase(db)` once per file.** A second call fails with
  `setupDatabase() was called twice in this file`.

App code that opens its own `$transaction` — interactive, batched, nested, or fired
concurrently with `Promise.all` — runs exactly as it does in production: on its own
connection, committing or rolling back for real. A second `PrismaClient`, a queue worker
polling a table, or a deferred constraint sees committed rows the way it would there.

### Fixtures and seeded fake data

`registerResetHook` is the seam for wiring your own fixture and test-data libraries into
the per-test lifecycle. Hooks run in every `beforeEach`, against a database the previous
Reset already emptied, and receive `{ testName, seed }` — `seed` is a deterministic 32-bit hash of the test name
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

Points this worker at its own Worker Database. Call it from your setup file. It reads what
`createGlobalSetup` provided, rewrites the URI onto this worker's clone, sets
`process.env.DATABASE_URL`, and returns both halves for your own use — the harness reads
them itself. Exported from `@flefebvre/prisma-test-helper/setup`.

### `setupDatabase(db): void`

Opts a test file into the database. `db` is your Prisma client — typed structurally as
anything with `$queryRawUnsafe` and `$executeRawUnsafe` (the `ResetClient` type), so the
package never imports `@prisma/client`. Registers a `beforeAll` that runs the Reset once,
a `beforeEach` that runs the Reset Hooks, and an `afterEach` that runs the Reset after
every test.

It refuses, before registering anything, unless `DATABASE_URL` names a Worker Database
(`<databaseName>_<pool id>`), and its `beforeAll` refuses a client connected to any other
database than that one. With real commits, a misrouted suite would otherwise empty a real
database.

### `isDatabaseSetUp(): boolean`

Whether `setupDatabase(db)` has run in this file. Useful in your own fixture helpers — read
it to fail loudly when a file forgot to opt in, rather than let them write rows that no
Reset clears between that file's tests.

```ts
if (!isDatabaseSetUp()) {
  throw new Error("call setupDatabase(db) at the top of this test file");
}
```

### `registerResetHook(hook): void`

Register a callback to run in every `beforeEach`, before the test body (see
[Fixtures and seeded fake data](#fixtures-and-seeded-fake-data)). Hooks are held in a
`Set`, so registering the same function twice runs it once. They run sequentially, in
registration order, and are awaited.

## Troubleshooting

Every error below comes from this package. Find the one you got.

| Error                                                                 | What is mis-wired                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The test suite could not reach a container runtime.`                 | Docker is not running. Start it and run the tests again.                                                                                                                                                                                                                                                                                                                      |
| ``Could not resolve the `prisma` CLI from <cwd>.``                    | The `prisma` peer dependency is not installed. The harness migrates with your project's own Prisma.                                                                                                                                                                                                                                                                           |
| `` `prisma migrate deploy` failed: ``                                 | Your migrations failed to apply; Prisma's own output follows. If it reads `The datasource.url property is required in your Prisma config file`, you are missing the `prisma.config.ts` from step 1.                                                                                                                                                                           |
| `cloning the Worker Databases from <name> failed:`                    | `CREATE DATABASE … TEMPLATE` failed — usually another connection to the template, or a Postgres image that does not support the clone.                                                                                                                                                                                                                                        |
| `VITEST_POOL_ID is not set —`                                         | `setupWorkerDatabase()` ran outside a Vitest worker. It must run from a file listed in `setupFiles`, with `pool: "forks"` set.                                                                                                                                                                                                                                                |
| `No Template Database was provided to this run —`                     | The global setup did not run. Register your global-setup file as `globalSetup: ["tests/global-setup.ts"]`.                                                                                                                                                                                                                                                                    |
| `refusing to reset <name> — only Worker Databases`                    | `DATABASE_URL` does not name a Worker Database when `setupDatabase(db)` runs — **check `<name>` in the message first**. Usually the setup file is not registered in `setupFiles`, so `DATABASE_URL` is still your dev one; otherwise something reassigned it after `setupWorkerDatabase()` ran. This guard is the last line stopping the Reset from emptying a real database. |
| `refusing to reset — no Worker Database is configured for this file.` | `DATABASE_URL` is unset, or the global setup provided no Template Database: register the setup file in `setupFiles` and the global-setup file in `globalSetup`.                                                                                                                                                                                                               |
| `the client passed to setupDatabase() is connected to <name>, but`    | The client you passed is not on this worker's database. Either the setup file imports your app statically, so the client was built before `DATABASE_URL` was assigned (see step 4), or your client module reads a different variable or a hard-coded URL — build it from `DATABASE_URL`.                                                                                      |
| `setupDatabase() was called twice in this file`                       | Remove one of the calls; keep the one at the top of the file.                                                                                                                                                                                                                                                                                                                 |
| `the Reset could not empty <name>:`                                   | Postgres's own message follows. If it is a lock timeout, a connection the test opened still holds a lock — an un-awaited query, or a transaction a second client never ended. Finish both before the test ends.                                                                                                                                                               |

## AI agent skills

If you use an AI coding agent (Claude Code, Cursor, Codex, …), this repo ships two installable skills that teach it this harness — split so you keep only what you still need:

| Skill                                                                  | What it does                                                                                                                                                                                                                                                            | Keep it?          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [`prisma-test-helper-setup`](skills/prisma-test-helper-setup/SKILL.md) | Wires the harness into a project: installs the package, finds your Prisma client module, scaffolds the five files above (merging existing configs rather than clobbering them), pins the Postgres image from your `docker-compose.yml`, and verifies with a smoke test. | Remove once wired |
| [`prisma-test-helper`](skills/prisma-test-helper/SKILL.md)             | The rules for writing tests in a wired project: the per-file `setupDatabase(db)` opt-in, where test data belongs, the Reset Hook seam, and every guard error above with its fix.                                                                                        | Keep installed    |

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
