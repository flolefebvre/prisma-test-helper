// Measurement behind docs/adr/0002-baseline-restore.md (issue #38): what the Reset costs
// with a Baseline, against the Reset before Baselines existed. It drives the package's
// own build — the install builders of dist/baseline.js, sent in the order global setup
// sends them, and prepareReset from dist/reset.js — so it times exactly the statements
// the package emits. `pnpm build` first. RESET_JS points the `before` scenario at the
// Reset before this change, compiled on its own (src/reset.ts as of a113c12, which has
// no imports):
//
//   git -C <repo> show a113c12:src/reset.ts > old/reset.ts
//   <repo>/node_modules/.bin/tsc --target es2022 --module nodenext \
//     --moduleResolution nodenext --outDir old old/reset.ts
//
// The container mirrors the one `createGlobalSetup` runs (as in docs/adr/0001-bench/):
//
//   docker run -d --rm --name bench -p 5433:5432 \
//     -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bench \
//     -e PGDATA=/var/lib/postgresql/data/pgdata --tmpfs /var/lib/postgresql/data \
//     postgres:18-alpine -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
//     -c max_connections=200
//
//   RESET_JS=$PWD/old/reset.js node measure-baseline.mjs <port> <workers> [section...]
//
// Run it from the repo (it imports `pg` and `../../../dist/*.js`). Sections, all by
// default:
//
// - warm: one backend per Worker Database, W of them driven at once. A "test" writes 10
//   rows into 8 of the 72 ordinary tables, then the Reset is timed. Scenarios:
//   `before` (the old Reset, on a template without the harness schema), `none` (no
//   Baseline: the harness schema is installed, empty), `untouched-R` (5 Baseline lookup
//   tables of R rows each, which the test never writes) and `dirty-R` (the same, and
//   the test also updates one row of one lookup table). R = 20, 200, 2000. Interleaved
//   ROUNDS times, so run-to-run noise shows.
//   Every scenario of every round starts on fresh clones.
// - cold: the Reset as the first statement on a new backend, after the same test.
// - files: FILES files of TESTS tests (8 × 50) per Worker Database, W at once, with the
//   afterAll between files either `probed` (the VACUUM between files before Baselines)
//   or `shipped` (the package's vacuum(), which adds every Baseline table): the median
//   Reset of each file, and of the afterAll. Decides the VACUUM between files.
// - drift: `dirty-2000` for DRIFT Resets on one backend — one long file — without a
//   VACUUM: the median of the first and the last 50, the restored table's heap size,
//   then the cost of a `VACUUM` of the Baseline tables and the median after it.
// - trigger: what tracking costs a test. 1000 single-row UPDATEs of a Baseline table
//   (trigger: SECURITY DEFINER, pinned search_path) against the same on an identical
//   table without a trigger, interleaved, on one backend.
import { performance } from "node:perf_hooks";
import pg from "pg";

const dist = (file) => new URL(`../../../dist/${file}`, import.meta.url).href;
const baseline = await import(dist("baseline.js"));
const shipped = await import(dist("reset.js"));
const old = process.env.RESET_JS ? await import(process.env.RESET_JS) : undefined;

const port = process.argv[2];
const WORKERS = Number(process.argv[3] ?? 1);
const SECTIONS = process.argv.slice(4).length
  ? process.argv.slice(4)
  : ["warm", "cold", "files", "drift", "trigger"];
const TABLES = 72; // ordinary tables, plus one partitioned parent, as in bench4
const LOOKUPS = 5; // Baseline tables
const WARM = Number(process.env.WARM ?? 200);
const COLD = Number(process.env.COLD ?? 12);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const DRIFT = Number(process.env.DRIFT ?? 400);
const SIZES = [20, 200, 2000];

const url = (db) => `postgresql://test:test@127.0.0.1:${port}/${db}`;
const admin = new pg.Client({ connectionString: url("bench") });
await admin.connect();

// --- Templates --------------------------------------------------------------------------

// bench4's generated shape: an FK chain of ordinary tables with 4 secondary indexes each,
// and a partitioned parent — plus, when `rows` is set, LOOKUPS lookup tables filled with
// that many rows, which become the Baseline.
function schema(rows) {
  let ddl = "CREATE TABLE _prisma_migrations (id text PRIMARY KEY, name text);";
  for (let i = 1; i <= TABLES; i++) {
    const fk = i > 1 ? `, parent_id int REFERENCES t${i - 1}(id)` : "";
    ddl += `CREATE TABLE t${i} (id serial PRIMARY KEY, name text NOT NULL, email text, slug text, created_at timestamptz DEFAULT now()${fk});`;
    ddl += `CREATE INDEX ON t${i}(name); CREATE UNIQUE INDEX ON t${i}(email); CREATE INDEX ON t${i}(created_at); CREATE UNIQUE INDEX ON t${i}(slug);`;
  }
  ddl +=
    "CREATE TABLE event (id bigserial, at date NOT NULL, payload text) PARTITION BY RANGE (at);";
  ddl +=
    "CREATE TABLE event_old PARTITION OF event FOR VALUES FROM ('2000-01-01') TO ('2026-01-01');";
  ddl +=
    "CREATE TABLE event_new PARTITION OF event FOR VALUES FROM ('2026-01-01') TO ('2100-01-01');";
  for (let i = 1; i <= LOOKUPS; i++) {
    ddl += `CREATE TABLE lookup${i} (id serial PRIMARY KEY, code text NOT NULL UNIQUE, label text NOT NULL, rank int);`;
    if (rows) {
      ddl += `INSERT INTO lookup${i} (code, label, rank) SELECT 'c' || g, md5(g::text), g FROM generate_series(1, ${rows}) g;`;
    }
  }
  // The trigger section's control: a lookup table's twin, outside the Baseline because
  // it is empty after migrate.
  ddl +=
    "CREATE TABLE untracked (id serial PRIMARY KEY, code text NOT NULL UNIQUE, label text NOT NULL, rank int);";
  return ddl;
}

// Global setup's install, step for step (src/global-setup.ts, installBaseline).
async function install(c) {
  await c.query(baseline.HARNESS_SCHEMA_STATEMENT);
  const candidates = (await c.query(baseline.BASELINE_CANDIDATES_QUERY)).rows;
  const query = baseline.nonEmptyTablesQuery(candidates.filter((x) => x.kind === "table"));
  const nonEmpty = query ? (await c.query(query)).rows.map((r) => r.index) : [];
  const statement = baseline.snapshotStatement(baseline.planBaseline(candidates, nonEmpty));
  if (statement) await c.query(statement);
}

async function template(name, { rows, harness }) {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  const c = new pg.Client({ connectionString: url(name) });
  await c.connect();
  await c.query(schema(rows));
  if (harness) await install(c);
  await c.end();
}

async function clone(tpl, w) {
  await admin.query(`DROP DATABASE IF EXISTS ${tpl}_${w} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${tpl}_${w} TEMPLATE ${tpl}`);
}

// --- Scenarios --------------------------------------------------------------------------

const scenarios = [
  { name: "before", tpl: "b_old", build: old, dirty: false },
  { name: "none", tpl: "b_none", build: shipped, dirty: false },
  ...SIZES.flatMap((r) => [
    { name: `untouched-${r}`, tpl: `b_${r}`, build: shipped, dirty: false },
    { name: `dirty-${r}`, tpl: `b_${r}`, build: shipped, dirty: true },
  ]),
].filter((s) => s.build !== undefined);

// A test: 10 rows into 8 tables spread over the chain, in one round trip — and, when
// `dirty`, one row of one Baseline table updated.
const TEST_TABLES = [3, 11, 19, 27, 35, 43, 51, 59];
const testWrites = (dirty) =>
  "BEGIN; SET LOCAL session_replication_role = replica; " +
  TEST_TABLES.map(
    (i) =>
      `INSERT INTO t${i} (name, email, slug) SELECT 'n' || g, md5(random()::text || g), md5(random()::text || g) FROM generate_series(1, 10) g;`,
  ).join(" ") +
  " COMMIT;" +
  // Outside the replica block: the tracking trigger must fire, as in a real test.
  (dirty ? " UPDATE lookup1 SET label = label || 'x' WHERE id = 1;" : "");

const shim = (c) => ({
  $queryRawUnsafe: async (q) => (await c.query(q)).rows,
  $executeRawUnsafe: async (q) => (await c.query(q)).rowCount,
});

async function connect(db) {
  const c = new pg.Client({ connectionString: url(db) });
  await c.connect();
  await c.query("SELECT 1"); // connecting stays out of the timing
  return c;
}
const eachWorker = (fn) => Promise.all(Array.from({ length: WORKERS }, (_, i) => fn(i + 1)));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const f = (x) => x.toFixed(2).padStart(7);
async function timed(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

// --- Sections ---------------------------------------------------------------------------

async function warm(s) {
  const samples = [];
  await eachWorker(async (w) => {
    const db = `${s.tpl}_${w}`;
    const c = await connect(db);
    const { reset } = await s.build.prepareReset(shim(c), url(db), s.tpl);
    await reset();
    for (let i = 0; i < 20; i++) {
      await c.query(testWrites(s.dirty));
      await reset();
    }
    for (let i = 0; i < WARM; i++) {
      await c.query(testWrites(s.dirty));
      samples.push(await timed(reset));
    }
    await c.end();
  });
  return median(samples);
}

async function cold(s) {
  const samples = [];
  await eachWorker(async (w) => {
    const db = `${s.tpl}_${w}`;
    const statement = await builtStatement(s, db);
    for (let i = 0; i < COLD; i++) {
      // The test writes on one backend; the Reset is the first statement on another.
      const writer = await connect(db);
      await writer.query(testWrites(s.dirty));
      await writer.end();
      const c = await connect(db);
      samples.push(await timed(() => c.query(statement)));
      await c.end();
    }
  });
  return median(samples);
}

// The statement prepareReset builds for `db`, read off a client that records it.
async function builtStatement(s, db) {
  const d = await connect(db);
  let statement;
  const recorder = {
    $queryRawUnsafe: async (q) => (await d.query(q)).rows,
    $executeRawUnsafe: async (q) => {
      statement = q;
      return 0;
    },
  };
  const { reset } = await s.build.prepareReset(recorder, url(db), s.tpl);
  await reset();
  await d.end();
  return statement;
}

const heap = async (c, table) =>
  (await c.query(`SELECT pg_relation_size('${table}')::int AS size`)).rows[0].size;

async function drift() {
  const s = scenarios.find((x) => x.name === "dirty-2000");
  const db = `${s.tpl}_1`;
  await clone(s.tpl, 1);
  const c = await connect(db);
  const { reset } = await s.build.prepareReset(shim(c), url(db), s.tpl);
  await reset();
  const samples = [];
  const heapBefore = await heap(c, "lookup1");
  for (let i = 0; i < DRIFT; i++) {
    await c.query(testWrites(true));
    samples.push(await timed(reset));
  }
  const heapAfter = await heap(c, "lookup1");
  const lookups = Array.from({ length: LOOKUPS }, (_, i) => `lookup${i + 1}`).join(", ");
  const vacuum = await timed(() => c.query(`VACUUM (SKIP_LOCKED) ${lookups}`));
  const heapVacuumed = await heap(c, "lookup1");
  const after = [];
  for (let i = 0; i < 50; i++) {
    await c.query(testWrites(true));
    after.push(await timed(reset));
  }
  await c.end();
  console.log(
    `\ndrift, dirty-2000, one backend, ${DRIFT} Resets without a VACUUM:` +
      `\n  median of the first 50 ${f(median(samples.slice(0, 50)))} ms, of the last 50 ${f(median(samples.slice(-50)))} ms` +
      `\n  lookup1 heap ${heapBefore} -> ${heapAfter} bytes; VACUUM of the ${LOOKUPS} Baseline tables ${f(vacuum)} ms, heap then ${heapVacuumed}` +
      `\n  median of 50 Resets after that VACUUM ${f(median(after))} ms`,
  );
}

// A run of FILES files of TESTS tests on every Worker Database at once, each worker on
// its own fresh clone, with the afterAll between files run one of two ways: `probed`,
// the VACUUM between files before Baselines (the probed tables only, Baseline tables
// left alone), or `shipped`, the package's own vacuum(), which adds every Baseline
// table. Prints the median Reset of each file, and the median afterAll.
const FILES = Number(process.env.FILES ?? 8);
const TESTS = Number(process.env.TESTS ?? 50);
async function files(s, variant) {
  for (let w = 1; w <= WORKERS; w++) await clone(s.tpl, w);
  const perFile = Array.from({ length: FILES }, () => []);
  const afterAlls = [];
  await eachWorker(async (w) => {
    const db = `${s.tpl}_${w}`;
    const c = await connect(db);
    const { reset, vacuum } = await s.build.prepareReset(shim(c), url(db), s.tpl);
    const probedOnly = await probedVacuum(c);
    for (let file = 0; file < FILES; file++) {
      await reset();
      for (let i = 0; i < TESTS; i++) {
        await c.query(testWrites(s.dirty));
        perFile[file].push(await timed(reset));
      }
      afterAlls.push(await timed(variant === "shipped" ? vacuum : probedOnly));
    }
    await c.end();
  });
  console.log(
    `  ${s.name.padEnd(16)} ${variant.padEnd(8)} ${perFile.map((xs) => f(median(xs))).join(" ")}` +
      `   afterAll ${f(median(afterAlls))}`,
  );
}

// The afterAll before Baselines: probe and VACUUM the non-Baseline tables only.
async function probedVacuum(c) {
  const rows = (await c.query(shipped.DISCOVERY_QUERY)).rows;
  const tables = rows
    .filter((r) => r.kind === "table" && r.ordinal === null)
    .map(({ schema, name, relkind }) => ({ schema, name, relkind }));
  const probe = shipped.buildVacuumProbe(tables);
  return async () => {
    const dirty = (await c.query(probe)).rows.map((r) => r.name);
    if (dirty.length) await c.query(`VACUUM (SKIP_LOCKED) ${dirty.join(", ")}`);
  };
}

async function trigger() {
  const db = "b_200_1";
  await clone("b_200", 1);
  const c = await connect(db);
  await c.query("INSERT INTO untracked (code, label, rank) SELECT code, label, rank FROM lookup1");
  const times = { tracked: [], untracked: [] };
  for (let round = 0; round < 5; round++) {
    for (const table of ["lookup1", "untracked"]) {
      const t0 = performance.now();
      for (let i = 1; i <= 1000; i++) {
        await c.query(`UPDATE ${table} SET rank = rank + 1 WHERE id = ${(i % 200) + 1}`);
      }
      times[table === "lookup1" ? "tracked" : "untracked"].push((performance.now() - t0) / 1000);
    }
  }
  await c.end();
  const t = median(times.tracked);
  const u = median(times.untracked);
  console.log(
    `\ntrigger, one backend, median of 5 rounds of 1000 single-row UPDATEs, per statement:` +
      `\n  tracked ${f(t)} ms, untracked ${f(u)} ms, tracking costs ${f((t - u) * 1000)} µs`,
  );
}

// --- Run ----------------------------------------------------------------------------------

await template("b_old", { rows: 0, harness: false });
await template("b_none", { rows: 0, harness: true });
for (const r of SIZES) await template(`b_${r}`, { rows: r, harness: true });

// Every scenario of every round starts on fresh clones: restores leave dead rows, and
// with no VACUUM between rounds a dirty scenario would inherit the last one's heap.
const freshClones = async (s) => {
  for (let w = 1; w <= WORKERS; w++) await clone(s.tpl, w);
};
for (const section of ["warm", "cold"].filter((x) => SECTIONS.includes(x))) {
  const rounds = section === "warm" ? ROUNDS : 1;
  console.log(
    `\n${section} Reset, W = ${WORKERS}, median ms` +
      (section === "warm"
        ? ` of ${WARM} per worker, ${rounds} interleaved rounds`
        : ` of ${COLD} per worker`),
  );
  const results = new Map(scenarios.map((s) => [s.name, []]));
  for (let round = 0; round < rounds; round++) {
    for (const s of scenarios) {
      await freshClones(s);
      results.get(s.name).push(await (section === "warm" ? warm(s) : cold(s)));
    }
  }
  for (const [name, values] of results)
    console.log(`  ${name.padEnd(16)} ${values.map(f).join(" ")}`);
}
if (SECTIONS.includes("files")) {
  console.log(
    `\nfiles, W = ${WORKERS}, ${FILES} files of ${TESTS} tests, median Reset ms per file, ` +
      "then the median afterAll",
  );
  for (const name of ["none", "untouched-20", "untouched-200", "dirty-200", "dirty-2000"]) {
    const s = scenarios.find((x) => x.name === name);
    for (const variant of ["probed", "shipped"]) await files(s, variant);
  }
}
if (SECTIONS.includes("drift")) await drift();
if (SECTIONS.includes("trigger")) await trigger();
await admin.end();
