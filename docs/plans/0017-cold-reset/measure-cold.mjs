// Scratch measurement from the review of issue #17: where the cold Reset cost goes, and
// whether a storage probe that avoids the relcache can cut it. One worker, wall-clock
// from Node. Kept as the starting point for docs/adr/0001-bench/bench4.mjs (see
// PLAN.md next to it); its numbers are from a single run and not yet reproduced.
//
// Run it like bench3.mjs, from a scratch directory with only `pg` installed, against a
// container started as in bench.mjs's header but on `postgres:18-alpine`:
//
//   node measure-cold.mjs <port> [cold samples]
import { performance } from "node:perf_hooks";
import pg from "pg";

const PORT = process.argv[2] ?? "55433";
const TABLES = 73;
const COLD_SAMPLES = Number(process.argv[3] ?? 12);
const WARM_SAMPLES = 40;
const DIRTY = 8; // tables a "file" writes to
const url = (db) => `postgresql://test:test@127.0.0.1:${PORT}/${db}`;

const names = Array.from({ length: TABLES }, (_, i) => `t${i + 1}`);
function schemaDdl() {
  let ddl = `CREATE TABLE _prisma_migrations (id text primary key, name text);`;
  names.forEach((n, i) => {
    const fk = i > 0 ? `, parent_id int references ${names[i - 1]}(id)` : "";
    ddl += `CREATE TABLE "${n}" (id serial primary key, name text not null, email text, slug text, amount numeric(10,2), created_at timestamptz default now(), updated_at timestamptz${fk});`;
    ddl += `CREATE INDEX ${n}_name_idx ON "${n}"(name);`;
    ddl += `CREATE UNIQUE INDEX ${n}_email_key ON "${n}"(email);`;
    ddl += `CREATE INDEX ${n}_created_idx ON "${n}"(created_at);`;
    if (i > 0) ddl += `CREATE INDEX ${n}_parent_idx ON "${n}"(parent_id);`;
  });
  return ddl;
}

const admin = new pg.Client({ connectionString: url("bench") });
await admin.connect();
await admin.query("DROP DATABASE IF EXISTS tpl WITH (FORCE)");
await admin.query("CREATE DATABASE tpl");
{
  const c = new pg.Client({ connectionString: url("tpl") });
  await c.connect();
  await c.query(schemaDdl());
  await c.end();
}

const q = (s, n) => `"${s}"."${n}"`;
// What dist/reset.js builds (same shape as bench3's `cte`), plus the pieces.
function stmts(tables, seqs) {
  const setvals = seqs.map(
    (s) => `pg_catalog.setval('${q(s.schema, s.name)}'::regclass, 1, false)`,
  );
  const deletes = tables.map((t, i) => `d${i} AS (DELETE FROM ${q(t.schema, t.name)})`);
  const block = (body) =>
    `DO $x$\nBEGIN\n  PERFORM pg_catalog.set_config('session_replication_role','replica',true);\n  PERFORM pg_catalog.set_config('lock_timeout','5s',true);\n${body}\nEND $x$`;
  const oids = `ARRAY[${tables.map((t) => t.oid).join(",")}]::oid[]`;
  const probeFile = `SELECT string_agg(format('d%s AS (DELETE FROM %I.%I)', t.ord, n.nspname, c.relname), ', ')
    FROM unnest(${oids}) WITH ORDINALITY AS t(oid, ord)
    JOIN pg_catalog.pg_class c ON c.oid = t.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'p' OR (pg_catalog.pg_stat_file(pg_catalog.pg_relation_filepath(c.oid), true)).size > 0`;
  const probeSize = probeFile.replace(
    "(pg_catalog.pg_stat_file(pg_catalog.pg_relation_filepath(c.oid), true)).size > 0",
    "pg_catalog.pg_relation_size(c.oid) > 0",
  );
  return {
    shipped: block(`  EXECUTE $q$WITH ${deletes.join(", ")} SELECT ${setvals.join(", ")}$q$;`),
    tables_only: block(`  EXECUTE $q$WITH ${deletes.join(", ")} SELECT 1$q$;`),
    seq_only: block(`  EXECUTE $q$SELECT ${setvals.join(", ")}$q$;`),
    empty_block: block(`  NULL;`),
    probe_file_only: block(`  PERFORM (${probeFile});`),
    probe_size_only: block(`  PERFORM (${probeSize});`),
    probe_file_cte: block(`  DECLARE d text;\n` /* placeholder, replaced below */),
  };
}
function probeBlock(tables, seqs, probe) {
  const setvals = seqs.map(
    (s) => `pg_catalog.setval('${q(s.schema, s.name)}'::regclass, 1, false)`,
  );
  const oids = `ARRAY[${tables.map((t) => t.oid).join(",")}]::oid[]`;
  const frags = `ARRAY[${tables.map((t, i) => `'d${i} AS (DELETE FROM ${q(t.schema, t.name).replaceAll("'", "''")})'`).join(",")}]::text[]`;
  const cond =
    probe === "file"
      ? "(pg_catalog.pg_stat_file(pg_catalog.pg_relation_filepath(t.o), true)).size > 0"
      : "pg_catalog.pg_relation_size(t.o) > 0";
  return `DO $x$
DECLARE d text;
BEGIN
  PERFORM pg_catalog.set_config('session_replication_role','replica',true);
  PERFORM pg_catalog.set_config('lock_timeout','5s',true);
  SELECT string_agg(t.frag, ', ') INTO d FROM unnest(${oids}, ${frags}) AS t(o, frag) WHERE ${cond};
  EXECUTE coalesce('WITH ' || d || ' ', '') || $q$SELECT ${setvals.join(", ")}$q$;
END $x$`;
}

async function discover(client) {
  const { rows } = await client.query(`
    SELECT c.oid, n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname='public' AND c.relname <> '_prisma_migrations' ORDER BY c.relname`);
  const tables = rows;
  const seqs = tables.map((t) => ({ schema: "public", name: `${t.name}_id_seq` }));
  return { tables, seqs };
}

function writes(k) {
  let sql = "";
  for (let i = 0; i < DIRTY; i++) {
    const n = names[(k * 3 + i * 7) % TABLES];
    sql += `INSERT INTO "${n}" (name, email, amount) SELECT 'w'||g||'_'||${k}, 'w'||g||'_'||${k}||'@x.io', 1 FROM generate_series(1,10) g;`;
  }
  return sql;
}
function writesAll() {
  return names
    .map(
      (n) =>
        `INSERT INTO "${n}" (name, email, amount) SELECT 'a'||g, 'a'||g||'@x.io', 1 FROM generate_series(1,10) g;`,
    )
    .join("");
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const f = (x) => x.toFixed(1).padStart(6);

async function fresh(db) {
  const c = new pg.Client({ connectionString: url(db) });
  await c.connect();
  await c.query("SELECT 1"); // exclude connection/auth from the timing
  return c;
}
async function timeOnce(c, sql) {
  const t0 = performance.now();
  await c.query(sql);
  return performance.now() - t0;
}
async function cold(db, sql, samples = COLD_SAMPLES) {
  const out = [];
  for (let i = 0; i < samples; i++) {
    const c = await fresh(db);
    out.push(await timeOnce(c, sql));
    await c.end();
  }
  return med(out);
}
async function warm(db, sql, prepare) {
  const c = await fresh(db);
  await c.query(sql);
  const out = [];
  for (let i = 0; i < WARM_SAMPLES; i++) {
    if (prepare) await c.query(prepare(i));
    out.push(await timeOnce(c, sql));
  }
  await c.end();
  return med(out);
}
async function recreate(db) {
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db} TEMPLATE tpl`);
}
async function sizes(db) {
  const c = await fresh(db);
  const { rows } = await c.query(
    `SELECT count(*) FILTER (WHERE pg_relation_size(c.oid) > 0)::int AS nonzero FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'`,
  );
  await c.end();
  return rows[0].nonzero;
}

await recreate("w1");
const disc = await (async () => {
  const c = await fresh("w1");
  const d = await discover(c);
  await c.end();
  return d;
})();
const S = stmts(disc.tables, disc.seqs);
S.probe_file_cte = probeBlock(disc.tables, disc.seqs, "file");
S.probe_size_cte = probeBlock(disc.tables, disc.seqs, "size");

console.log(
  `\n${TABLES} tables, 4-5 indexes each, FK chain. cold = median of ${COLD_SAMPLES} fresh backends; warm = median of ${WARM_SAMPLES} on one backend.\n`,
);

// --- A. Where the cold cost goes (pristine clone: every table size 0) ---
console.log("A. Cold cost breakdown on a pristine clone (all tables empty, size 0):");
for (const v of ["shipped", "probe_file_cte"]) {
  await recreate("w1");
  console.log(`  ${v.padEnd(16)} cold ${f(await cold("w1", S[v]))} ms`);
}

// --- B. Warm, with a file's writes between resets (what a test pays) ---
console.log("\nB. Warm Reset after each test writes 10 rows into 8 tables:");
for (const v of ["shipped", "probe_file_cte"]) {
  await recreate("w1");
  console.log(`  ${v.padEnd(16)} warm ${f(await warm("w1", S[v], writes))} ms`);
}

// --- C. Cold on a backend opened mid-file: 8 tables dirty (deleted, not vacuumed) ---
console.log("\nC. Cold Reset on a new backend mid-file (8 tables written+deleted, no vacuum):");
for (const v of ["shipped", "probe_file_cte"]) {
  await recreate("w1");
  {
    const c = await fresh("w1");
    await c.query(writes(0));
    await c.query(S.shipped);
    await c.end();
  }
  console.log(
    `  ${v.padEnd(16)} cold ${f(await cold("w1", S[v]))} ms  (nonzero tables: ${await sizes("w1")})`,
  );
}

// --- D. Late in a run without vacuum: every table has been written once ---
console.log("\nD. Cold Reset late in a run, no vacuum (all 73 tables written+deleted once):");
for (const v of ["shipped", "probe_file_cte"]) {
  await recreate("w1");
  {
    const c = await fresh("w1");
    await c.query(writesAll());
    await c.query(S.shipped);
    await c.end();
  }
  console.log(
    `  ${v.padEnd(16)} cold ${f(await cold("w1", S[v]))} ms  (nonzero tables: ${await sizes("w1")})`,
  );
}

// --- E. VACUUM: does it bring heap size back to 0, and what does it cost? ---
console.log("\nE. VACUUM of dirty tables after DELETE (what an afterAll would pay):");
{
  await recreate("w1");
  const c = await fresh("w1");
  await c.query(writes(0));
  await c.query(S.shipped);
  const dirty = (
    await c.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND pg_relation_size(c.oid)>0`,
    )
  ).rows.map((r) => `"${r.relname}"`);
  let t = await timeOnce(c, `VACUUM ${dirty.join(", ")}`);
  console.log(
    `  VACUUM ${dirty.length} dirty tables: ${f(t)} ms → nonzero after: ${await sizes("w1")}`,
  );
  t = await timeOnce(c, `VACUUM ${dirty.join(", ")}`);
  console.log(`  same VACUUM again (already clean): ${f(t)} ms`);
  // after 5 "files" of writes to the same 8 tables, then vacuum
  for (let k = 0; k < 5; k++) {
    await c.query(writes(0));
    await c.query(S.shipped);
  }
  t = await timeOnce(c, `VACUUM ${dirty.join(", ")}`);
  console.log(
    `  VACUUM ${dirty.length} tables after 5 files of 80 rows: ${f(t)} ms → nonzero after: ${await sizes("w1")}`,
  );
  await c.query(writesAll());
  await c.query(S.shipped);
  t = await timeOnce(c, `VACUUM ${names.map((n) => `"${n}"`).join(", ")}`);
  console.log(`  VACUUM all 73 tables: ${f(t)} ms → nonzero after: ${await sizes("w1")}`);
  // Cold Reset on a fresh backend after the vacuum
  await c.end();
  console.log(
    `  probe_file_cte cold after that vacuum: ${f(await cold("w1", S.probe_file_cte))} ms`,
  );
  console.log(`  shipped        cold after that vacuum: ${f(await cold("w1", S.shipped))} ms`);
}

await admin.end();
