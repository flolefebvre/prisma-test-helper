// Measurement behind amendment 3 of docs/adr/0001 (issue #40, parent #22): what Vitest's
// `isolate: false` saves a suite against the default `isolate: true`, and what the
// `VACUUM` between files costs and buys in each mode. It runs real Vitest over a
// generated suite, through the repo's own container global setup, so it times what a
// consumer's run pays — imports, collection, the Reset, the hooks — and not a statement
// in isolation.
//
//   pnpm build && pnpm generate
//   node docs/plans/0022-isolate-false/measure-isolate.mjs
//
// Needs Docker. Not part of the gate. Everything is generated from the current `dist/`
// into a scratch directory (SCRATCH, default a fresh one under the OS temp dir) whose
// `node_modules` is a symlink to the repo's:
//
// - The project: the repo's own Prisma schema and migrations, plus one benchmark-only
//   migration of EXTRA_TABLES synthetic tables (default 67, which makes 73 tables like
//   the consumer suite of amendments 1 and 2; 0 runs the repo schema alone) in bench4's
//   shape — an FK chain, a primary key and 4 secondary indexes each. The global setup is
//   `createGlobalSetup` from `dist/`, with a `seed` that fills `Tag` with BASELINE_ROWS
//   rows (default 2000; ADR 0002's "one dirty, 2,000 rows"), which makes it a large
//   Baseline table.
// - The client module: shaped like tests/db/client.ts — the repo's generated Prisma client
//   behind `@prisma/adapter-pg`, built from DATABASE_URL at import — plus a synchronous
//   busy-wait of IMPORT_MS (default 300) at import, standing in for a real app's import
//   graph. Under `isolate: true` every file pays it, under `isolate: false` every worker.
// - The suite: FILES_PER_WORKER × W files (default 8 × W, as in ADR 0002's file runs) of
//   TESTS tests (default 20). A test writes an Author with a Post through the client,
//   one row into each of 8 synthetic tables (a different 8 per file), and updates one
//   `Tag` row, which dirties the Baseline so the next Reset restores it.
// - Three builds of the package, each a copy of `dist/` patched as text at run time
//   (nothing in the package is configurable for this):
//   - `shipped`: as built. The `afterAll` vacuums the dirty tables and every Baseline
//     table.
//   - `baseline-only`: the `afterAll` vacuums the Baseline tables only. Against
//     `shipped`, isolates job (a): returning emptied heaps to 0 bytes so a fresh
//     backend's storage probe skips them (amendment 2).
//   - `none`: no `afterAll` VACUUM. Against `baseline-only`, isolates job (b): clearing
//     the dead rows Baseline restores leave (ADR 0002).
//   All three carry the same instrumentation: `prepareReset`'s `reset()` and `vacuum()`
//   append their duration to a JSONL log.
//
// Every (W, mode, variant) cell runs ROUNDS times (default 3), interleaved: round 1 of
// every cell, then round 2, and so on. W is WORKERS (default "4,16"), the mode is
// `isolate: true` or `isolate: false` (MODES, default "true,false"), the variant VARIANTS
// (default "shipped,baseline-only,none"). Per cell it prints the medians over rounds of:
//
// - suite: the first file's start to the last file's end (global setup, the container
//   start included, is left out; forking between files is in);
// - file: one file, from its setup file to the end of its `afterAll` — the client import,
//   collection, its tests and hooks (median over files);
// - Reset 1 (`beforeAll`), Reset 2 (the first `afterEach`, often a new pool backend),
//   and the later Resets of a file, each the median over the run;
// - late: the later Resets of each worker's last two files, where dead rows pile up;
// - vacuum: the `afterAll`, probe and VACUUM.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const env = (name, fallback) => process.env[name] ?? fallback;
const WORKERS = env("WORKERS", "4,16").split(",").map(Number);
const MODES = env("MODES", "true,false").split(",");
const VARIANTS = env("VARIANTS", "shipped,baseline-only,none").split(",");
const ROUNDS = Number(env("ROUNDS", 3));
const FILES_PER_WORKER = Number(env("FILES_PER_WORKER", 8));
const TESTS = Number(env("TESTS", 20));
const EXTRA_TABLES = Number(env("EXTRA_TABLES", 67));
const BASELINE_ROWS = Number(env("BASELINE_ROWS", 2000));
const IMPORT_MS = Number(env("IMPORT_MS", 300));
const DIRTY_PER_TEST = Math.min(8, EXTRA_TABLES);

const scratch = env("SCRATCH", "") || mkdtempSync(path.join(tmpdir(), "ptl-0022-"));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const at = (...parts) => path.join(scratch, ...parts);
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// --- The project -------------------------------------------------------------------------

symlinkSync(path.join(repo, "node_modules"), at("node_modules"), "dir");
write(at("package.json"), JSON.stringify({ name: "bench-0022", private: true, type: "module" }));
cpSync(path.join(repo, "prisma"), at("prisma"), { recursive: true });
cpSync(path.join(repo, "prisma.config.ts"), at("prisma.config.ts"));

if (EXTRA_TABLES > 0) {
  // bench4's shape (docs/plans/0017-cold-reset/measure-cold.mjs), migrated after the repo's
  // own migrations. The FK column is nullable, so a test fills any table on its own.
  let sql = "";
  for (let i = 1; i <= EXTRA_TABLES; i++) {
    const fk = i > 1 ? `, parent_id int REFERENCES "b${i - 1}"(id)` : "";
    sql +=
      `CREATE TABLE "b${i}" (id serial PRIMARY KEY, name text NOT NULL, email text, slug text, ` +
      `amount numeric(10,2), created_at timestamptz DEFAULT now(), updated_at timestamptz${fk});\n` +
      `CREATE INDEX "b${i}_name_idx" ON "b${i}"(name);\n` +
      `CREATE UNIQUE INDEX "b${i}_email_key" ON "b${i}"(email);\n` +
      `CREATE INDEX "b${i}_created_idx" ON "b${i}"(created_at);\n` +
      (i > 1 ? `CREATE INDEX "b${i}_parent_idx" ON "b${i}"(parent_id);\n` : "");
  }
  write(at("prisma", "migrations", "29990101000000_bench_tables", "migration.sql"), sql);
}

// The repo's dist/global-setup.js, unpatched: the variants differ only in the worker side.
write(
  at("global-setup.mjs"),
  `import pg from "pg";
import { createGlobalSetup } from ${JSON.stringify(path.join(repo, "dist", "global-setup.js"))};

export default createGlobalSetup({
  async seed(databaseUrl) {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(
        'INSERT INTO "Tag" (name) SELECT \\'tag-\\' || g FROM generate_series(1, ${BASELINE_ROWS}) g',
      );
    } finally {
      await client.end();
    }
  },
});
`,
);

// One entry point per variant, picked by BENCH_DIST: the setup file and the test files
// must reach the same copy, so they share its module instances.
write(
  at("setup.mjs"),
  `import { appendFileSync } from "node:fs";

// A file's start, before its client module is imported: the setup file runs first.
const at = performance.timeOrigin + performance.now();
appendFileSync(process.env.BENCH_LOG, JSON.stringify({ kind: "begin", pid: process.pid, at }) + "\\n");
const { setupWorkerDatabase } = await import(process.env.BENCH_DIST + "/setup.js");
setupWorkerDatabase();
`,
);
write(
  at("harness.mjs"),
  `const library = await import(process.env.BENCH_DIST + "/index.js");
export const setupDatabase = library.setupDatabase;
`,
);
write(
  at("client.ts"),
  `import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from ${JSON.stringify(path.join(repo, "tests", "generated", "prisma", "client.ts"))};

// A real app's import graph, stood in for by ${IMPORT_MS} ms of synchronous work.
const until = performance.now() + ${IMPORT_MS};
while (performance.now() < until);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
`,
);

function testFile(index) {
  const tables = Array.from(
    { length: DIRTY_PER_TEST },
    (_, k) => `b${((index * DIRTY_PER_TEST + k) % EXTRA_TABLES) + 1}`,
  );
  return `import { expect, test } from "vitest";

import { db } from "../client.ts";
import { setupDatabase } from "../harness.mjs";

setupDatabase(db);

for (let t = 0; t < ${TESTS}; t++) {
  test("file ${index} test " + t, async () => {
    await db.author.create({ data: { name: "a", posts: { create: [{ title: "t" }] } } });
${tables
  .map(
    (t) =>
      `    await db.$executeRawUnsafe(${JSON.stringify(`INSERT INTO "${t}" (name) VALUES ('x')`)});`,
  )
  .join("\n")}
${
  BASELINE_ROWS > 0
    ? `    await db.$executeRawUnsafe('UPDATE "Tag" SET name = name || \\'.\\' WHERE id = ' + (1 + ((${index} * ${TESTS} + t) % ${BASELINE_ROWS})));`
    : ""
}
    expect(await db.author.count()).toBe(1);
  });
}
// writes ${tables.join(", ") || "no synthetic tables"}
`;
}

write(
  at("vitest.config.mjs"),
  `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    globalSetup: ["global-setup.mjs"],
    setupFiles: ["setup.mjs"],
    pool: "forks",
    isolate: process.env.BENCH_ISOLATE !== "false",
    maxWorkers: Number(process.env.BENCH_WORKERS),
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
`,
);

// --- The three builds --------------------------------------------------------------------

/** Replace `from` in `text`, refusing to go on if the build no longer contains it. */
function patch(text, from, to, what) {
  if (!text.includes(from))
    throw new Error(`cannot patch ${what}: ${JSON.stringify(from)} not found`);
  return text.replace(from, to);
}

const INSTRUMENT = `
import { appendFileSync as __append } from "node:fs";
const __prepareReset = prepareReset;
let __files = 0;
// Reassigns the module's own binding, which every importer (database.js) reads live.
prepareReset = async function (...args) {
  const prepared = await __prepareReset(...args);
  const file = ++__files;
  let n = 0;
  const log = (entry) =>
    __append(process.env.BENCH_LOG, JSON.stringify({ pool: process.env.VITEST_POOL_ID, pid: process.pid, file, at: performance.timeOrigin + performance.now(), ...entry }) + "\\n");
  return {
    async reset() {
      const started = performance.now();
      try { return await prepared.reset(); }
      finally { log({ kind: "reset", n: n++, ms: performance.now() - started }); }
    },
    async vacuum() {
      const started = performance.now();
      try { return await prepared.vacuum(); }
      finally { log({ kind: "vacuum", ms: performance.now() - started }); }
    },
  };
};
`;
const PROBE = "const vacuumProbe = buildVacuumProbe(tables, baseline);";
const VARIANT_PATCHES = {
  shipped: (text) => text,
  "baseline-only": (text) =>
    patch(text, PROBE, "const vacuumProbe = buildVacuumProbe([], baseline);", "baseline-only"),
  none: (text) => patch(text, PROBE, "const vacuumProbe = undefined;", "none"),
};
for (const variant of VARIANTS) {
  const dir = at(`dist-${variant}`);
  cpSync(path.join(repo, "dist"), dir, { recursive: true });
  const file = path.join(dir, "reset.js");
  writeFileSync(file, VARIANT_PATCHES[variant](readFileSync(file, "utf8")) + INSTRUMENT);
}

// --- The runs ----------------------------------------------------------------------------

const median = (values) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function run(workers, isolate, variant, round) {
  rmSync(at("tests"), { recursive: true, force: true });
  for (let i = 0; i < workers * FILES_PER_WORKER; i++) {
    write(at("tests", `f${String(i).padStart(3, "0")}.test.ts`), testFile(i));
  }
  const log = at(`log-${workers}-${isolate}-${variant}-${round}.jsonl`);
  const report = at(`report-${workers}-${isolate}-${variant}-${round}.json`);
  write(log, "");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: scratch,
      env: {
        ...process.env,
        BENCH_DIST: at(`dist-${variant}`),
        BENCH_LOG: log,
        BENCH_ISOLATE: isolate,
        BENCH_WORKERS: String(workers),
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `vitest failed (W=${workers} isolate=${isolate} ${variant}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  // Vitest's report confirms every file passed. Its per-file times start after
  // collection, so a file's time comes from the log instead: from its setup file (before
  // the client module is imported) to the end of its `afterAll` VACUUM, its last hook.
  const reported = JSON.parse(readFileSync(report, "utf8"));
  if (reported.numPassedTestSuites !== workers * FILES_PER_WORKER) {
    throw new Error(
      `expected ${workers * FILES_PER_WORKER} passing files, got ${reported.numPassedTestSuites}`,
    );
  }
  const entries = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  // Within one process files run one at a time: each `begin` pairs with the next VACUUM.
  const durations = [];
  for (const list of Map.groupBy(entries, (entry) => entry.pid).values()) {
    const times = (kind) =>
      list
        .filter((e) => e.kind === kind)
        .map((e) => e.at)
        .sort((a, b) => a - b);
    const begins = times("begin");
    const ends = times("vacuum");
    if (begins.length !== ends.length) throw new Error(`pid ${list[0].pid}: unpaired files`);
    begins.forEach((begin, i) => durations.push(ends[i] - begin));
  }

  // A file's Resets are those of one `prepareReset`, keyed (pid, file). Its worker is its
  // pool id; its position on that worker, the order the files started in.
  const byFile = new Map();
  for (const entry of entries.filter((e) => e.kind !== "begin")) {
    const key = `${entry.pid}:${entry.file}`;
    if (!byFile.has(key)) byFile.set(key, { pool: entry.pool, at: entry.at, entries: [] });
    byFile.get(key).entries.push(entry);
  }
  const late = [];
  for (const list of Map.groupBy(byFile.values(), (file) => file.pool).values()) {
    list.sort((a, b) => a.at - b.at);
    for (const file of list.slice(-2)) {
      late.push(...file.entries.filter((e) => e.kind === "reset" && e.n >= 2).map((e) => e.ms));
    }
  }
  const resets = (filter) =>
    entries.filter((e) => e.kind === "reset" && filter(e.n)).map((e) => e.ms);
  return {
    suite: Math.max(...entries.map((e) => e.at)) - Math.min(...entries.map((e) => e.at)),
    file: median(durations),
    reset1: median(resets((n) => n === 0)),
    reset2: median(resets((n) => n === 1)),
    later: median(resets((n) => n >= 2)),
    late: median(late),
    vacuum: median(entries.filter((e) => e.kind === "vacuum").map((e) => e.ms)),
  };
}

const cells = [];
for (const workers of WORKERS) {
  for (const isolate of MODES) {
    for (const variant of VARIANTS) cells.push({ workers, isolate, variant, rounds: [] });
  }
}
const started = Date.now();
for (let round = 1; round <= ROUNDS; round++) {
  for (const cell of cells) {
    cell.rounds.push(run(cell.workers, cell.isolate, cell.variant, round));
    process.stderr.write(
      `round ${round} W=${cell.workers} isolate=${cell.isolate} ${cell.variant}: ` +
        `${Math.round(cell.rounds.at(-1).suite)} ms suite\n`,
    );
  }
}

const fmt = (value, digits = 1) => (Number.isNaN(value) ? "—" : value.toFixed(digits));
console.log(
  `\n${FILES_PER_WORKER} files per worker × ${TESTS} tests, ${EXTRA_TABLES} extra tables, ` +
    `Baseline ${BASELINE_ROWS} rows, import ${IMPORT_MS} ms, ${ROUNDS} rounds, ` +
    `${Math.round((Date.now() - started) / 1000)} s. Medians over rounds; ` +
    "suite in s (each round's in brackets), the rest in ms.\n",
);
console.log(
  "| W | isolate | variant | suite (rounds) | file | Reset 1 | Reset 2 | later Resets | late files | afterAll |",
);
console.log("| - | - | - | - | - | - | - | - | - | - |");
for (const { workers, isolate, variant, rounds } of cells) {
  const m = (key) => median(rounds.map((r) => r[key]));
  console.log(
    `| ${workers} | ${isolate} | ${variant} | ${fmt(m("suite") / 1000, 2)} (${rounds
      .map((r) => fmt(r.suite / 1000, 2))
      .join(" / ")}) | ${fmt(m("file"), 0)} | ${fmt(m("reset1"))} | ${fmt(m("reset2"))} | ` +
      `${fmt(m("later"))} | ${fmt(m("late"))} | ${fmt(m("vacuum"))} |`,
  );
}
if (!process.env.SCRATCH) rmSync(scratch, { recursive: true, force: true });
