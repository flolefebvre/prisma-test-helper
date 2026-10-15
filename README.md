# @flefebvre/prisma-test-helper

Fast, isolated Postgres for Prisma + Vitest tests: a real database per worker, a clean
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
  rewound — no truncation of your own, no ordering constraints, no leftover rows. Rows
  your migrations insert, such as lookup tables, are the exception: every test starts
  with them, restored after any test that changed them. So are the rows of the
  reference-data seed you can hand global setup: your project's own seed function, not
  `prisma db seed`.
- **Real commits.** Nothing is wrapped or faked: `$transaction` behaves as in production,
  and a second client, a queue worker, or a deferred constraint sees exactly what it
  would there.
- **Real Postgres.** Not SQLite, not a mock. Your migrations, your constraints, your
  triggers, your `citext` columns.
- **Parallel by default.** One database per Vitest worker slot, so files running in
  parallel cannot see each other's writes.
- **Nothing to tear down.** The container is removed when the run ends, including after a
  crash. In url mode the run drops its databases, and the next run drops those a killed
  run left.

**Postgres-only.** The harness starts a real Postgres in Docker, or uses one you point it
at, and relies on `CREATE DATABASE … TEMPLATE` for cloning; no other database is
supported.

## How it works

One run of your test suite goes through this lifecycle:

1. Vitest's global setup starts one tuned throwaway Postgres container (tmpfs data
   directory, `fsync=off`) through [Testcontainers](https://testcontainers.com/).
2. Your project's own `prisma migrate deploy` runs once against a **Template Database**
   inside that container, followed by your own seed function if you configured one. The
   tables they leave rows in form the **Baseline**, which the harness snapshots there.
3. Before any worker forks, one **Worker Database** per Vitest worker slot is cloned from
   the template (`<databaseName>_1..N`) with `CREATE DATABASE … TEMPLATE` — a fast
   file-level copy.
4. Each worker points `DATABASE_URL` at its own clone. Tests commit to it for real.
5. Before a file's first test, and after every test, the **Reset** empties that clone
   again: one `DO` block, sent through your own Prisma client, that empties every table
   and rewinds every sequence in a single statement — restoring, instead of emptying,
   any Baseline table the test wrote to.
6. The container is removed when the run ends.

Already running Postgres? Pass a [`url`](docs/api.md#the-url-option) and the same
lifecycle runs on that server, under database names unique to the run, with no container.

Migrations run once, clones are cheap, and the Reset is one planned statement — so the
per-test overhead is a few milliseconds (about 7 ms at 73 tables, 10 ms with 20 workers
resetting at once), nearly flat in the size of your schema. Why `DELETE` and not
`TRUNCATE`, with the benchmark behind it:
[ADR 0001](https://github.com/flolefebvre/prisma-test-helper/blob/main/docs/adr/0001-commit-and-reset-instead-of-rollback.md).

## Requirements

- **Node ^22.22, ^24 or >= 26**, as Vitest 5 and Testcontainers require. The package
  ships ESM only, but your project need not be — the wiring runs under Vitest, which
  transforms modules through Vite, so a CommonJS project (a stock Next.js app, say) works
  too.
- **Docker** (or another container runtime Testcontainers can reach), or an existing
  Postgres 13+ server you point the run at with the
  [`url` option](docs/api.md#the-url-option) or `PRISMA_TEST_HELPER_URL`.
- Peer dependencies: **Vitest ^5.0.3** and **Prisma ^7**, with your migrations committed
  (`prisma migrate deploy` is what the harness runs).
- A Postgres superuser for the Reset. The container's user is one, so there is nothing to
  do; in url mode, the URL's role must be one.
- Testcontainers comes with this package; do not add it yourself. Under pnpm, none of
  its build scripts needs approving.

Details for each, including the pnpm `allowBuilds` entries, are in
[Before you start](docs/setup.md#before-you-start).

## Installation

```sh
pnpm add -D @flefebvre/prisma-test-helper
# or: npm i -D / yarn add -D / bun add -d
```

## Quick start

Three wiring files and a test. They assume a `prisma.config.ts` that reads
`DATABASE_URL`, and a Prisma client module built from `DATABASE_URL`:
[Setup](docs/setup.md) walks through all five files, step by step.

```ts
// tests/global-setup.ts
import { createGlobalSetup } from "@flefebvre/prisma-test-helper/global-setup";

export default createGlobalSetup();
```

```ts
// tests/setup.ts: no static imports of your app here
import { setupWorkerDatabase } from "@flefebvre/prisma-test-helper/setup";

setupWorkerDatabase();
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    isolate: true,
  },
});
```

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

`isolate: true` is Vitest's default and the one these docs prescribe: every test file
gets fresh modules. `isolate: false` is supported too. Each worker then keeps your
app's modules and Prisma client across files, while every file still gets its own opt-in
and a clean Worker Database. On a generated 73-table suite with a 300 ms app import, it
cut the run by 46 % at 4 workers and 35 % at 16. The trade-offs: module state and
`vi.mock` calls leak between files on a worker, Reset Hooks registered in a test file
carry over, and schema changes outside migrations go unseen. See
[`isolate: false`](docs/setup.md#isolate-false).

## Documentation

- [Setup](docs/setup.md): the five files, merging into existing configs,
  `isolate: false`, `projects`, path aliases, `server-only`, and a smoke test.
- [Writing tests](docs/writing-tests.md): the `setupDatabase(db)` opt-in, where test
  data belongs, hooks and the Reset, locks, and Reset Hooks for fixtures.
- [API](docs/api.md): every export, its options, and its entry point.
- [Troubleshooting](docs/troubleshooting.md): every error, what is mis-wired, and where
  the fix lives.
- [For AI coding agents](docs/for-agents.md): the rules, setup steps and a by-task guide.
- [Migrating](docs/migrating.md): upgrade notes per major version. The package follows
  semver, so breaking changes land only in major versions.

These pages ship inside the package, so they always match the version you have installed:
`node_modules/@flefebvre/prisma-test-helper/docs/`.

## AI coding agents

Point your agent (Claude Code, Cursor, Codex, …) at
[`docs/for-agents.md`](docs/for-agents.md) by adding one line to your project's
`AGENTS.md`:

```md
Tests that touch the database use @flefebvre/prisma-test-helper: read
node_modules/@flefebvre/prisma-test-helper/docs/for-agents.md first.
```

That page ships with the package, so the agent reads the guidance for the installed
version. An agent asked to wire the harness from scratch adds this line itself as the
last setup step.

## Contributing

Issues and pull requests are welcome —
[open one here](https://github.com/flolefebvre/prisma-test-helper/issues). The package is
dogfooded: this repo's own test suite runs through the exact wiring [Setup](docs/setup.md)
documents.

```sh
git clone https://github.com/flolefebvre/prisma-test-helper.git
cd prisma-test-helper
pnpm install
pnpm run generate             # generate the fixture Prisma client
pnpm test                     # every vitest project (all but unit need Docker)
pnpm run gate                 # typecheck, lint, duplication, tests, build
pnpm run test:url-concurrent  # not in the gate, but in CI: concurrent url-mode runs
```

## License

MIT — see [`LICENSE`](LICENSE).
