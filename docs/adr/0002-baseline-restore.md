# 0002 — Baseline restore: rows migrations insert survive the Reset

- **Status:** accepted
- **Date:** 2026-10-14
- **Issue:** #38 (parent #20)

## Context

ADR 0001 made the Reset return a Worker Database to empty after every test. It emptied
every table but `_prisma_migrations` and extension-owned ones, so rows a migration
inserts — lookup tables, roles, plans — were gone before the first test. Up to 0.3 they
were visible to every test, because a rollback never touched them. ADR 0001 left seeding
as a follow-up ("Seeding is a follow-up"), and 1.0 is not yet tagged, so this restores
0.3's behaviour rather than changing 1.0's.

What makes it hard is the cost of finding out what a test changed. The seeded-baseline
restore measured while designing 1.0 (50 tables, a snapshot in a separate schema,
restoring the tables detected as changed) cost 7 / 19 / 91 ms per test at 20 / 200 /
2,000 rows per table, and most of that was the detection.

## Decision

The tables that hold rows after `prisma migrate deploy` form the run's **Baseline**.
Each Reset empties every other table as before, restores **only the Baseline tables a
test wrote to**, and puts the sequences those tables own back where the snapshot found
them.

- **Inferred, always on.** The Baseline is every table of the Reset's own table
  definition that is non-empty after migrate. No configuration, no flag, no escape
  hatch. A test may write Baseline tables; the next Reset restores them.
- **One definition of "which tables count".** The table CTE the Reset's discovery uses
  (`TABLES_CTE`, with the owned-sequence CTE after it) lives in `src/baseline.ts` and
  is shared by discovery and the install, so the two cannot drift. It now also leaves
  out the harness schema.
- **The harness schema**, `prisma_test_helper`, is always created in the Template
  Database, so every Worker Database inherits it, even when the Baseline is empty:
  - `baseline`, the catalog: one row per Baseline table — an `ordinal`, its source
    `(schema, name, relkind)`, and the column list a restore writes (from
    `pg_attribute`: no dropped, no generated columns);
  - `t<ordinal>`, the snapshot copy of each, made with `CREATE TABLE … AS SELECT *`: no
    constraint, index or trigger. Copies are named by ordinal because Postgres
    truncates identifiers at 63 bytes, so names built from the source would collide;
  - `sequence`: `last_value` and `is_called` of every sequence a Baseline table owns;
  - `dirty`, unlogged, with no index: the ordinals written since the last Reset;
  - `prisma_test_helper_mark_dirty()`, the trigger function.
- **Install, in global setup**, through the `pg` admin connection, connected to the
  template, after migrate and before cloning. `withAdminConnection` closes it before the
  clones' connection opens, so `CREATE DATABASE … TEMPLATE` never sees it (SQLSTATE
  55006). The SQL comes from pure builders in `src/baseline.ts`; #44's `url` mode can
  reuse the path as is. A consumer schema already named `prisma_test_helper` fails the
  install, naming it.
- **Tracking.** Each ordinary Baseline table gets a statement-level `AFTER INSERT OR
UPDATE OR DELETE OR TRUNCATE` trigger, `prisma_test_helper_dirty`, that records its
  ordinal.
  - **No unique index** on `dirty`; the function inserts `WHERE NOT EXISTS`. Under a
    unique index, a second transaction marking the same table would wait on the first's
    uncommitted mark: a lock the application never takes in production. Duplicate marks
    are harmless.
  - **`SECURITY DEFINER`**, owned by the installing superuser, with `SET search_path =
pg_catalog, pg_temp`, every reference schema-qualified, and `EXECUTE` revoked from
    `PUBLIC`. A test that writes a Baseline table as a restricted role needs no
    privilege on the harness schema, which stays private. Postgres checks `EXECUTE` when
    the trigger is created, not when it fires.
  - **Default enablement** (`ENABLE TRIGGER`, origin). The Reset runs with
    `session_replication_role = replica`, which silences it, so a restore does not mark
    its table dirty again.
  - A write that rolls back rolls its mark back too: the table is unchanged.
- **Partitioned Baseline tables get no trigger and are restored on every Reset.** A
  statement aimed straight at a partition does not fire its parent's statement trigger,
  so a mark on the parent would miss it.
- **The Reset** (`buildResetStatement`, still one `DO` block and one `EXECUTE`):
  - Discovery `LEFT JOIN`s the catalog, so `prepareReset` learns, in its one discovery
    round trip, which tables are Baseline tables and where their sequences go back to.
  - Baseline tables are never emptied and never enter the heap-size probe.
  - A second query in the block, `WITH dirty AS (DELETE FROM prisma_test_helper.dirty
RETURNING ordinal) SELECT string_agg(…) INTO restores …`, reads and clears the marks
    and keeps the restore of each marked table. The block is one transaction, so marks
    disappear only if the restores they selected commit.
  - A restore is two data-modifying CTEs: `r<n>d AS (DELETE FROM <table> RETURNING 1)`
    and `r<n> AS (INSERT INTO <table> (<columns>) OVERRIDING SYSTEM VALUE SELECT
<columns> FROM prisma_test_helper.t<n> WHERE (SELECT count(*) FROM r<n>d) >= 0)`.
    CTEs run in no fixed order. The initplan finishes the delete before the insert emits
    a row, so a restored key never meets a live old one. `OVERRIDING SYSTEM VALUE` keeps
    `GENERATED ALWAYS` identities and does nothing on other tables. FK triggers are off
    (`replica`), so table order does not matter.
  - Sequences a Baseline table owns are restored with `setval(seq, last_value,
is_called)`, unconditionally, like every rewind: a failed insert advances a sequence
    and its mark rolls back. Every other sequence still rewinds to its `start_value`.
    ADR 0001's `CACHE > 1` limit applies to both.
  - **With an empty Baseline the statement is byte-identical** to the one before this
    decision. A unit test pins all four shapes against the pre-Baseline build's output.
- **The `VACUUM` between files now also vacuums every Baseline table**, unprobed, in the
  same `VACUUM (SKIP_LOCKED)` statement and under the same "no other open transaction"
  guard. It is still best effort. The numbers are below.

### Reconciling with ADR 0001, amendment 2

Amendment 2 rejected **insert-tracking triggers**. That rejection was of triggers on
_every_ table, as a replacement for the heap-size probe, where they tax every insert,
need their own reset, and "say nothing the heap size does not". Here the heap size cannot
answer the question: a Baseline table's heap is never empty, and an insert into an
existing page leaves its size unchanged. So triggers go only on the Baseline tables,
where the probe cannot work. The tables a test usually writes keep the probe, and their
inserts pay nothing new. The rest of amendment 2 stands.

## Alternatives considered

- **Restore every Baseline table on every Reset.** Its cost grows with the Baseline on
  every test: `dirty-2000` below is what each test would pay for every 2,000-row table.
- **`pg_stat_user_tables` counters.** Other backends flush them lazily, so a fresh
  backend can read a written table as clean (the reason amendment 2 rejected them too).
- **The heap-file-size probe of #17.** An insert into an existing page does not change
  the size, and a Baseline heap is never 0 bytes.
- **Catalog-based change detection**, as in 1.0's design measurements. The 7 / 19 / 91 ms
  per test came mostly from it.
- **`ENABLE ALWAYS` or `REPLICA` triggers.** They would fire during the restore and mark
  every restored table dirty again.
- **`ON CONFLICT DO NOTHING` on a unique dirty table.** It introduces the cross-
  transaction wait described above.
- **`GRANT … TO PUBLIC` on the harness schema** instead of `SECURITY DEFINER`. That would
  make the schema world-writable.
- **`TRUNCATE` to empty a table before its restore.** A lookup table referenced by a
  foreign key refuses it whatever `session_replication_role` says, and amendment 1
  measured it as far slower under concurrency.
- **Separate statements per restored table** (a `DELETE`, then an `INSERT`, each its own
  `EXECUTE`). That is two more statements to plan per dirty table on every Reset, against
  amendment 1's single planned statement. The initplan ordering gets the same guarantee
  inside the one `EXECUTE`. (Not measured separately.)
- **A per-test `VACUUM`**, or a new hook for one. `VACUUM` cannot run inside the Reset's
  `DO` block, and the per-file seam already exists. See Known limits.

## Measurements

Script: [`docs/plans/0038-baseline/measure-baseline.mjs`](../plans/0038-baseline/measure-baseline.mjs).
It drives the package's own build: the install builders in global setup's order, and
`prepareReset`. "Before" is `src/reset.ts` as of a113c12, compiled on its own, on a
template without the harness schema.

- **Container:** `postgres:18-alpine` with the harness's flags (tmpfs, `fsync`,
  `synchronous_commit` and `full_page_writes` off), on WSL2 with 20 cores.
- **Schema:** bench4's shape. 72 ordinary tables in an FK chain with 4 secondary
  indexes each, and a partitioned parent, plus 5 lookup tables (a unique code, a label,
  a rank).
- **Baseline:** in the `untouched-R` and `dirty-R` scenarios, each lookup table is
  filled with R rows.
- **A test** writes 10 rows into 8 tables. In `dirty-R` it also updates one row of one
  lookup table.
- **Warm:** median of 200 Resets per worker after 20 warm-up Resets, on fresh clones,
  three interleaved rounds.
- **Cold:** the Reset as the first statement on a new backend.

```
pnpm build
git show a113c12:src/reset.ts > scratch/old/reset.ts
node_modules/.bin/tsc --target es2022 --module nodenext --moduleResolution nodenext \
  --outDir scratch/old scratch/old/reset.ts
RESET_JS=$PWD/scratch/old/reset.js node docs/plans/0038-baseline/measure-baseline.mjs 55438 1 warm cold trigger
COLD=6 RESET_JS=$PWD/scratch/old/reset.js node docs/plans/0038-baseline/measure-baseline.mjs 55438 20 warm cold
node docs/plans/0038-baseline/measure-baseline.mjs 55438 20 files
node docs/plans/0038-baseline/measure-baseline.mjs 55438 1 files
```

Per-test Reset, ms:

| Scenario                               | Warm, W = 1        | Warm, W = 20        | Cold, W = 1 | Cold, W = 20 |
| -------------------------------------- | ------------------ | ------------------- | ----------- | ------------ |
| Before Baselines                       | 4.11 / 3.82 / 3.86 | 6.13 / 5.95 / 5.77  | 30.1        | 44.5         |
| No Baseline (harness schema installed) | 3.94 / 3.77 / 3.76 | 6.01 / 5.81 / 5.72  | 30.5        | 45.0         |
| Baseline of 5 × 20 rows, untouched     | 4.41 / 4.37 / 4.11 | 6.45 / 6.35 / 6.37  | 30.9        | 46.9         |
| Baseline of 5 × 200 rows, untouched    | 4.03 / 4.29 / 4.21 | 6.40 / 6.30 / 6.41  | 30.6        | 48.0         |
| Baseline of 5 × 2,000 rows, untouched  | 4.10 / 4.22 / 4.32 | 6.38 / 6.38 / 6.33  | 31.7        | 47.3         |
| One dirty table of 20 rows             | 4.49 / 4.87 / 4.51 | 7.10 / 7.00 / 7.13  | 33.0        | 50.5         |
| One dirty table of 200 rows            | 6.37 / 6.31 / 6.37 | 10.30 / 9.79 / 9.77 | 35.5        | 55.5         |
| One dirty table of 2,000 rows          | 20.1 / 20.3 / 20.3 | 67.8 / 68.5 / 69.0  | 51.2        | 133          |

What the numbers say:

- **No Baseline: no change.** The statement is byte-identical, and the medians sit
  within each other's run-to-run spread at both worker counts. Discovery gains a
  `LEFT JOIN` to a 0-row catalog, once per file.
- **An untouched Baseline costs about +0.4 ms warm** at both worker counts, whatever its
  size. That is the query that reads and clears the marks. Cold, it is within noise at
  one worker and +2.4–3.5 ms at 20.
- **A dirty table costs its restore:** +0.7 ms at 20 rows, +2.5 ms at 200, +16 ms at
  2,000 at one worker (+1, +4, +62 ms at 20 workers). That is per table a test writes,
  not per Baseline table. The 2,000-row figure at 20 workers already includes the
  within-file drift described next: it is 220 consecutive restores of one table.
- **Tracking costs a test nothing measurable.** 1,000 single-row `UPDATE`s of a Baseline
  table against an identical untracked one, interleaved five times, differed by −27 to
  +8 µs per statement across three runs. `SECURITY DEFINER` and its `SET search_path` do
  not show.

### The `VACUUM` between files

Each restore leaves the table's old rows dead. Autovacuum (one-minute naptime, three
workers across every database) does not keep up with a test suite, so the restore's
`DELETE` scans an ever larger heap. Over one file of 400 `dirty-2000` restores at one
worker, the median went from 19.5 ms (first 50) to 22.3 ms (last 50), and the table's
heap from 152 KB to 59 MB.

8 files × 50 tests per worker, median Reset of each file, then the median afterAll.
"Probed" is the afterAll before this decision, which leaves Baseline tables alone;
"shipped" adds every Baseline table:

| Scenario, W = 20        | afterAll | Reset, files 1 → 8                              | afterAll ms |
| ----------------------- | -------- | ----------------------------------------------- | ----------- |
| No Baseline             | probed   | 6.39 6.01 5.93 5.90 6.08 5.97 5.84 5.81         | 17.6        |
| No Baseline             | shipped  | 5.87 5.99 6.07 5.97 5.97 5.76 6.44 5.98         | 18.0        |
| 5 × 20 rows, untouched  | probed   | 6.49 6.39 6.91 6.60 7.71 7.46 7.45 8.20         | 20.8        |
| 5 × 20 rows, untouched  | shipped  | 8.17 7.39 7.16 7.14 6.97 6.84 7.18 6.87         | 24.0        |
| 5 × 200 rows, untouched | probed   | 7.38 7.14 6.85 6.66 7.25 7.52 6.88 6.75         | 19.2        |
| 5 × 200 rows, untouched | shipped  | 6.88 6.92 7.17 6.82 6.91 7.30 6.87 7.07         | 24.3        |
| One dirty, 200 rows     | probed   | 12.97 11.33 11.22 10.99 11.15 11.65 12.12 10.85 | 25.9        |
| One dirty, 200 rows     | shipped  | 10.79 10.43 9.54 9.53 9.62 9.51 9.53 9.83       | 25.0        |
| One dirty, 2,000 rows   | probed   | 43.1 53.5 72.6 91.8 105.0 114.3 131.7 152.0     | 45.4        |
| One dirty, 2,000 rows   | shipped  | 43.0 48.3 46.2 48.5 48.6 47.3 46.3 46.9         | 70.7        |

At one worker the same run gave: untouched, an afterAll of +2.3 ms; dirty-2000, files
drifting 20.4 → 22.4 ms probed against a flat 19.0–19.9 ms shipped.

So it ships. Without it a dirty large Baseline table compounds per test across a run:
at 20 workers it went from 43 to 152 ms per Reset in 8 files. With it the Reset stays
flat. On an untouched Baseline it adds 2–5 ms per file, against a bar of about 10 ms.
It is best effort like the rest of the afterAll: it stands down while another session
has a transaction open, and never fails a file.

## Consequences

- Rows migrations insert are there at the start of every test, and an insert into a
  Baseline table gets the same id in every run and every test order: the snapshot's
  next value, not the start value.
- A project whose migrations insert no rows sees no change in behaviour. It gets an
  empty `prisma_test_helper` schema in every Worker Database, and a byte-identical Reset.
- **Partitioned Baseline tables are always restored**, so each costs every test a
  restore of its size, touched or not. Its dead rows are vacuumed between files with the
  rest.
- The harness owns a `prisma_test_helper` schema in every Worker Database and a
  `prisma_test_helper_dirty` trigger on every ordinary Baseline table. Migrations must
  not create that schema.
- Superuser stays a requirement: the install creates a `SECURITY DEFINER` function, and
  the Reset already needed superuser (ADR 0001).

### Known limits

- **Within-file drift.** A single file whose every test dirties a large Baseline table
  sees restores slow across that file, about +15 % over 400 tests of a 2,000-row table
  at one worker, and steeper under concurrency. The `VACUUM` between files resets it. A
  per-test `VACUUM` is out of scope for now.
- **DDL on a Baseline table inside a test**, such as a renamed or added column, is not
  reflected in the snapshot. The restore writes the column list captured at install
  time.
- Writes a statement trigger cannot see are not tracked: `COPY` fires it, but a
  replication-role session (`session_replication_role = replica` set by the test itself)
  silences it, as it silences the Reset's own writes.

## Amendment 1 (#39), 2026-10-14 — the seed feeds the Baseline

`createGlobalSetup` takes a `seed`, the consumer's own seed function, which global setup
calls once with the Template Database's URL **between migrate and the snapshot**. The
tables it fills are therefore Baseline tables, snapshotted, tracked and restored exactly
like those a migration fills; nothing in the install or the Reset changes. Wherever this
ADR defines the Baseline as the tables non-empty "after migrate", read "after migrate and
the seed".

The seed runs in the consumer's code and may leave a connection open to the template,
which would make `CREATE DATABASE … TEMPLATE` fail with SQLSTATE 55006, naming cloning.
So when a seed is configured, global setup checks `pg_stat_activity` for client backends
on the template right after the seed returns, from an admin connection to `postgres`,
polling for about two seconds (a disconnected client's backend exits a moment after its
socket closes), and fails naming the seed. It never terminates a backend: a pool whose
idle client is killed emits `error`, which can crash the main process. Without a seed,
nothing else holds the template, and no check runs.
