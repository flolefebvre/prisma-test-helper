// Benchmark behind amendment 2 in docs/adr/0001-commit-and-reset-instead-of-rollback.md
// (issue #17): what the first Reset on a fresh Postgres backend costs, and whether gating
// each table's DELETE on its heap file being nonzero — plus a VACUUM between files that
// returns heaps to 0 bytes — makes a test file cheaper. Grown from the review's scratch
// scripts in docs/plans/0017-cold-reset/.
//
// Same container as bench.mjs (see its header), but `postgres:18-alpine`, and the same
// scratch directory with only `pg` installed. `shipped` is built by dist/reset.js, so
// `pnpm build` first (RESET_JS points it at another build):
//
//   node bench4.mjs <port> <workers> [cold samples per worker] [variant...]
//   node bench4.mjs 5433 1 12 && node bench4.mjs 5433 20 6
//
// Variants: `shipped` (whatever RESET_JS builds), `probe_regclass` (the probe-gated block,
// relations resolved by name with to_regclass at Reset time) and `probe_oid` (the same,
// resolved from the OIDs discovery returned). The probe variants are written inline, as
// they were measured before the package built them; PROBE_JS points `probe_regclass` at
// a build that does (the package since #17), so it runs that build's own Reset statement
// and vacuum probe. Amendment 2's numbers compare the pre-#17 package against the
// package as it now ships:
//
//   git show ad46371:src/reset.ts > old/reset.ts && tsc --target es2022 \
//     --module nodenext --moduleResolution nodenext --outDir old old/reset.ts
//   RESET_JS=$PWD/old/reset.js PROBE_JS=<repo>/dist/reset.js node bench4.mjs 5433 1 12
//
// Environment:
//
//   TABLES=73      tables in the generated schema, one of them a partitioned parent
//   INDEXES=4      secondary indexes per generated table (the primary key comes on top)
//   SCHEMA_SQL=f   replay a real schema instead (`prisma migrate diff --script` output)
//   WARM=40        warm Resets per worker
//   SECTIONS=…     comma-separated subset of cold,warm,afterall,lock (default: all); the
//                  per-file sums need cold and afterall, lock runs on worker 1 only
//
// Repeating a variant on the command line runs it again in the same process, which is
// how the warm run-to-run noise was read: `SECTIONS=warm node bench4.mjs 5433 20 1
// shipped probe_regclass probe_oid shipped probe_regclass probe_oid`.
//
// What it measures, for W Worker Databases cloned from one template and driven at once:
//
// - Cold: the Reset as the first statement on a new backend (connect and one `SELECT 1`
//   excluded from the timing), in four states — pristine clone; mid-file, 8 tables
//   written and emptied; late in a run with no VACUUM ever, every writable table
//   written and emptied; and that late state after a VACUUM of the dirty tables.
// - Warm: one backend, a test's writes (10 rows into 8 tables) between Resets.
// - afterAll: the probe query plus `VACUUM (SKIP_LOCKED)` of the tables it returns, on a
//   warm backend, for 8 and for every writable table, checking that heaps return to 0.
//   The probe returns nothing while another client session of the database has a
//   transaction open (see the leaked-lock section for why).
// - Leaked lock: the afterAll while another session holds a lock on a dirty table,
//   with and without that guard.
// - Per file: two cold Resets (the `beforeAll` and the first `afterEach`, each possibly
//   on a new pool backend) plus the afterAll, which only the probe variants pay.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import pg from "pg";

const { buildResetStatement, DISCOVERY_QUERY } = await import(
  process.env.RESET_JS ?? new URL("../../../dist/reset.js", import.meta.url).href
);
// A probe-gated build, standing in for the inline `probe_regclass` (see the header).
const built = process.env.PROBE_JS ? await import(process.env.PROBE_JS) : undefined;

const port = process.argv[2];
const WORKERS = Number(process.argv[3] ?? 1);
const COLD = Number(process.argv[4] ?? 12);
const VARIANTS = process.argv.slice(5).length
  ? process.argv.slice(5)
  : ["shipped", "probe_regclass", "probe_oid"];
const TABLES = Number(process.env.TABLES ?? 73);
const INDEXES = Number(process.env.INDEXES ?? 4);
const WARM = Number(process.env.WARM ?? 40); // warm Resets per worker
const DIRTY = 8; // tables a test, and a short file, writes to
const ROWS = 10; // rows per written table
const VACUUM_SAMPLES = 5;
const SECTIONS = (process.env.SECTIONS ?? "cold,warm,afterall,lock").split(",");

const url = (db) => `postgresql://test:test@127.0.0.1:${port}/${db}`;
const admin = new pg.Client({ connectionString: url("bench") });
await admin.connect();

// --- The schema -------------------------------------------------------------------------

// Generated: TABLES - 1 ordinary tables in an FK chain, each with a primary key and
// INDEXES secondary indexes, plus one partitioned parent with two partitions.
function generatedSchema() {
  const ordinary = TABLES - 1;
  const names = Array.from({ length: ordinary }, (_, i) => `t${i + 1}`);
  let ddl = `CREATE TABLE _prisma_migrations (id text PRIMARY KEY, name text);`;
  names.forEach((n, i) => {
    const fk = i > 0 ? `, parent_id int REFERENCES "${names[i - 1]}"(id)` : "";
    ddl += `CREATE TABLE "${n}" (id serial PRIMARY KEY, name text NOT NULL, email text, slug text, amount numeric(10,2), created_at timestamptz DEFAULT now(), updated_at timestamptz${fk});`;
    const indexes = [
      ...(i > 0 ? [`CREATE INDEX ON "${n}"(parent_id)`] : []),
      `CREATE INDEX ON "${n}"(name)`,
      `CREATE UNIQUE INDEX ON "${n}"(email)`,
      `CREATE INDEX ON "${n}"(created_at)`,
      `CREATE UNIQUE INDEX ON "${n}"(slug)`,
      `CREATE INDEX ON "${n}"(amount)`,
      `CREATE INDEX ON "${n}"(updated_at)`,
      `CREATE INDEX ON "${n}"(name, created_at)`,
    ];
    ddl += indexes.slice(0, INDEXES).join(";") + ";";
  });
  ddl += `CREATE TABLE event (id bigserial, at date NOT NULL, payload text) PARTITION BY RANGE (at);`;
  ddl += `CREATE TABLE event_old PARTITION OF event FOR VALUES FROM ('2000-01-01') TO ('2026-01-01');`;
  ddl += `CREATE TABLE event_new PARTITION OF event FOR VALUES FROM ('2026-01-01') TO ('2100-01-01');`;
  ddl += `CREATE INDEX ON event(at);`;
  return ddl;
}

async function setupTemplate() {
  await admin.query("DROP DATABASE IF EXISTS tpl WITH (FORCE)");
  await admin.query("CREATE DATABASE tpl");
  const c = new pg.Client({ connectionString: url("tpl") });
  await c.connect();
  await c.query(
    process.env.SCHEMA_SQL ? readFileSync(process.env.SCHEMA_SQL, "utf8") : generatedSchema(),
  );
  await c.end();
}

async function recreate(w) {
  await admin.query(`DROP DATABASE IF EXISTS tpl_${w} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE tpl_${w} TEMPLATE tpl`);
}
// One clone at a time: CREATE DATABASE … TEMPLATE serialises on the template anyway.
async function recreateAll() {
  for (let w = 1; w <= WORKERS; w++) await recreate(w);
}

// --- Discovery and the statements -------------------------------------------------------

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const qualified = (r) => `${quote(r.schema)}.${quote(r.name)}`;

// The package's own discovery, plus each table's relkind and OID — the same in every
// clone of the template.
async function discover(c) {
  const rels = (await c.query(DISCOVERY_QUERY)).rows;
  const extra = new Map(
    (
      await c.query(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind, c.oid::int AS oid
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p')`,
      )
    ).rows.map((r) => [`${r.schema}.${r.name}`, r]),
  );
  const tables = rels
    .filter((r) => r.kind === "table")
    .map((r) => ({ ...r, ...extra.get(`${r.schema}.${r.name}`) }));
  const sequences = rels
    .filter((r) => r.kind === "sequence")
    .map((r) => ({ schema: r.schema, name: r.name, startValue: r.start_value }));
  return { tables, sequences };
}

// The probe predicate over `t.rel`: a NULL or missing size counts as dirty.
const DIRTY_PREDICATE =
  "coalesce((pg_catalog.pg_stat_file(pg_catalog.pg_relation_filepath(t.rel), true)).size, 1) > 0";

// How each probe variant names its candidates: text resolved at Reset time, or OIDs.
const candidates = {
  probe_regclass: (tables) =>
    `ARRAY[${tables.map((t) => `pg_catalog.to_regclass(${literal(qualified(t))})`).join(", ")}]`,
  probe_oid: (tables) => `ARRAY[${tables.map((t) => t.oid).join(", ")}]::pg_catalog.regclass[]`,
};

function probeStatement(variant, { tables, sequences }) {
  const probed = tables.filter((t) => t.relkind !== "p");
  const always = tables.filter((t) => t.relkind === "p");
  const fragment = (t, i) => `d${i} AS (DELETE FROM ${qualified(t)})`;
  const fragments = `ARRAY[${probed.map((t, i) => literal(fragment(t, i))).join(", ")}]::text[]`;
  const unconditional = always.map((t, i) => fragment(t, probed.length + i));
  const rewinds = sequences.map(
    (s) => `pg_catalog.setval(${literal(qualified(s))}::regclass, ${s.startValue}, false)`,
  );
  const tail = `${unconditional.length ? unconditional.join(", ") + " " : ""}SELECT ${rewinds.join(", ") || "1"}`;
  return `DO $reset$
DECLARE deletes text;
BEGIN
  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);
  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  SELECT string_agg(t.fragment, ', ') INTO deletes
  FROM unnest(${candidates[variant](probed)}, ${fragments}) AS t(rel, fragment)
  WHERE ${DIRTY_PREDICATE};
  EXECUTE ${
    unconditional.length
      ? `'WITH ' || coalesce(deletes || ', ', '') || $reset_sql$${tail}$reset_sql$`
      : `coalesce('WITH ' || deletes || ' ', '') || $reset_sql$${tail}$reset_sql$`
  };
END
$reset$`;
}

// No other client session of this database is inside a transaction: one that is might
// hold a lock VACUUM's truncation waits about 5 s on (see the leaked-lock section).
const NO_OPEN_TRANSACTION = `NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_stat_activity a
  WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid()
    AND a.backend_type = 'client backend' AND a.xact_start IS NOT NULL)`;

// The afterAll's probe: the quoted names of the probed tables whose heap is nonzero, or
// none while another session has a transaction open.
function vacuumProbe(variant, { tables }, guarded = true) {
  if (built && guarded && variant === "probe_regclass") return built.buildVacuumProbe(tables);
  const probed = tables.filter((t) => t.relkind !== "p");
  const names = `ARRAY[${probed.map((t) => literal(qualified(t))).join(", ")}]::text[]`;
  return (
    `SELECT t.name FROM unnest(${candidates[variant](probed)}, ${names}) AS t(rel, name) WHERE ${DIRTY_PREDICATE}` +
    (guarded ? ` AND ${NO_OPEN_TRANSACTION}` : "")
  );
}

// --- Writes -----------------------------------------------------------------------------

// A generic row for any table: a value for every NOT NULL column without a default, by
// type category. FK checks are off (replica), as the Reset's own are, so a real schema's
// foreign keys need no parent rows. Tables no expression fits are left out of the
// writable set.
async function writableInserts(c, tables) {
  const inserts = new Map();
  for (const t of tables) {
    const cols = (
      await c.query(
        `SELECT quote_ident(a.attname) AS col, format_type(a.atttypid, a.atttypmod) AS typ,
                ty.typcategory AS cat, ty.typtype, ty.typname
         FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
           AND NOT a.atthasdef AND a.attidentity = '' AND a.attgenerated = ''`,
        [qualified(t)],
      )
    ).rows;
    const expr = ({ typ, cat, typtype, typname }) => {
      if (typtype === "e") return `(enum_range(NULL::${typ}))[1]`;
      if (cat === "A") return `'{}'::${typ}`;
      if (cat === "B") return "true";
      if (cat === "D") return `now()::${typ}`;
      if (cat === "T") return `'1 day'::${typ}`;
      if (cat === "N") return `g::${typ}`;
      if (cat === "S") return `md5(random()::text || g)::${typ}`;
      if (typname === "uuid") return "gen_random_uuid()";
      if (typname === "json" || typname === "jsonb") return `'{}'::${typ}`;
      if (typname === "bytea") return `'\\x00'::bytea`;
      return null;
    };
    const exprs = cols.map(expr);
    if (exprs.includes(null)) continue;
    const insert = (rows) =>
      cols.length
        ? `INSERT INTO ${qualified(t)} (${cols.map((x) => x.col).join(", ")}) SELECT ${exprs.join(", ")} FROM generate_series(1, ${rows}) g;`
        : `INSERT INTO ${qualified(t)} SELECT FROM generate_series(1, ${rows}) g;`;
    for (const rows of [ROWS, 1]) {
      try {
        await c.query("BEGIN; SET LOCAL session_replication_role = replica;");
        await c.query(insert(rows));
        await c.query("ROLLBACK");
        inserts.set(qualified(t), insert(rows));
        break;
      } catch {
        await c.query("ROLLBACK");
      }
    }
  }
  return inserts;
}

const write = (c, sql) =>
  c.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql} COMMIT;`);

// --- Measurement helpers ----------------------------------------------------------------

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: q(0.5), p95: q(0.95) };
}
const f = (x) => x.toFixed(1).padStart(6);
const pad = (s, n) => String(s).padEnd(n);

async function connect(w) {
  const c = new pg.Client({ connectionString: url(`tpl_${w}`) });
  await c.connect();
  await c.query("SELECT 1"); // connection and authentication stay out of the timing
  return c;
}
async function time(c, sql) {
  const t0 = performance.now();
  await c.query(sql);
  return performance.now() - t0;
}
const eachWorker = (fn) => Promise.all(Array.from({ length: WORKERS }, (_, i) => fn(i + 1)));

// Heaps of probed tables still nonzero, read without touching the relcache.
async function nonzero(w, ctx) {
  const c = await connect(w);
  const { rows } = await c.query(vacuumProbe("probe_regclass", ctx, false));
  await c.end();
  return rows.length;
}

// --- The states -------------------------------------------------------------------------

let dirtyTables; // the writable tables, in a fixed order
const dirtySet = (k, n = DIRTY) =>
  Array.from(
    { length: Math.min(n, dirtyTables.length) },
    (_, i) => dirtyTables[(k * 3 + i * 7) % dirtyTables.length],
  );

// The afterAll as the harness would run it: probe, then VACUUM what it returned.
async function vacuumDirty(c, variant, ctx, guarded = true) {
  const dirty = (await c.query(vacuumProbe(variant, ctx, guarded))).rows.map((r) => r.name);
  if (dirty.length) await c.query(`VACUUM (SKIP_LOCKED) ${dirty.join(", ")}`);
  return dirty.length;
}

// Put every Worker Database in `state`, through a backend that is closed afterwards.
async function prepare(state, ctx, shipped) {
  await recreateAll();
  if (state === "pristine") return;
  await eachWorker(async (w) => {
    const c = await connect(w);
    const tables = state === "mid-file" ? dirtySet(0) : dirtyTables;
    await write(c, tables.map((t) => ctx.inserts.get(t)).join(""));
    await c.query(shipped);
    if (state === "after VACUUM") await vacuumDirty(c, "probe_regclass", ctx);
    await c.end();
  });
}

async function cold(statement) {
  const per = await eachWorker(async (w) => {
    const out = [];
    for (let i = 0; i < COLD; i++) {
      const c = await connect(w);
      out.push(await time(c, statement));
      await c.end();
    }
    return out;
  });
  return per.flat();
}

async function warm(statement, ctx) {
  const per = await eachWorker(async (w) => {
    const c = await connect(w);
    await c.query(statement);
    const out = [];
    for (let i = 0; i < WARM; i++) {
      await write(
        c,
        dirtySet(i)
          .map((t) => ctx.inserts.get(t))
          .join(""),
      );
      out.push(await time(c, statement));
    }
    await c.end();
    return out;
  });
  return per.flat();
}

// The afterAll on a warm backend: after a file wrote `n` tables and the Reset emptied
// them, probe and VACUUM what is dirty. Returns timings and the heaps left nonzero.
async function afterAll(variant, n, ctx, shipped) {
  await recreateAll();
  const per = await eachWorker(async (w) => {
    const c = await connect(w);
    const out = [];
    for (let i = 0; i < VACUUM_SAMPLES; i++) {
      await write(
        c,
        dirtySet(i, n)
          .map((t) => ctx.inserts.get(t))
          .join(""),
      );
      await c.query(shipped);
      const t0 = performance.now();
      await vacuumDirty(c, variant, ctx);
      out.push(performance.now() - t0);
    }
    await c.end();
    return { out, left: await nonzero(w, ctx) };
  });
  return { samples: per.flatMap((p) => p.out), left: Math.max(...per.map((p) => p.left)) };
}

// --- Run --------------------------------------------------------------------------------

await setupTemplate();
await recreate(1);
const ctx = await (async () => {
  const c = await connect(1);
  const d = await discover(c);
  const inserts = await writableInserts(
    c,
    d.tables.filter((t) => t.relkind !== "p"),
  );
  await c.end();
  return { ...d, inserts };
})();
dirtyTables = [...ctx.inserts.keys()];

const shippedStatement = buildResetStatement(ctx.tables, ctx.sequences);
const statements = {
  shipped: shippedStatement,
  probe_regclass: built
    ? built.buildResetStatement(ctx.tables, ctx.sequences)
    : probeStatement("probe_regclass", ctx),
  probe_oid: probeStatement("probe_oid", ctx),
};
const partitioned = ctx.tables.filter((t) => t.relkind === "p").length;

console.log(
  `\n${process.env.SCHEMA_SQL ?? `generated schema, ${INDEXES} secondary indexes per table`}: ` +
    `${ctx.tables.length} tables (${partitioned} partitioned), ${ctx.sequences.length} sequences, ` +
    `${dirtyTables.length} writable. W=${WORKERS}; cold = ${COLD} fresh backends per worker, ` +
    `warm = ${WARM} Resets per worker; medians (p95) over all workers, ms.\n` +
    `shipped: ${process.env.RESET_JS ?? "dist/reset.js"}; probe_regclass: ` +
    `${built ? `${process.env.PROBE_JS}'s own statements` : "inline"}.\n`,
);

const STATES = ["pristine", "mid-file", "late, no VACUUM", "after VACUUM"];
const coldMedian = {};
if (SECTIONS.includes("cold")) {
  console.log("Cold Reset, first statement on a new backend:");
  for (const state of STATES) {
    for (const v of VARIANTS) {
      await prepare(state, ctx, shippedStatement);
      const left = await nonzero(1, ctx);
      const s = stats(await cold(statements[v]));
      coldMedian[`${state}|${v}`] = s.median;
      console.log(
        `  ${pad(state, 16)} ${pad(v, 15)} ${f(s.median)} (${f(s.p95)})   nonzero heaps: ${left}`,
      );
    }
  }
}

if (SECTIONS.includes("warm")) {
  console.log("\nWarm Reset, one backend, 10 rows into 8 tables between Resets:");
  for (const v of VARIANTS) {
    await prepare("pristine", ctx, shippedStatement);
    const s = stats(await warm(statements[v], ctx));
    console.log(`  ${pad(v, 15)} ${f(s.median)} (${f(s.p95)})`);
  }
}

const afterAllMedian = {};
if (SECTIONS.includes("afterall")) {
  console.log(
    "\nafterAll: guarded probe + VACUUM (SKIP_LOCKED) of the dirty tables, warm backend:",
  );
  for (const v of VARIANTS.filter((v) => v !== "shipped")) {
    for (const n of [DIRTY, dirtyTables.length]) {
      const { samples, left } = await afterAll(v, n, ctx, shippedStatement);
      const s = stats(samples);
      if (n === DIRTY) afterAllMedian[v] = s.median;
      console.log(
        `  ${pad(v, 15)} ${pad(`${n} dirty`, 9)} ${f(s.median)} (${f(s.p95)})   nonzero after: ${left}`,
      );
    }
  }
}

// What a file pays: its `beforeAll` Reset in the state it starts in, its first
// `afterEach` Reset on a backend that may be new too (mid-file), and the afterAll.
if (SECTIONS.includes("cold") && SECTIONS.includes("afterall")) {
  console.log("\nPer file: cold(start state) + cold(mid-file) + afterAll(8 dirty):");
  for (const start of ["pristine", "after VACUUM", "late, no VACUUM"]) {
    for (const v of VARIANTS) {
      const second = start === "late, no VACUUM" ? start : "mid-file";
      const extra = v === "shipped" || start === "late, no VACUUM" ? 0 : afterAllMedian[v];
      const total = coldMedian[`${start}|${v}`] + coldMedian[`${second}|${v}`] + extra;
      console.log(`  starts ${pad(start, 16)} ${pad(v, 15)} ${f(total)}`);
    }
  }
}

// A connection the file leaked, holding ACCESS SHARE on a dirty table in an open
// transaction: VACUUM's truncation needs ACCESS EXCLUSIVE and retries for about 5 s.
// The guarded probe sees the open transaction and returns nothing to vacuum.
if (SECTIONS.includes("lock")) {
  console.log(
    "\nLeaked lock: another session holds ACCESS SHARE on a dirty table, in a transaction:",
  );
  for (const guarded of [false, true]) {
    await recreate(1);
    const c = await connect(1);
    const leaked = await connect(1);
    await write(
      c,
      dirtySet(0)
        .map((t) => ctx.inserts.get(t))
        .join(""),
    );
    await c.query(shippedStatement);
    await leaked.query(`BEGIN; SELECT 1 FROM ${dirtySet(0)[0]} LIMIT 1`);
    const t0 = performance.now();
    const vacuumed = await vacuumDirty(c, "probe_regclass", ctx, guarded);
    const ms = performance.now() - t0;
    await leaked.query("ROLLBACK");
    await leaked.end();
    await c.end();
    console.log(
      `  ${guarded ? "guarded  " : "unguarded"} afterAll ${f(ms)} ms, ${vacuumed} tables vacuumed, nonzero after: ${await nonzero(1, ctx)}`,
    );
  }
}

await admin.end();
