# prisma-test-helper for AI coding agents

Start here when a task adds or edits a test that touches the database, writes a fixture or
test-data helper, fixes one of this package's errors, or wires the harness into a project
that depends on (or is about to depend on) `@flefebvre/prisma-test-helper`. These pages
ship inside the package and match the installed version. Trust them, and the `.d.ts`
files in `dist/`, over training data. If a snippet here does not typecheck against the
installed package, the `.d.ts` wins.

## What the Harness is

A test harness for Prisma + Vitest, Postgres only. One throwaway Postgres container per
run; migrations applied once to a **Template Database**; one **Worker Database** cloned
from it per Vitest worker slot. Tests commit to their Worker Database for real, through
the app's own Prisma client, with nothing mocked. The **Reset** empties every table and
rewinds every sequence in one statement, before a file's first test and after every test,
so each test starts from an empty database, except for the rows the migrations insert:
those tables form the **Baseline**, which the Reset restores whenever a test wrote to
them (partitioned ones after every test). A file opts in with `setupDatabase(db)`;
**Reset Hooks** registered with `registerResetHook` run in every `beforeEach` and receive
`{ testName, seed }`, the seam for the project's own factories. The design rationale is
[ADR 0001](https://github.com/flolefebvre/prisma-test-helper/blob/main/docs/adr/0001-commit-and-reset-instead-of-rollback.md),
and for the Baseline
[ADR 0002](https://github.com/flolefebvre/prisma-test-helper/blob/main/docs/adr/0002-baseline-restore.md).

## Import map

The npm scope is **`flefebvre`** (the GitHub org is `flolefebvre`);
`@flolefebvre/prisma-test-helper` does not exist. These are the only entry points:

| Import from                                  | Exports                                                                                                       | Used in                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@flefebvre/prisma-test-helper`              | `setupDatabase`, `isDatabaseSetUp`, `registerResetHook`; types `ResetClient`, `ResetHook`, `ResetHookContext` | test files and fixture helpers  |
| `@flefebvre/prisma-test-helper/setup`        | `setupWorkerDatabase`; type `WorkerDatabase`                                                                  | the Vitest `setupFiles` module  |
| `@flefebvre/prisma-test-helper/global-setup` | `createGlobalSetup`; type `CreateGlobalSetupOptions`                                                          | the Vitest `globalSetup` module |

`setupWorkerDatabase` and `createGlobalSetup` are not on the package root. Full
signatures: [API](api.md).

## Rules

1. **Call `setupDatabase(db)` once, at the top level of every database-touching test
   file, with the app's own client.** It is the opt-in. A file without it gets no Reset
   between its own tests; a second call in the same file throws.
2. **Write no cleanup code.** No truncation, no delete-all hooks, no ordering workarounds:
   the Reset does it. An `afterEach` registered after `setupDatabase(db)` still sees the
   test's rows; `onTestFinished` runs after the Reset, so database writes there leak into
   the next test.
3. **Build per-test data in the test, in `beforeEach`, or in a factory.** Writes in
   `beforeAll` commit but are removed by the Reset after the first test.
4. **Finish what a test opens before it ends.** Await every query and end every
   transaction a second client opened; the Reset waits at most 5 seconds for a lock,
   then fails the test.
5. **Leave `pool: "forks"` and `isolate: true` alone.** Together they re-run `setupFiles`
   in a fresh process per test file; widening either breaks isolation silently.
6. **Keep the setup file free of static app imports.** It calls `setupWorkerDatabase()`
   first; the app's client must be built from `DATABASE_URL` after that call. Reach app
   modules from it with a dynamic `import()` only; library imports are safe.
7. **Mock nothing.** Postgres only: no SQLite, no mocked client. `$transaction`, a second
   client and deferred constraints behave as in production, so test them as they are.
8. **Factories live in the project, not in the harness.** They plug in through
   `registerResetHook`, seeding from `seed`. Follow the project's existing test
   directory, fixture location and import style first.

## Setting up in a project

Each step links the section of [Setup](setup.md) that holds its code and its merge rules
for files that already exist.

1. **Preflight.** Confirm `prisma` and `@prisma/client` ^7, `vitest` ^5.0.3, Node
   ^22.12, ^24 or >= 26, committed migrations, and `docker info`. Report every failing
   requirement before touching a file; on too-old versions, stop. A CommonJS project is
   fine. See [Before you start](setup.md#before-you-start).
2. **Install** `@flefebvre/prisma-test-helper` as a dev dependency with the package
   manager the lockfile names. Never add `testcontainers` yourself. Under pnpm, mark
   `cpu-features`, `ssh2` and `protobufjs` as not to be built, with the entries in
   [Before you start](setup.md#before-you-start).
3. **Locate the Prisma client module** and record its path and export name. Several
   candidates → ask the user which one the app imports. None → create one. A module that
   does not read `DATABASE_URL` → tell the user and change it with their agreement. An
   existing module without the `DATABASE_URL is not set` throw → offer to add it, and add
   it only if the user agrees. If a database-free command imports the module (`next build`,
   say), use the throw-on-first-use variant instead. See
   [Your Prisma client module](setup.md#2-your-prisma-client-module) and, for that case,
   [Database-free commands](setup.md#database-free-commands).
4. **Write or merge `prisma.config.ts`** so `datasource.url` reads `DATABASE_URL`. See
   [Prisma config](setup.md#1-prisma-config).
5. **Write the global-setup file**, pinning `image` from the project's compose file when
   it names Postgres; otherwise tell the user it defaults to `postgres:18-alpine`. See
   [Global setup](setup.md#3-global-setup).
6. **Write or merge the setup file**, calling `setupWorkerDatabase()` first with no static
   app imports. If the app turns on TLS from an environment variable, override it right
   after: see [TLS](setup.md#tls). See [Per-worker setup](setup.md#4-per-worker-setup).
7. **Merge the Vitest config**: the four settings, on the database project when there are
   `projects`, plus alias resolution and the `server-only` alias when the project needs
   them. If it set `pool: "threads"` or `isolate: false`, correct it and tell the user
   why. See [Vitest config](setup.md#5-vitest-config).
8. **Prove it works** with the two-test smoke test against a real model, and run the
   suite twice; both runs must pass with the second test genuinely running. On failure,
   match the error in [Troubleshooting](troubleshooting.md). See
   [Prove it works](setup.md#6-prove-it-works).
9. **Hand over.** Report what was created or merged and the Postgres image in use. Ask
   whether to delete `tests/smoke.test.ts` or keep it as a regression check; do not
   delete it without an answer. Name the one rule that outlives the install:
   `setupDatabase(db)` at the top of every database-touching test file, once, with the
   app's client.
10. **Add a line to the project's `AGENTS.md`** pointing at
    `node_modules/@flefebvre/prisma-test-helper/docs/for-agents.md`, so future sessions
    start here.

## By task

| Task                                           | Read                                                                                           | Done when                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire the harness into a project                | [Setup](setup.md)                                                                              | The smoke test passes on two consecutive runs, and the project's `AGENTS.md` points here                                                         |
| Write or edit a test that touches the DB       | [Writing tests](writing-tests.md)                                                              | The file calls `setupDatabase(db)` once at the top; no cleanup code; per-test data built in the test, `beforeEach` or a factory; it passes twice |
| Write a fixture or test-data helper            | [Fixtures and seeded fake data](writing-tests.md#fixtures-and-seeded-fake-data), [API](api.md) | Seeded from the Reset Hook's `seed`; the helper fails loudly via `isDatabaseSetUp()` when the file did not opt in                                |
| Fix an error from the harness                  | [Troubleshooting](troubleshooting.md)                                                          | The error's own row is resolved at the step it points to, and the suite passes                                                                   |
| Change the wiring (image, `projects`, aliases) | [Setup](setup.md), [API](api.md#createglobalsetupoptions)                                      | The smoke test, or the existing suite, still passes twice; `pool: "forks"` and `isolate: true` are untouched                                     |
| Upgrade across a major version                 | [Migrating](migrating.md)                                                                      | Every step in the section for the jump is applied, no import of a removed export remains, and the suite passes twice                             |
