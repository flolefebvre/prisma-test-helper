# Plan — #17: cold first Reset on a new backend

Status: **proposed**, not started. Supersedes the option list in the issue body; the
corrections below should be posted back to #17 once this plan is accepted.

## Goal

Cut the cost of the first Reset on a fresh Postgres backend (about 73 ms of server time
against 4.3 ms warm on the consumer's 73-table suite) without slowing the warm Reset and
without weakening Reset correctness, the Worker Database guard, or ADR 0001's
production-like concurrency.

## What we know

One run by an independent review, on `postgres:18-alpine` with the harness's flags: 73
tables with 4–5 indexes each and an FK chain, one worker. Cold is the median over 12
fresh backends; warm is the median of 40 Resets on one backend. Scripts: `measure-cold.mjs`
and `measure-probe.mjs` in this folder. **Not reproduced yet**: step 1 does that.

| State                                           | Shipped | Probe-gated (`pg_stat_file`) |
| ----------------------------------------------- | ------- | ---------------------------- |
| Cold, pristine clone (every table 0 bytes)      | 85.5 ms | 16.9 ms                      |
| Warm, each test writes 10 rows into 8 tables    | 5.1 ms  | 5.3 ms                       |
| Cold, new backend mid-file (8 tables dirtied)   | 83.1 ms | 29.0 ms                      |
| Cold, late in a run (all 73 dirtied, no vacuum) | 83.9 ms | 84.8 ms                      |
| Cold after `VACUUM` of the dirty tables         | 72.5 ms | 20.9 ms                      |

Where the 85 ms goes: the empty `DO` block costs 1.8 ms, `setval` on 73 sequences 16.8
ms, and planning the 73 `DELETE`s about 71 ms. `VACUUM` of 8 dirty tables took 6–11 ms
and brought every heap back to 0 bytes; all 73 took 67 ms.

## Corrections to the issue

1. **Option 1 is not a documentation change.** The harness breaks under
   `isolate: false` (`src/database.ts` keeps the opt-in flag at module scope). Moved to
   #22; out of scope here.
2. **`pg_relation_size` is not a cheap probe.** It opens every relation, building its
   relcache entry and triggers: 147 ms cold for the probe alone, worse than the Reset it
   gates. Rejected.
3. **A size probe only pays off if something returns sizes to 0.** Nothing truncates a
   Worker Database's heaps, so without a `VACUUM` every table that any earlier file wrote
   stays a candidate, and the probe decays to parity over a run (row 4).
4. **Sequences have a floor of about 17 ms.** A failed insert advances a sequence while
   its table stays at 0 bytes, so the rewinds cannot be gated by the table probe. They
   stay unconditional. `tests/integration/reset.test.ts` (the failed-insert pair) guards
   this.
5. **"Done when" needs a per-file criterion.** What a file pays is two cold Resets plus
   the new `afterAll` cost, not one Reset in isolation.

## Design

### The probe-gated Reset

The statement is still built once per file by `buildResetStatement`, which stays pure:
all quoting happens JS-side.

```sql
DO $reset$
DECLARE deletes text;
BEGIN
  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);
  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  SELECT string_agg(t.fragment, ', ') INTO deletes
  FROM unnest(ARRAY[<relations>], ARRAY[<pre-quoted DELETE CTE fragments>]) AS t(rel, fragment)
  WHERE coalesce((pg_catalog.pg_stat_file(pg_catalog.pg_relation_filepath(t.rel), true)).size, 1) > 0;
  EXECUTE coalesce('WITH ' || deletes || ' ', '') || $reset_sql$SELECT <every setval>$reset_sql$;
END
$reset$
```

- **Filter the candidate array directly.** Never join `pg_class` in the probe: the
  planner pushes the qual below the join and stats every relation in the database (32 ms
  cold, +4 ms warm in the review).
- **Partitioned parents have no file.** `pg_relation_filepath` returns NULL for
  `relkind = 'p'`, so discovery carries `relkind` and the builder emits those deletes
  unconditionally, outside the probed array.
- **A missing or NULL size counts as dirty** (`coalesce(…, 1)`), so the probe can only
  over-delete, never skip.
- **Resolve relations at Reset time, not at discovery.** A test that runs `TRUNCATE` or
  `VACUUM FULL` changes the relfilenode, so a path cached at discovery would silently
  skip that table. Two candidates, chosen by the benchmark:
  - `to_regclass(<qualified name>)`: keeps today's name-based tolerance of a dropped and
    recreated table, about +1 ms warm in the review;
  - OIDs from discovery: cheaper, but a recreated table would be missed. Today's
    statement would then fail loudly on the old name instead.

  Prefer `to_regclass` if the difference is within noise.

- **Sequences stay unconditional**, rewound in the final `SELECT` as today.
- The dollar-tag check in `buildResetStatement` extends to the fragments.
- `pg_stat_file` needs superuser (or `pg_read_server_files`). The harness already
  assumes superuser for `session_replication_role`. Say so explicitly in the ADR.

### Best-effort `VACUUM` between files

`setupDatabase` registers an `afterAll` that finds the tables with a nonzero heap, using
the same probe, and sends `VACUUM <those tables>` through `db.$executeRawUnsafe`.

- **Best-effort, never fatal.** The Reset stays correct without it; a failed or skipped
  `VACUUM` only costs the next file some speed. It must not fail the file.
- **It cannot run in a transaction block.** Spike that Prisma's raw execute sends it
  outside one before building on it.
- **Truncation needs a conditional `ACCESS EXCLUSIVE` lock.** Postgres retries for up to
  about 5 s, then gives up truncating. A connection the file leaked holding a lock
  would add that wait to `afterAll`. Measure it. If it is real, skip the `VACUUM` when
  `pg_stat_activity` shows another session in this database with an open transaction.
- Registered from `setupDatabase`, so with Vitest's default `sequence.hooks: "stack"` it
  runs after the file's own `afterAll` hooks.
- It changes storage and `pg_class` statistics, not schema, and runs when no test is
  active. ADR 0001's concurrency stance is untouched; the guard has already passed.

### Rejected

- **Pre-warming:** the `beforeAll` Reset is the first statement on its connection, and
  the library does not own the app's pool backends, so there is nothing to warm off the
  critical path.
- **Insert-tracking triggers:** they modify the consumer's schema, tax every insert,
  need their own reset, and tell nothing the heap size does not.
- **A connection pooler in front of the container:** a second process and Prisma
  pooling-mode interactions. #22 gets backend reuse with no infrastructure.
- **Statistics probes:** other backends flush their counters lazily (as the issue says).
- **Doing nothing:** only if step 1 fails to reproduce the gain.

## Steps

1. **Benchmark: `docs/adr/0001-bench/bench4.mjs`**, grown from `measure-cold.mjs`.
   - Cold on genuinely fresh backends (a new connection per sample, connect excluded
     from the timing); warm on one backend with a test's writes between Resets.
   - The four states in the table above, plus "cold after `VACUUM`".
   - 1 and 20 workers, concurrently, like `bench3.mjs`.
   - Index density as a parameter, and a partitioned table in the schema.
   - `SCHEMA_SQL=<file>` to replay a real schema (`prisma migrate diff --script`).
   - `VACUUM` cost against the dirty-set size (8 vs 73), checking that sizes return to 0.
   - Variants: `shipped`, the probe with `to_regclass`, and the probe with OIDs.
2. **Spike: `VACUUM` through Prisma.** One integration test sending
   `VACUUM "a", "b"` through the fixture client's `$executeRawUnsafe`.
3. **Decision gate.** Proceed only if, at both 1 and 20 workers:
   - per-file cost (two cold Resets plus `afterAll`) drops measurably in the pristine
     and mid-file states;
   - the late-run state with no `VACUUM` stays at parity;
   - the warm median stays within run-to-run noise of `shipped`.

   Otherwise skip to step 6 and record why.

4. **Implement**, one commit per item:
   - `relkind` in `DISCOVERY_QUERY`; `discovery.test.ts` asserts it;
   - the probe-gated `buildResetStatement`, with unit tests rewritten (the current
     "without probing" test at `src/reset.test.ts:71` changes), covering partitions,
     quoting and the dollar-tag check;
   - the `afterAll` `VACUUM`, non-fatal, with integration tests: sizes return to 0
     after a file, and a failed `VACUUM` does not fail the file;
   - an integration test that a table written by one test is emptied by the next Reset
     even when the probe runs on a fresh connection.
5. **Confirm through the real path:** the repo's integration suite passes, and one
   consumer-shaped run shows the cold Resets in `log_min_duration_statement` output.
6. **Docs:** ADR 0001 amendment 2 with the bench4 table, the superuser note, and the
   rejected options; fix the stale comment at `src/reset.ts:20` ("quoting happens
   server-side, via `%I`") and the `buildResetStatement` doc comment, which says nothing
   is probed.

## Open questions for the maintainer

- Can the consumer's real 73-table schema be exported for one confirming benchmark run?
  Until then, the synthetic schema stands in.
- How long does that suite take to run? The estimated saving is about 110 ms per file
  (about 3 s of wall time across 114 files on 4 workers), which decides whether #17 or
  #22 goes first.
- Is stating the superuser requirement acceptable? Does any consumer run the harness on
  an image whose user is not a superuser?

## Out of scope

- `isolate: false` support: #22.
- Probing sequences to get under the 17 ms floor. `pg_sequence_last_value` was slower
  warm in ADR 0001's amendment, and anything else needs its own measurement.
