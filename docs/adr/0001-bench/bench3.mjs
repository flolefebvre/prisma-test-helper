// Benchmark behind the amendment in docs/adr/0001-commit-and-reset-instead-of-rollback.md:
// a consumer-shaped load — 73 tables, W Worker Databases reset concurrently, N tests per
// worker, each writing 10 rows into 8 tables and committing — timing the statement the
// package ships (built from dist/reset.js, so `pnpm build` first) against alternatives.
// Same container as bench.mjs (see its header), but `postgres:18-alpine`:
//
//   node bench3.mjs 5433 20 100 shipped noseq deleteall cte cte_seqloop cte_seqprobe truncdirty
//   node bench3.mjs <port> <workers> <tests per worker> <variant...>
//
// `shipped` is whatever dist/reset.js builds; the others are the alternatives the
// amendment lists. Set RESET_JS to point `shipped` at another build.
import { performance } from "node:perf_hooks";
import pg from "pg";

const { buildResetStatement, DISCOVERY_QUERY } = await import(
  process.env.RESET_JS ?? new URL("../../../dist/reset.js", import.meta.url).href
);

const port = process.argv[2];
const WORKERS = Number(process.argv[3] ?? 20);
const TESTS = Number(process.argv[4] ?? 100);
const VARIANTS = process.argv.slice(5);
const TABLES = 73;
const WRITE_TABLES = 8; // tables a test writes to
const ROWS = 10; // rows per written table

const admin = new pg.Client({ connectionString: `postgresql://test:test@127.0.0.1:${port}/bench` });
await admin.connect();

const names = Array.from({ length: TABLES }, (_, i) => `t${i + 1}`);

function schemaDdl() {
  let ddl = `CREATE TABLE _prisma_migrations (id text primary key, name text);`;
  names.forEach((n, i) => {
    const fk = i > 0 ? `, parent_id int references ${names[i - 1]}(id)` : "";
    ddl += `CREATE TABLE "${n}" (id serial primary key, name text not null, email text, amount numeric(10,2), created_at timestamptz default now()${fk});`;
    ddl += `CREATE INDEX ${n}_name_idx ON "${n}"(name);`;
    if (i > 0) ddl += `CREATE INDEX ${n}_parent_idx ON "${n}"(parent_id);`;
  });
  return ddl;
}

async function setupTemplate() {
  await admin.query("DROP DATABASE IF EXISTS tpl WITH (FORCE)");
  await admin.query("CREATE DATABASE tpl");
  const c = new pg.Client({ connectionString: `postgresql://test:test@127.0.0.1:${port}/tpl` });
  await c.connect();
  await c.query(schemaDdl());
  await c.end();
}

async function cloneWorkers() {
  for (let w = 1; w <= WORKERS; w++) {
    await admin.query(`DROP DATABASE IF EXISTS tpl_${w} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE tpl_${w} TEMPLATE tpl`);
  }
}

// A test's writes: ROWS rows into WRITE_TABLES tables, rotating which ones per test so
// bloat spreads over the schema like a real suite does.
function testWrites(testIndex) {
  let sql = "";
  for (let k = 0; k < WRITE_TABLES; k++) {
    const n = names[(testIndex * 3 + k * 7) % TABLES];
    sql += `INSERT INTO "${n}" (name, email, amount) SELECT 'w' || g, 'w' || g || '@x.io', 1 FROM generate_series(1,${ROWS}) g;`;
  }
  return sql;
}

const variants = {
  // What 1.0.0 ships: probe each table with EXECUTE, DELETE non-empty, setval loop.
  shipped: async (client) => {
    const rels = (await client.query(DISCOVERY_QUERY)).rows;
    const stmt = buildResetStatement(
      rels.filter((r) => r.kind === "table"),
      rels
        .filter((r) => r.kind === "sequence")
        .map((r) => ({ schema: r.schema, name: r.name, startValue: r.start_value })),
    );
    return () => client.query(stmt);
  },
  // Shipped, minus the sequence loop: isolates the pg_sequences cost.
  noseq: async (client) => {
    const rels = (await client.query(DISCOVERY_QUERY)).rows;
    const stmt = buildResetStatement(
      rels.filter((r) => r.kind === "table"),
      [],
    );
    return () => client.query(stmt);
  },
  // No probe at all: DELETE every table unconditionally, one multi-statement batch.
  deleteall: async (client) => {
    const stmt =
      "SET LOCAL session_replication_role = replica;" +
      names.map((n) => `DELETE FROM "${n}";`).join("") +
      names.map((n) => `SELECT setval('${n}_id_seq', 1, false);`).join("");
    return async () => {
      await client.query("BEGIN; " + stmt + " COMMIT;");
    };
  },
  // Dirty set from pg_stat_user_tables counters (after forcing a flush), TRUNCATE those.
  // Stats-based detection; only valid if every writer flushed — shown for cost only.
  truncdirty: async (client) => {
    const stmt = `DO $x$
DECLARE dirty text[];
BEGIN
  PERFORM pg_catalog.pg_stat_force_next_flush();
  SELECT array_agg(format('%I.%I', schemaname, relname)) INTO dirty
  FROM pg_catalog.pg_stat_user_tables WHERE n_live_tup > 0 OR n_dead_tup > 0 OR n_tup_ins > 0;
  IF dirty IS NOT NULL THEN
    EXECUTE 'TRUNCATE ' || array_to_string(dirty, ', ') || ' RESTART IDENTITY CASCADE';
  END IF;
END $x$`;
    return () => client.query(stmt);
  },
  // Shipped probe-and-delete but using pg_relation_size as the probe (no heap scan),
  // then DELETE; and a VACUUM of the dirty tables every K resets to cap bloat.
  sizeprobe: async (client) => {
    const rels = (await client.query(DISCOVERY_QUERY)).rows.filter((r) => r.kind === "table");
    const lines = [
      "DO $x$",
      "DECLARE sz bigint;",
      "BEGIN",
      "PERFORM pg_catalog.set_config('session_replication_role','replica',true);",
    ];
    for (const t of rels) {
      lines.push(
        `IF pg_catalog.pg_relation_size(format('%I.%I','${t.schema}','${t.name}')::regclass) > 0 THEN EXECUTE format('DELETE FROM %I.%I','${t.schema}','${t.name}'); END IF;`,
      );
    }
    lines.push("END $x$");
    return () => client.query(lines.join("\n"));
  },
  // One DO block: set_config, then ONE statement that deletes every table through
  // data-modifying CTEs and rewinds every sequence with setval in its final SELECT.
  cte: async (client) => {
    const rels = (await client.query(DISCOVERY_QUERY)).rows;
    const tables = rels.filter((r) => r.kind === "table");
    const seqs = rels.filter((r) => r.kind === "sequence");
    const q = (r) => `"${r.schema}"."${r.name}"`;
    const inner =
      "WITH " +
      tables.map((t, i) => `d${i} AS (DELETE FROM ${q(t)})`).join(", ") +
      " SELECT " +
      (seqs.length
        ? seqs.map((s) => `pg_catalog.setval('${q(s)}'::regclass, 1, false)`).join(", ")
        : "1");
    const stmt = `DO $x$
BEGIN
  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);
  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  EXECUTE ${"$q$" + inner + "$q$"};
END $x$`;
    return () => client.query(stmt);
  },
  // Same, but sequences rewound via a static PERFORM per sequence inside the block.
  cte_seqloop: async (client) => {
    const rels = (await client.query(DISCOVERY_QUERY)).rows;
    const tables = rels.filter((r) => r.kind === "table");
    const seqs = rels.filter((r) => r.kind === "sequence");
    const q = (r) => `"${r.schema}"."${r.name}"`;
    const inner =
      "WITH " + tables.map((t, i) => `d${i} AS (DELETE FROM ${q(t)})`).join(", ") + " SELECT 1";
    const stmt = `DO $x$
BEGIN
  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);
  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  EXECUTE ${"$q$" + inner + "$q$"};
${seqs.map((s) => `  PERFORM pg_catalog.setval('${q(s)}'::regclass, 1, false);`).join("\n")}
END $x$`;
    return () => client.query(stmt);
  },
  // Deletes as a CTE statement but only rewind sequences whose last_value is set,
  // probed directly with pg_sequence_last_value (no view).
  cte_seqprobe: async (client) => {
    const rels = (await client.query(DISCOVERY_QUERY)).rows;
    const tables = rels.filter((r) => r.kind === "table");
    const seqs = rels.filter((r) => r.kind === "sequence");
    const q = (r) => `"${r.schema}"."${r.name}"`;
    const inner =
      "WITH " +
      tables.map((t, i) => `d${i} AS (DELETE FROM ${q(t)})`).join(", ") +
      " SELECT " +
      seqs
        .map(
          (s) =>
            `CASE WHEN pg_catalog.pg_sequence_last_value('${q(s)}'::regclass) IS NOT NULL THEN pg_catalog.setval('${q(s)}'::regclass, 1, false) END`,
        )
        .join(", ");
    const stmt = `DO $x$
BEGIN
  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);
  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  EXECUTE ${"$q$" + inner + "$q$"};
END $x$`;
    return () => client.query(stmt);
  },
};

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, median: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}

async function runWorker(w, variant) {
  const client = new pg.Client({
    connectionString: `postgresql://test:test@127.0.0.1:${port}/tpl_${w}`,
  });
  await client.connect();
  const reset = await variants[variant](client);
  await reset();
  const samples = [];
  const writes = [];
  for (let i = 0; i < TESTS; i++) {
    const w0 = performance.now();
    await client.query(testWrites(i));
    writes.push(performance.now() - w0);
    const t0 = performance.now();
    await reset();
    samples.push(performance.now() - t0);
  }
  const bloat = (
    await client.query(
      `SELECT sum(pg_total_relation_size(c.oid))::bigint AS b, sum(n_dead_tup)::bigint AS d FROM pg_class c JOIN pg_stat_user_tables s ON s.relid=c.oid`,
    )
  ).rows[0];
  await client.end();
  return { samples, writes, bloat };
}

for (const variant of VARIANTS) {
  await setupTemplate();
  await cloneWorkers();
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => runWorker(i + 1, variant)),
  );
  const wall = performance.now() - t0;
  const all = results.flatMap((r) => r.samples);
  const first = results.flatMap((r) => r.samples.slice(0, 10));
  const last = results.flatMap((r) => r.samples.slice(-10));
  const wr = stats(results.flatMap((r) => r.writes));
  const s = stats(all);
  const bytes = results.reduce((a, r) => a + Number(r.bloat.b), 0) / WORKERS / 1e6;
  const dead = results.reduce((a, r) => a + Number(r.bloat.d), 0) / WORKERS;
  const f = (x) => x.toFixed(1).padStart(6);
  console.log(
    `${variant.padEnd(11)} W=${WORKERS} N=${TESTS}  reset mean ${f(s.mean)} med ${f(s.median)} p95 ${f(s.p95)} max ${f(s.max)} ms` +
      ` | first10 med ${f(stats(first).median)} last10 med ${f(stats(last).median)}` +
      ` | writes med ${f(wr.median)} | wall ${(wall / 1000).toFixed(1)}s | per-db ${bytes.toFixed(1)}MB dead ${dead.toFixed(0)}`,
  );
}
await admin.end();
