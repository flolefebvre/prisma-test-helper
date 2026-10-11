# 0001 — Commit and reset instead of rollback

- **Status:** accepted
- **Date:** 2026-10-10

## Context

Up to 0.3.0 the harness isolated tests by parking one interactive Prisma transaction per
test (the _Test Transaction_) and rolling it back afterwards. A rollback is the cheapest
reset there is, but reaching it took a lot of machinery, and that machinery leaked into
every consumer:

- **A Routing Proxy around the consumer's client.** App code calls `db.user.create`, not
  `tx.user.create`, so a proxy had to send every model delegate and raw query into the
  live transaction at call time.
- **A `vi.mock` Client Seam in the consumer's setup file**, so that every importer of
  their client module received the proxy. The mock path had to match the app's import
  specifier exactly, and the factory had to spread every other export the module had.
- **Savepoint emulation of `$transaction`.** Nested, batched and concurrent
  `$transaction` calls all became savepoints on one connection. That needed a scope queue
  to stop concurrent siblings interleaving their savepoints (issue #13, fixed in 0.3.0),
  and it still changed semantics: transactions that would run in parallel in production
  ran one after another.
- **Rules consumers had to learn.** No writes in `beforeAll` (no transaction was open
  yet), no database access from `onTestFinished` (it ran after the rollback), and three
  guard errors that existed only to explain the proxy.
- **Things a rollback cannot express.** A second `PrismaClient`, a queue worker on its own
  connection, or a deferred constraint never sees uncommitted rows, so tests of those
  paths could not be written.

## Decision

Tests commit for real against their Worker Database, and the harness returns that
database to empty around them with the **Reset**:

- `setupDatabase(db)` takes the consumer's own Prisma client, typed structurally as
  anything exposing `$queryRawUnsafe` and `$executeRawUnsafe`. The Reset runs through
  that client, so the package needs no database driver and the statement goes over the
  connection pool the tests already use.
- The Reset runs once in `beforeAll`, so a file starts clean whatever an earlier file on
  the worker left behind, and once in `afterEach`. Reset Hooks still run in `beforeEach`
  with the same `{ testName, seed }` contract.
- The Reset is a single PL/pgSQL `DO` block, sent in one round trip. A catalog discovery
  query builds it once per file. The block:
  - sets `session_replication_role = replica` locally, so foreign-key triggers do not
    fire (the container user is a superuser);
  - sets a 5-second `lock_timeout` locally, so a lock a test leaves behind fails the
    test loudly instead of hanging it;
  - probes each table with `EXISTS` and runs `DELETE FROM` only on tables that hold rows;
  - rewinds every column-owned sequence that `nextval` has moved since the last Reset
    (`pg_sequences.last_value IS NOT NULL`) to its own `start_value`, using
    `setval(…, false)`.
- Discovery covers every ordinary and partitioned table in every non-system schema. It
  leaves out `_prisma_migrations`, partitions (deleting from their parent reaches them),
  temporary tables, and extension-owned tables such as PostGIS's `spatial_ref_sys`.
  Standalone sequences that no column owns are left alone.
- The Worker Database guard stays, and becomes more important. With real commits, a
  misrouted suite would empty a dev database rather than just lock it. So `setupDatabase`
  refuses, before registering any hook, unless `DATABASE_URL` names
  `<template>_<digits>`. Before the first Reset it also checks that the client's own
  `current_database()` is that same database.

The Routing Proxy, the Client Seam, `installTestTransaction` and its types are deleted,
not deprecated.

## Alternatives considered

Medians per test, measured on a container tuned like the harness's own (tmpfs data
directory, `fsync=off`), against a 50-table schema with foreign keys and indexes. A
"test" writes 5 rows into each of 5 tables. Scripts: [`0001-bench/`](0001-bench/).

| Strategy                                                       | 50 tables       | 150 tables   |
| -------------------------------------------------------------- | --------------- | ------------ |
| `ROLLBACK` alone                                               | 0.7 ms          | not measured |
| Whole test under rollback (`BEGIN`, 25 inserts, `ROLLBACK`)    | 3.0 ms          | not measured |
| `TRUNCATE` every table `RESTART IDENTITY`                      | 125 ms          | 457 ms       |
| Batched `DELETE` of every table + `setval`                     | 3–6 ms          | flat         |
| One `DO` block: probe, delete only non-empty tables (shipped)  | 5.7 ms          | 4.6 ms       |
| Sequence reset: `ALTER SEQUENCE … RESTART` ×50 versus `setval` | 24 ms vs 3.5 ms | not measured |
| Seeded-baseline restore, 20 / 200 / 2000 rows per table        | 7 / 19 / 91 ms  | not measured |

- **Keep rollback.** It is the fastest reset, but it carries every cost listed under
  Context. The 2–3 ms it saves per test does not pay for a proxy, a module mock and
  emulated transactions.
- **`TRUNCATE`.** It takes `ACCESS EXCLUSIVE` on every table and allocates new relation
  files for each one, so its cost grows with the schema: 125 ms per test at 50 tables,
  457 ms at 150. That is two orders of magnitude worse than `DELETE`.
- **Re-clone the Worker Database per test.** `CREATE DATABASE … TEMPLATE` refuses to run
  while the database has other connections. Every client would have to disconnect and
  reconnect around every test, and a file-level copy per test costs far more than
  deleting a few rows.
- **Batched `DELETE` (chosen).** `DELETE` on an empty table is nearly free, so probing
  first makes the cost follow what the test wrote rather than the size of the schema.
  Sending everything in one `DO` block keeps it to one round trip. Sequences reset with
  `setval`, because `ALTER SEQUENCE … RESTART` costs about 7 times as much.

## Consequences

- **Per-test cost goes up by a few milliseconds:** roughly 3–6 ms instead of under 1 ms,
  and flat as the schema grows.
- **Real commits unlock new tests.** Second connections, queue workers polling a table,
  deferred constraints, and `$transaction` in every form now behave exactly as in
  production, with no special rules.
- **`beforeAll` writes are legal but short-lived.** They commit, and the Reset after the
  file's first test removes them. Shared per-test data belongs in the test, in
  `beforeEach`, or in a factory.
- **Seeding is a follow-up.** Restoring a seeded baseline instead of resetting to empty
  measured 7 / 19 / 91 ms per test at 20 / 200 / 2000 rows per table. Per-file baselines,
  which would make `beforeAll` fixtures last for a whole file, belong to that follow-up,
  not to this decision.
- **The setup file shrinks to `setupWorkerDatabase()`.** The ordering rule (no static app
  imports there) still holds, because the client must be built after `DATABASE_URL` is
  set. A violation still fails loudly: either the client module's own unset-variable
  throw fires, or the guard's `current_database()` check does.
- **Failure modes change.** A misrouted suite would now _empty_ a database rather than
  lock it, so the guard is the last line of defence and checks twice. A lock a test leaks
  makes that test fail after 5 seconds instead of wedging the next one.
- **Known limits.** `onTestFinished` callbacks run after the Reset, so rows they write
  survive into the next test; the docs keep database writes in `afterEach`. `setval`
  cannot reach values another session has already cached, so a sequence declared with
  `CACHE` above 1 (Prisma never emits one) can hand a later test pre-Reset ids from a
  pooled connection.
- **`pool: "forks"` with `isolate: true` remains the documented requirement.** The opt-in
  flag and the cached Reset statement are per-file module state.
