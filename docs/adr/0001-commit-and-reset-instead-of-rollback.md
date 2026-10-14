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
  - runs **one** `EXECUTE` of a single SQL statement: a data-modifying CTE per table
    (`WITH d0 AS (DELETE FROM …), d1 AS (…), …`) and a final `SELECT` that rewinds every
    column-owned sequence to its own `start_value` with `setval(…, false)`. Amendment 1
    explains why no table is probed with `EXISTS`; amendment 2 keeps only the `DELETE`s
    of tables whose heap file is not 0 bytes, and adds a `VACUUM` between files.
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
| One `DO` block: probe, delete only non-empty tables (original) | 5.7 ms          | 4.6 ms       |
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
- **Batched `DELETE` (chosen).** `DELETE` on an empty table is nearly free. Sending
  everything in one `DO` block keeps it to one round trip. Sequences reset with `setval`,
  because `ALTER SEQUENCE … RESTART` costs about 7 times as much. The original block
  probed each table with `EXISTS` first; the amendment below removes the probe.

## Consequences

- **Per-test cost goes up by a few milliseconds:** about 5 ms at 73 tables on one
  worker, 9 ms with 20 workers resetting at once, instead of under 1 ms — and nearly flat
  as the schema grows (measured in the amendment).
- **Real commits unlock new tests.** Second connections, queue workers polling a table,
  deferred constraints, and `$transaction` in every form now behave exactly as in
  production, with no special rules.
- **`beforeAll` writes are legal but short-lived.** They commit, and the Reset after the
  file's first test removes them. Shared per-test data belongs in the test, in
  `beforeEach`, or in a factory.
- **Seeding is a follow-up.** Restoring a seeded baseline instead of resetting to empty
  measured 7 / 19 / 91 ms per test at 20 / 200 / 2000 rows per table. Per-file baselines,
  which would make `beforeAll` fixtures last for a whole file, belong to that follow-up,
  not to this decision. _Followed up by
  [ADR 0002](0002-baseline-restore.md): rows the migrations insert form a Baseline that
  the Reset restores, and only for the tables a test wrote to._
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
  flag and the cached Reset statement are per-file module state. _Revised by amendment 3:
  `isolate: true` stays the default, and `isolate: false` is a supported opt-in._

## Amendment 2026-10-11 — no probe, one planned statement

Before 1.0.0 shipped, a consumer suite measured the PR build at **45–50 ms per Reset**,
not 3–6: 73 tables, 20 workers, about 1,900 database tests, 15 % more wall time than
0.3.0. The benchmark above ran one connection for 40 iterations and never saw either
scale. [`0001-bench/bench3.mjs`](0001-bench/bench3.mjs) reproduces the consumer's shape —
73 tables, 20 Worker Databases reset concurrently, 100 tests per worker, each writing 10
rows into 8 tables — on `postgres:18-alpine` with the harness's flags. Medians per Reset:

| Variant                                                                                                          | 1 worker | 20 workers |
| ---------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| Original block: `EXISTS` probe per table, `pg_sequences` loop                                                    | 14.5 ms  | 31 ms      |
| … without the sequence loop                                                                                      |          | 14 ms      |
| One `DO` block, one `EXECUTE`: CTE `DELETE` per table, `setval` per sequence in the final `SELECT` (**shipped**) | 5.1 ms   | 8.6 ms     |
| … with `setval` as a static `PERFORM` per sequence instead                                                       |          | 14 ms      |
| … rewinding only sequences whose `pg_sequence_last_value` is set                                                 |          | 10 ms      |
| Plain batch of 73 `DELETE` + 73 `setval` statements (floor; Prisma's raw API refuses multi-statement strings)    |          | 7.6 ms     |
| `TRUNCATE … RESTART IDENTITY` of the dirty tables only                                                           |          | 550 ms     |

What the numbers say:

- **The `pg_sequences` loop was more than half the block.** The view computes
  `pg_sequence_last_value` for every sequence before the `IN` list filters them, and each
  hit then costs a `regclass` lookup. An unconditional `setval` is cheaper than asking
  whether it is needed.
- **The probe saved nothing.** A `DELETE` on an empty table costs about what `EXISTS` on
  it does, and every statement inside a `DO` block is parsed and planned again on each
  run — anonymous blocks cache no plans — so 73 probes plus up to 73 deletes were up to
  146 plans per Reset. A single statement with one data-modifying CTE per table is planned
  once; that is what makes the cost nearly flat in the number of tables.
- **Dead tuples did not matter.** Over 400 tests per worker the median stayed flat, so
  there is no vacuum step.
- **`TRUNCATE` is worse still under concurrency**, even restricted to the tables a test
  touched: its catalog locks and file allocations serialise across workers.
- Discovery costs about 5 ms per file at 73 tables, which does not register.

The Reset is therefore one `EXECUTE` of `WITH d0 AS (DELETE FROM …), … SELECT setval(…),
…`, inside the same `DO` block (still needed for the two transaction-local settings, and
still one round trip). Everything else in this decision stands.

## Amendment 2026-10-12 — a storage probe, and a `VACUUM` between files

Issue #17: the first Reset on a fresh Postgres backend cost about 85–95 ms at 73 tables,
against about 5 ms warm. Every test file pays it at least once: the `beforeAll` Reset is
the first statement on its connection, and the first `afterEach` Reset often lands on
another new pool backend. Most of that cost is not deleting. To plan a `DELETE`, a
backend first builds the relcache entry of the table and its indexes, and a fresh
backend has none. Planning the 73 `DELETE`s took about 71 ms cold, the 73 `setval`s about
17 ms, and the empty block about 2 ms.

### Decision

- **The Reset deletes only from tables whose heap file is not 0 bytes.** Inside the `DO`
  block, one query filters the candidate list with
  `coalesce((pg_stat_file(pg_relation_filepath(rel), true)).size, 1) > 0` and aggregates
  the pre-quoted `DELETE` CTEs of the tables it keeps. A single `EXECUTE` then runs those
  and the `setval`s, as before. `pg_stat_file` costs one `stat()` and never opens the
  relation, so a table that is skipped gets no relcache entry.
  - A NULL or missing size counts as dirty: the probe can over-delete, never skip.
  - The candidate array is filtered directly, never joined to `pg_class`. Joined, the
    planner runs the probe on every relation in the database (32 ms cold and 4 ms warm in
    the review).
  - **Partitioned parents** (`relkind = 'p'`, now carried by discovery) have no file of
    their own, so their `DELETE` is emitted unconditionally.
  - **Sequences are always rewound.** A failed insert advances a sequence and leaves its
    table's file at 0 bytes, so the table probe cannot gate them.
  - **Relations are resolved by name at Reset time, with `to_regclass`.** A path cached at
    discovery would go stale, since `TRUNCATE` and `VACUUM FULL` give a table a new file.
    OIDs from discovery would be about 0.5–1 ms cheaper warm, and a dropped table is not
    the problem: its OID no longer resolves, the size comes back NULL, and the table counts
    as dirty. The problem is that a dropped table's OID can be **reused** by another
    relation (an index, a TOAST table, another table). If that relation's file is empty,
    the probe would skip a table that holds rows. `to_regclass` keeps the name-based
    behaviour the Reset always had: a table dropped and recreated under the same name is
    found again.
  - Quoting stays JS-side: `buildResetStatement` is still pure and unit-tested, and its
    dollar-tag check covers every emitted fragment.
- **`setupDatabase` registers an `afterAll` that vacuums the tables whose heap file is
  not 0 bytes**, using the same probe, with `VACUUM (SKIP_LOCKED) <those tables>` through
  the consumer's client. A `DELETE` leaves its pages behind, and only a `VACUUM` truncates
  an emptied heap back to 0 bytes. Without one, every table any earlier file wrote stays a
  candidate, and the probe decays to the cost of the plain Reset over a run.
  - **It is best effort.** It never rejects, and a failure only makes the next file's first
    Reset slower. The Reset is correct without it.
  - When nothing is dirty it sends nothing, since a bare `VACUUM` processes the whole
    database. `SKIP_LOCKED` passes over any table whose lock is not free at once.
  - **It stands down while another client session of this database has a transaction
    open**: a `pg_stat_activity` row with the same `datname`, another `pid`, a
    `backend_type` of `client backend`, and `xact_start` set. Truncating a heap needs
    `ACCESS EXCLUSIVE`, which `VACUUM` takes only conditionally. Against a lock that a
    connection the file leaked still holds, it retries for about 5 s and then gives up
    (measured below).
  - With Vitest's default `sequence.hooks: "stack"`, it runs after the file's own
    `afterAll` hooks. It changes storage and `pg_class` statistics, not rows or schema,
    and runs when no test is active, so the concurrency stance of this decision is
    untouched.
- **Superuser is now required twice over.** `session_replication_role` already needed it.
  `pg_stat_file` needs it too (or `pg_read_server_files`), and so does reading other
  sessions' `xact_start` in `pg_stat_activity` (or `pg_read_all_stats`). The container
  `createGlobalSetup` starts runs as its superuser, so nothing changes for consumers. An
  image or role without those rights would make the Reset fail on `pg_stat_file`, loudly.

### Measurements

[`0001-bench/bench4.mjs`](0001-bench/bench4.mjs) uses the same container as bench3
(`postgres:18-alpine`, tmpfs, `fsync=off`), on WSL2 with 20 cores.

- **Schema:** generated, 73 tables. 72 are ordinary tables in an FK chain, each with a
  primary key and 4 secondary indexes. One is a partitioned parent with two partitions.
- **Concurrency:** W Worker Databases are driven at once.
- **Cold:** the Reset as the first statement on a new backend, with connecting excluded,
  medians over 12 backends per worker at W = 1 and 6 at W = 20.
- **Warm:** one backend, with a test's writes (10 rows into 8 tables) between Resets.

"Before" is bench4's `shipped`, pointed through `RESET_JS` at the Reset before this
amendment. "Probe" is `probe_regclass`, pointed through `PROBE_JS` at the package's own
build with this amendment, so it runs exactly the Reset statement and vacuum query the
package now emits. The OID column is bench4's inline `probe_oid`. The two builds and the
runs, from bench4's scratch directory (ranges span two runs of each):

```
# Before: src/reset.ts as of ad46371, compiled on its own
git -C <repo> show ad46371:src/reset.ts > old/reset.ts
<repo>/node_modules/.bin/tsc --target es2022 --module nodenext \
  --moduleResolution nodenext --outDir old old/reset.ts
# Probe: the package with this amendment
pnpm -C <repo> build

RESET_JS=$PWD/old/reset.js PROBE_JS=<repo>/dist/reset.js node bench4.mjs 5433 1 12
RESET_JS=$PWD/old/reset.js PROBE_JS=<repo>/dist/reset.js node bench4.mjs 5433 20 6
```

Cold Reset, ms:

| State of the Worker Database               | W   | Before  | Probe   | Probe, OIDs |
| ------------------------------------------ | --- | ------- | ------- | ----------- |
| Pristine clone (every heap 0 bytes)        | 1   | 91–98   | 23–36   | 25–34       |
| Mid-file: 8 tables written and emptied     | 1   | 95–122  | 29–31   | 31–38       |
| Late in a run, no `VACUUM` ever: 72 tables | 1   | 98–99   | 94–110  | 97–105      |
| That late state after a `VACUUM`           | 1   | 81–91   | 23–32   | 22–27       |
| Pristine clone                             | 20  | 143–178 | 32–34   | 29–31       |
| Mid-file                                   | 20  | 128–152 | 41–42   | 37–39       |
| Late in a run, no `VACUUM` ever            | 20  | 131–133 | 131–140 | 128–131     |
| After a `VACUUM`                           | 20  | 111–119 | 31–33   | 28–31       |

The `afterAll` (probe plus `VACUUM`) took 11–13 ms at W = 1 and 19–20 ms at W = 20
with 8 dirty tables. With all 72 dirty it took 57–61 ms and 85–92 ms. Every heap was
back to 0 bytes afterwards, in every run.

**Per file** = the `beforeAll` Reset + the first `afterEach` Reset (mid-file, on a
backend that may be new too) + the `afterAll`, ms:

| File starts                    | W   | Before  | Probe + `VACUUM` |
| ------------------------------ | --- | ------- | ---------------- |
| On a pristine clone            | 1   | 186–220 | 65–78            |
| After the previous file's run  | 1   | 176–213 | 65–74            |
| Late, no `VACUUM` ever (worst) | 1   | 195–198 | 188–221          |
| On a pristine clone            | 20  | 295–306 | 93–95            |
| After the previous file's run  | 20  | 247–263 | 92–93            |
| Late, no `VACUUM` ever (worst) | 20  | 262–266 | 263–280          |

The worst case is the probe with every heap dirty and no `VACUUM`, which is what a
`VACUUM` that keeps failing would leave behind. It stays at parity with the old Reset,
within the spread of the samples.

**The warm Reset is slower.** The probe runs on every Reset, and on a warm backend it saves
almost nothing. Measured with the variants interleaved three times in one process:

```
# same RESET_JS and PROBE_JS as above; the three variants listed three times over
WARM=300 SECTIONS=warm node bench4.mjs 5433 1 1 shipped probe_regclass probe_oid … (×3)
SECTIONS=warm node bench4.mjs 5433 20 1 shipped probe_regclass probe_oid … (×3)
```

| W   | Before          | Probe              | Probe, OIDs |
| --- | --------------- | ------------------ | ----------- |
| 1   | 4.5 / 4.8 / 4.8 | 6.3 / 6.7 / 6.7    | 5.2–5.4     |
| 20  | 8.1 / 8.3 / 8.8 | 10.0 / 10.0 / 10.0 | 9.0–9.4     |

That is about **+1.9 ms per test at one worker (+40%) and +1.7 ms at 20 (+20%)**,
against a per-file saving of about 130 ms and 205 ms. A file comes out ahead up to
about **70 tests at one worker and 120 at 20**. The pre-implementation gate run, with
bench4's inline statement on another day, measured +1.4 ms (+30% and +18%) and
break-evens of about 75 and 125. The figures above are the ones that count, because they
time the statement the package ships. The criterion for this change is therefore the
cost per file, not "the warm Reset does not get slower". It does, and the maintainer
accepted that trade.

Leaked lock (bench4's `lock` section, on worker 1, in each of the four runs above): with
another session holding `ACCESS SHARE` on a dirty table in an open transaction, an
unguarded `VACUUM` of 8 tables took 5.16–5.19 s and left that heap nonzero. Guarded, the
`afterAll` took 6.5–7.3 ms and vacuumed nothing.

### Rejected

- **Probing with `pg_relation_size`.** It opens every relation, which is the very cost
  being avoided: 147 ms cold for the probe alone.
- **Pre-warming a backend.** The `beforeAll` Reset is already the first statement on its
  connection, and the library does not own the app's pool, so there is nothing to warm off
  the critical path.
- **Insert-tracking triggers.** They modify the consumer's schema, tax every insert,
  need their own reset, and say nothing the heap size does not.
- **A connection pooler in front of the container.** That means a second process, plus
  Prisma's interactions with pooling modes. #22 gets backends reused without
  infrastructure.
- **Statistics probes** (`pg_stat_user_tables`). Other backends flush their counters
  lazily, so a fresh backend can read a written table as clean.
- **Probing only a backend's first Reset.** Its second Reset would then plan a `DELETE`
  on every table, and so pay the cold cost anyway.
- **Probing sequences**, to get under the floor of about 17 ms for 73 `setval`s cold.
  `pg_sequence_last_value` was slower warm in amendment 1. Anything else needs its own
  measurement.

### Looking ahead

Under `isolate: false` (#22), backends would live for the whole run. The cold Reset then
becomes rare, so the saving shrinks while the warm cost stays: #22 should revisit whether
the probe stays on in that mode.

## Amendment 2026-10-14 — `isolate: false` as an opt-in

Issue #40 (parent #22). Under Vitest's `isolate: false` a worker keeps its modules across
the test files it runs: the app's import graph, its Prisma client and connection pool,
and this package's own modules. Before this amendment the harness broke there:

- The opt-in flag was module state, so the second opted-in file on a worker threw
  "`setupDatabase()` was called twice in this file".
- A file that never opted in read a neighbour's `isDatabaseSetUp()` as `true`.

`isolate: true` stays the default the docs prescribe. `isolate: false` becomes a supported
opt-in.

### Decision

- **A file's opt-in state belongs to that file, begun by the `/setup` entry.**
  - `setupWorkerDatabase()` clears it as its first step, before any check that can throw.
    Vitest runs `setupFiles` before collecting every file in both modes, and the call is
    already mandatory, so it is the one per-file hook the library owns.
  - The state lives in a small module (`src/opt-in.ts`) shared with `database.ts`. Vitest
    re-evaluates the setup file but not its imports, so that module is one instance per
    worker. `database.ts` keeps one code path for both modes, and nothing detects the mode.
  - **Rejected: keying the state on the test path** (`expect.getState().testPath`, valid
    at collection). Under `isolate: false` the module cache also survives watch-mode
    reruns, so rerunning a file would find its own path already opted in and throw.
  - **Rejected: an `afterAll` that clears the flag.** A file that fails during collection
    after opting in never runs it, and the next file would throw.
- **Discovery is cached per worker, keyed by the Worker Database URL**
  (`prepareReset`).
  - The cache holds what discovery produced, the built Reset statement and the vacuum
    probe: pure strings, never a closure.
  - Both guards still run on every call, the `current_database()` check included.
  - The returned functions close over the calling file's client, so a later file that
    passes another client is reset through its own.
  - A failed discovery is not kept.
  - Under `isolate: true` the module is new per file, so the cache only ever holds that
    file's discovery: nothing is mode-specific.
  - **The cost:** DDL a test runs outside the migrations is not seen by later files on
    the worker. A table a test drops makes their Reset fail loudly
    (`relation … does not exist`), because `to_regclass` returns NULL and the table
    counts as dirty. This is documented as a limit of the opt-in.
    `tests/integration/discovery.test.ts`, which builds and drops a fixture schema, clears
    the cache around it through an internal export.
- **Reset Hooks stay per worker.** Factory modules register them at import, which happens
  once per worker under `isolate: false`, so the set is never cleared. A hook registered
  inside one test file's body carries over to later files on that worker. That is
  documented.
- **The `VACUUM` between files stays unconditional, both of its jobs, in both modes.**
  - **Job (a)** returns emptied heaps to 0 bytes so a fresh backend's storage probe skips
    them (amendment 2).
  - **Job (b)** clears the dead rows Baseline restores leave (ADR 0002).
  - The numbers and the reasoning follow.
- An integration project, `integration-no-isolate`, runs the container suite under
  `isolate: false` with the same `maxWorkers` as the others. Unit tests pin the per-file
  state and the cache deterministically, since which files share a worker is the pool's
  choice.

### Measurements

[`../plans/0022-isolate-false/measure-isolate.mjs`](../plans/0022-isolate-false/measure-isolate.mjs)
runs real Vitest over a generated suite through the repo's own container global setup.

- **Schema:** the repo's schema padded to 73 tables in bench4's shape, and a `Tag`
  Baseline of 2,000 rows.
- **Import cost:** a client module shaped like `tests/db/client.ts`, plus 300 ms of
  synchronous work at import standing in for an app's import graph.
- **Suite:** 8 files per worker of 20 tests. Each test writes an Author with a Post, a row
  into each of 8 other tables, and one `Tag` update.
- **Variants:** three builds of `dist/`, generated by text patches at run time:
  - `shipped`, as built;
  - `baseline-only`, whose `afterAll` vacuums only Baseline tables (no job a);
  - `none`, with no `afterAll` `VACUUM`.
- **Runs:** W = 4 and 16, 3 interleaved rounds, on WSL2 with 20 cores.

The full table is in [`PLAN.md`](../plans/0022-isolate-false/PLAN.md) next to the script.

**The saving**, `shipped` in both modes:

| W   | Suite, `isolate: true` → `false` | Per file       | First Reset of a file |
| --- | -------------------------------- | -------------- | --------------------- |
| 4   | 11.97 → 6.47 s (−46 %)           | 1343 → 684 ms  | 22.7 → 5.5 ms         |
| 16  | 15.54 → 10.08 s (−35 %)          | 1850 → 1036 ms | 33.3 → 7.7 ms         |

Most of it is the import and collection a file no longer repeats. The rest is the
`beforeAll` Reset landing on a warm backend.

**The `VACUUM` between files, per job.** All values are medians, in ms:

| W   | isolate | Job (a): first Reset, with → without | Job (a): its `afterAll` cost | Job (b): late files' Resets, with → without | Job (b): its `afterAll` cost |
| --- | ------- | ------------------------------------ | ---------------------------- | ------------------------------------------- | ---------------------------- |
| 4   | true    | 22.7 → 45.8                          | 11.1                         | 20.3 → 21.2                                 | 10.3                         |
| 4   | false   | 5.5 → 6.0                            | 10.7                         | 20.2 → 20.9                                 | 7.2                          |
| 16  | true    | 33.3 → 67.0                          | 18.0                         | 29.8 → 44.3                                 | 15.1                         |
| 16  | false   | 7.7 → 8.7                            | 18.4                         | 29.5 → 43.9                                 | 9.7                          |

- **Job (b) pays in both modes**, as ADR 0002 predicted. `isolate: false` does nothing
  about the dead rows a restore leaves. Without it, the Resets of a worker's last files
  drift from about 30 to about 44 ms at W = 16.
- **Job (a) pays under `isolate: true`** (net about −12 and −16 ms per file). Under
  `isolate: false` this benchmark shows no benefit for its 11–18 ms. It is kept anyway:
  - That result comes from the benchmark, not from the mode. Its files take about 1 s, so
    no pool backend ever idles out. In a real suite they do: `pg` closes an idle
    connection after 10 s by default, files have long stretches with no database work, and
    pools are wider than the tests' concurrency. A backend that reconnects onto dirty
    heaps pays the cold Reset of before amendment 2 (about 90 ms at 73 tables) instead of
    about 25. Job (a) is the insurance, and 11–18 ms per file (1.5–2 % of a file) is its
    premium.
  - Skipping it would need a mode heuristic ("this module already served a file"),
    threaded through the opt-in state into `database.ts` and a second probe variant, and
    would add a documented "the first file on a worker behaves differently". For 2 %, the
    project keeps one code path for both modes.

**Amendment 2's "Looking ahead"** asked whether the storage probe stays on under
`isolate: false`. It does, by arithmetic rather than a new measurement:

- On a warm backend the probe costs +1.7–1.9 ms per Reset.
- On the 1,900-test, 20-worker suite that motivated #17, that is about 3.4 s of server
  time spread over 20 workers, about 0.2 s of wall time.
- That is against the 35–46 % of suite time the opt-in itself saves.
- The idle-backend argument above applies to the probe too.

Not pursued.
