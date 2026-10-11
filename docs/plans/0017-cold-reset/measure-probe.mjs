// Scratch measurement from the review of issue #17: where the storage probe's cost goes,
// cold and warm, as plain statements. Reuses the `tpl` database measure-cold.mjs
// creates, so run that first, on the same container:
//
//   node measure-probe.mjs <port>
import { performance } from "node:perf_hooks";
import pg from "pg";
const PORT = process.argv[2] ?? "55433";
const url = (db) => `postgresql://test:test@127.0.0.1:${PORT}/${db}`;
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const f = (x) => x.toFixed(2).padStart(7);

const admin = new pg.Client({ connectionString: url("bench") });
await admin.connect();
await admin.query("DROP DATABASE IF EXISTS w2 WITH (FORCE)");
await admin.query("CREATE DATABASE w2 TEMPLATE tpl");
async function fresh() {
  const c = new pg.Client({ connectionString: url("w2") });
  await c.connect();
  await c.query("SELECT 1");
  return c;
}
let c = await fresh();
const oids = (
  await c.query(
    `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'`,
  )
).rows.map((r) => r.oid);
await c.end();
const arr = `ARRAY[${oids.join(",")}]::oid[]`;
const P = {
  baseline_select1: `SELECT 1`,
  unnest_only: `SELECT count(*) FROM unnest(${arr}) o`,
  join_pg_class_ns: `SELECT count(*) FROM unnest(${arr}) t(oid) JOIN pg_catalog.pg_class c ON c.oid=t.oid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace`,
  filepath_only: `SELECT count(*) FROM unnest(${arr}) o WHERE pg_catalog.pg_relation_filepath(o) IS NOT NULL`,
  filepath_statfile: `SELECT count(*) FROM unnest(${arr}) o WHERE (pg_catalog.pg_stat_file(pg_catalog.pg_relation_filepath(o), true)).size > 0`,
  filenode_only: `SELECT count(*) FROM unnest(${arr}) o WHERE pg_catalog.pg_relation_filenode(o) IS NOT NULL`,
  regclass_text: `SELECT count(*) FROM unnest(${arr}) o WHERE o::regclass::text <> ''`,
  format_string_agg: `SELECT string_agg(format('d%s AS (DELETE FROM %s)', ord, o::regclass), ', ') FROM unnest(${arr}) WITH ORDINALITY t(o, ord)`,
};
async function timeOnce(cl, sql) {
  const t0 = performance.now();
  await cl.query(sql);
  return performance.now() - t0;
}
console.log(
  "\nprobe pieces (73 oids): cold = median of 8 fresh backends, warm = median of 30 on one backend",
);
for (const [k, sql] of Object.entries(P)) {
  const colds = [];
  for (let i = 0; i < 8; i++) {
    const cl = await fresh();
    colds.push(await timeOnce(cl, sql));
    await cl.end();
  }
  const cl = await fresh();
  await cl.query(sql);
  const warms = [];
  for (let i = 0; i < 30; i++) warms.push(await timeOnce(cl, sql));
  await cl.end();
  console.log(`  ${k.padEnd(20)} cold ${f(med(colds))}  warm ${f(med(warms))} ms`);
}
await admin.end();
