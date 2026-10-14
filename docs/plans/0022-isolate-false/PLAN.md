# Plan — #40 (parent #22): `isolate: false` as an opt-in

Status: **implemented**. The decision and its numbers are recorded in amendment 3 of
docs/adr/0001. This file keeps the measurement in full, how to read it, and the ruling on
the `VACUUM` between files.

## What changed

- **A file's opt-in state belongs to that file in both modes.** The `/setup` entry
  (`setupWorkerDatabase()`) begins it, as its very first step. Vitest runs `setupFiles`
  before collecting every file, under `isolate: false` as under `isolate: true`. That
  holds for watch-mode reruns of the same file too, which is why the state is not keyed on
  the test path. The state lives in `src/opt-in.ts`, shared by the setup entry and
  `database.ts`. Vitest re-evaluates the setup file itself but not what it imports, so
  that module stays one instance per worker.
- **Discovery is cached per worker, keyed by the Worker Database URL** (`prepareReset`,
  `src/reset.ts`).
  - Only the two statements built from the discovery rows are cached: the Reset
    statement and the vacuum probe.
  - The `current_database()` guard runs on every call.
  - The returned functions close over the calling file's client.
  - A failed discovery is not kept.
  - Under `isolate: true` the module is new per file, so nothing changes there.
- **Reset Hooks stay per worker.**
- **The `VACUUM` between files is unchanged**: both jobs run in both modes (see the
  ruling below).
- **`integration-no-isolate`** runs the container suite under `isolate: false`.
  `tests/integration/discovery.test.ts` runs DDL mid-run, so it clears the cache around
  its fixture.

## The measurement

`measure-isolate.mjs` generates the suite, the project and three builds of `dist/` into a
scratch directory, and runs real Vitest. Its header has the details. Command:

```
pnpm build && pnpm generate
node docs/plans/0022-isolate-false/measure-isolate.mjs
```

Defaults, all from this run:

- **Schema:** 73 tables, the repo's schema plus 67 tables in bench4's shape.
- **Baseline:** a `Tag` Baseline of 2,000 rows.
- **Import cost:** a client module that adds 300 ms of synchronous work at import.
- **Suite:** 8 files per worker × 20 tests. Each test writes an Author with a Post, one row
  into each of 8 synthetic tables, and updates one `Tag` row.
- **Workers and repetitions:** W = 4 and 16, 3 interleaved rounds.
- **Environment:** a 20-core WSL2 box, `postgres:18-alpine` via the repo's own
  `createGlobalSetup`. The run took 658 s.

How to read the variants:

- `shipped` is the package as built.
- `baseline-only` drops job (a): the `afterAll` vacuums the Baseline tables only.
- `none` has no `afterAll` `VACUUM`.
- So job (a) = `shipped` against `baseline-only`, and job (b) = `baseline-only` against
  `none`.

How to read the columns (medians over rounds):

- **suite:** first file start to last file end.
- **file:** setup file to the end of the `afterAll`.
- **Reset 1:** the `beforeAll` Reset.
- **Reset 2:** the first `afterEach` Reset.
- **later:** the remaining Resets.
- **late files:** the later Resets of each worker's last two files.
- **afterAll:** the `VACUUM` between files.

All times are ms, except suite, which is in seconds.

| W   | isolate | variant       | suite (rounds)            | file | Reset 1 | Reset 2 | later | late files | afterAll |
| --- | ------- | ------------- | ------------------------- | ---- | ------- | ------- | ----- | ---------- | -------- |
| 4   | true    | shipped       | 11.97 (11.93/11.97/12.13) | 1343 | 22.7    | 19.2    | 18.7  | 18.6       | 21.5     |
| 4   | true    | baseline-only | 12.40 (12.40/12.66/10.34) | 1391 | 45.8    | 20.3    | 19.9  | 20.3       | 10.4     |
| 4   | true    | none          | 10.53 (10.53/10.34/12.18) | 1388 | 47.5    | 24.7    | 20.4  | 21.2       | 0.1      |
| 4   | false   | shipped       | 6.47 (6.47/6.44/6.51)     | 684  | 5.5     | 17.3    | 18.5  | 18.4       | 17.9     |
| 4   | false   | baseline-only | 6.62 (6.62/6.50/6.74)     | 714  | 6.0     | 18.7    | 19.5  | 20.2       | 7.2      |
| 4   | false   | none          | 6.62 (6.62/6.55/6.65)     | 717  | 5.6     | 21.5    | 20.2  | 20.9       | 0.0      |
| 16  | true    | shipped       | 15.54 (16.15/14.85/15.54) | 1850 | 33.3    | 34.6    | 28.5  | 27.9       | 33.2     |
| 16  | true    | baseline-only | 14.87 (14.87/14.70/18.06) | 1884 | 67.0    | 35.1    | 29.6  | 29.8       | 15.2     |
| 16  | true    | none          | 18.19 (16.29/18.19/19.24) | 2144 | 71.5    | 48.0    | 35.9  | 44.3       | 0.1      |
| 16  | false   | shipped       | 10.08 (10.08/9.40/10.08)  | 1036 | 7.7     | 28.2    | 29.1  | 30.1       | 28.1     |
| 16  | false   | baseline-only | 9.50 (9.50/9.30/10.14)    | 1043 | 8.7     | 27.6    | 29.1  | 29.5       | 9.7      |
| 16  | false   | none          | 10.96 (10.96/11.03/10.78) | 1265 | 8.8     | 37.1    | 36.0  | 43.9       | 0.0      |

Between variants the whole-suite times fall within the spread of the rounds (one
`baseline-only` round at W = 4 took 10.34 s). The per-hook columns are the clean signal.

### The saving (`shipped`, `isolate: true` against `isolate: false`)

| W   | Suite                   | Per file       |
| --- | ----------------------- | -------------- |
| 4   | 11.97 → 6.47 s (−46 %)  | 1343 → 684 ms  |
| 16  | 15.54 → 10.08 s (−35 %) | 1850 → 1036 ms |

Most of the saving is the import and collection a file no longer repeats. The rest is the
first Reset of each file running on a warm backend: 22.7 → 5.5 ms at W = 4, 33.3 → 7.7 ms
at W = 16.

### Job (a): emptied heaps back to 0 bytes

- **Under `isolate: true` it pays.** It cuts the cold first Reset by 23 ms at W = 4
  (45.8 → 22.7) and by 34 ms at W = 16 (67.0 → 33.3), for 11 ms and 18 ms more `afterAll`.
  The net is about 12 ms and 16 ms per file, as amendment 2 found.
- **Under `isolate: false` this benchmark shows no benefit.** Reset 1 moves by 0.5–1 ms,
  the other Resets do not move, and the cost is the same 11 ms and 18 ms per file
  (1.5–2 % of a file).

### Job (b): the dead rows Baseline restores leave

- **It pays in both modes.** At W = 16, the late files' Resets go 44.3 → 29.8 ms
  (`isolate: true`) and 43.9 → 29.5 ms (`isolate: false`). The later Resets go
  35.9 → 29.6 and 36.0 → 29.1 ms. That saves about 7 ms × 20 Resets per file, against
  an `afterAll` of 10–15 ms.
- **At W = 4 the drift is small** (20.9 → 20.2 ms), and so is its cost (7–10 ms).
- **`isolate: false` does nothing about the drift**, as ADR 0002 predicted.

## Ruling: the `VACUUM` stays unconditional, both jobs, both modes

1. **Job (a)'s missing benefit under `isolate: false` comes from this benchmark, not from
   the mode.** Its files take about 1 s, so no pool backend ever idles out. In a real
   suite backends do idle out: `pg` closes an idle connection after 10 s by default, a
   file can have a long stretch with no database work, and a pool can be wider than the
   tests' concurrency. A backend that reconnects onto dirty heaps pays the cold cost from
   before #17 (about 90 ms at 73 tables, amendment 2) instead of about 25 ms. Job (a)
   insures against that, and the premium is 11–18 ms per file.
2. **Skipping it would cost more than it saves.** It would buy 1.5–2 % with a mode
   heuristic: a count of files begun, threaded from `opt-in.ts` through `database.ts` to
   a second probe variant. It would also add a documented "the first file on a worker
   behaves differently". The project keeps one code path for both modes.
3. **Job (b) pays in both modes.**

**The storage probe under `isolate: false`** (amendment 2, "Looking ahead") is settled by
arithmetic rather than a new measurement:

- The probe costs a warm Reset 1.7–1.9 ms.
- On the 1,900-test, 20-worker suite that motivated #17, that is about 3.4 s of server
  time spread over 20 workers: about 0.2 s of wall time.
- Against it, the opt-in saves 35–46 % of the suite, and the idle-backend argument above
  applies to the probe as well.

Not pursued; no follow-up.
