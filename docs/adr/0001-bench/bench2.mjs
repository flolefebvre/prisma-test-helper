// Benchmark behind docs/adr/0001-commit-and-reset-instead-of-rollback.md, as it was run
// (only reformatted), so its numbers stay reproducible. bench.mjs times the reset
// strategies (rollback, TRUNCATE, batched DELETE, seeded restore); bench2.mjs breaks the
// batched DELETE down and times the single-DO-block probe-and-delete the harness ships.
//
// Needs only the `pg` driver, which is deliberately NOT a dependency of this package —
// run it from a scratch directory:
//
//   npm init -y && npm i pg && cp <repo>/docs/adr/0001-bench/*.mjs .
//   docker run -d --rm --name bench -p 5433:5432 \
//     -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bench \
//     -e PGDATA=/var/lib/postgresql/data/pgdata --tmpfs /var/lib/postgresql/data \
//     postgres:17-alpine -c fsync=off -c synchronous_commit=off -c full_page_writes=off
//   node bench.mjs 5433 50 && node bench2.mjs 5433 50   # port, table count
//
// The container flags mirror what `createGlobalSetup` runs.

// Where the batched-DELETE cost goes, and whether a probe-then-targeted reset beats it.
import { performance } from "node:perf_hooks";
import pg from "pg";

const port = process.argv[2];
const TABLES = Number(process.argv[3] ?? 50);
const ITER = 40;

const client = new pg.Client({
  connectionString: `postgresql://test:test@127.0.0.1:${port}/bench`,
});
await client.connect();
const names = Array.from({ length: TABLES }, (_, i) => `t${i + 1}`);

async function createSchema() {
  let ddl =
    "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS baseline CASCADE;";
  names.forEach((n, i) => {
    const fk = i > 0 ? `, parent_id int references ${names[i - 1]}(id)` : "";
    ddl += `CREATE TABLE ${n} (id serial primary key, name text not null, email text, amount numeric(10,2), created_at timestamptz default now()${fk});`;
    ddl += `CREATE INDEX ${n}_name_idx ON ${n}(name);`;
  });
  await client.query(ddl);
}
async function seed(rows) {
  let sql = "";
  names.forEach((n, i) => {
    const parent = i > 0 ? `, (g % ${rows}) + 1` : "";
    const col = i > 0 ? ", parent_id" : "";
    sql += `INSERT INTO ${n} (name, email, amount${col}) SELECT 'name ' || g, 'u' || g || '@x.io', g * 1.5${parent} FROM generate_series(1, ${rows}) g;`;
  });
  await client.query(sql);
}
async function snapshotBaseline() {
  let sql =
    "CREATE SCHEMA baseline; CREATE TABLE baseline._meta (tbl text primary key, n bigint, xid xid8);";
  for (const n of names) {
    sql += `CREATE TABLE baseline.${n} AS TABLE ${n};`;
    sql += `INSERT INTO baseline._meta SELECT '${n}', count(*), pg_current_xact_id() FROM ${n};`;
  }
  await client.query(sql);
}
async function testWrites() {
  let sql = "";
  for (const n of names.slice(0, 5)) {
    sql += `INSERT INTO ${n} (name, email, amount) SELECT 'w' || g, 'w' || g || '@x.io', 1 FROM generate_series(1,5) g;`;
  }
  await client.query(sql);
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: q(0.5).toFixed(1), p95: q(0.95).toFixed(1) };
}
async function measure(label, prepare, reset) {
  const samples = [];
  for (let i = 0; i < ITER + 3; i++) {
    await prepare();
    const t0 = performance.now();
    await reset();
    const dt = performance.now() - t0;
    if (i >= 3) samples.push(dt);
  }
  const { median, p95 } = stats(samples);
  console.log(`${label.padEnd(58)} median ${median.padStart(6)} ms   p95 ${p95.padStart(6)} ms`);
}

console.log(`\n== ${TABLES} tables ==`);
await createSchema();

const deleteOnly =
  "SET session_replication_role = replica;" +
  names.map((n) => `DELETE FROM ${n};`).join("") +
  "SET session_replication_role = DEFAULT;";
const seqOnly = names.map((n) => `ALTER SEQUENCE ${n}_id_seq RESTART WITH 1;`).join("");
const setvalOnly = names.map((n) => `SELECT setval('${n}_id_seq', 1, false);`).join("");

await measure("DELETE all, no sequence reset", testWrites, () => client.query(deleteOnly));
await measure(
  "ALTER SEQUENCE RESTART x N only",
  async () => {
    await client.query(deleteOnly);
    await testWrites();
  },
  () => client.query(seqOnly),
);
await measure(
  "setval x N only",
  async () => {
    await client.query(deleteOnly);
    await testWrites();
  },
  () => client.query(setvalOnly),
);

await client.query(deleteOnly + setvalOnly);
// Probe which tables are non-empty in one query, then delete just those.
const probe = names
  .map((n) => `SELECT '${n}' AS t WHERE EXISTS (SELECT 1 FROM ${n})`)
  .join(" UNION ALL ");
await measure("probe non-empty (1 query) + targeted DELETE + setval", testWrites, async () => {
  const { rows } = await client.query(probe);
  const sql =
    "SET session_replication_role = replica;" +
    rows.map(({ t }) => `DELETE FROM ${t}; SELECT setval('${t}_id_seq', 1, false);`).join("") +
    "SET session_replication_role = DEFAULT;";
  await client.query(sql);
});

// Single DO block: probe + delete server-side, one round trip.
const doBlock = `DO $$ DECLARE r text; BEGIN
  PERFORM set_config('session_replication_role','replica', true);
  FOR r IN SELECT unnest(ARRAY[${names.map((n) => `'${n}'`).join(",")}]) LOOP
    IF EXISTS (SELECT 1 FROM ONLY pg_catalog.pg_class WHERE false) THEN NULL; END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', r) INTO STRICT r;
  END LOOP;
END $$;`;
// (the above is a placeholder structure; real version below)
const doReset = `DO $$ DECLARE t text; nonempty boolean; BEGIN
  PERFORM set_config('session_replication_role','replica', true);
  FOREACH t IN ARRAY ARRAY[${names.map((n) => `'${n}'`).join(",")}] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', t) INTO nonempty;
    IF nonempty THEN
      EXECUTE format('DELETE FROM %I', t);
      PERFORM setval(t || '_id_seq', 1, false);
    END IF;
  END LOOP;
END $$;`;
void doBlock;
await client.query(deleteOnly + setvalOnly);
await measure("DO block: probe + targeted DELETE, one round trip", testWrites, () =>
  client.query(doReset),
);

// Seeded baseline with change detection: count differs or any row newer than snapshot.
for (const rows of [20, 200, 2000]) {
  await createSchema();
  await seed(rows);
  await snapshotBaseline();
  const doRestore = `DO $$ DECLARE m record; changed boolean; BEGIN
    PERFORM set_config('session_replication_role','replica', true);
    FOR m IN SELECT tbl, n, xid FROM baseline._meta LOOP
      EXECUTE format('SELECT count(*) <> $1 OR EXISTS (SELECT 1 FROM %I WHERE xmin::text::bigint > $2) FROM %I', m.tbl, m.tbl)
        INTO changed USING m.n, m.xid::text::bigint;
      IF changed THEN
        EXECUTE format('DELETE FROM %I; INSERT INTO %I SELECT * FROM baseline.%I', m.tbl, m.tbl, m.tbl);
        PERFORM setval(m.tbl || '_id_seq', GREATEST(m.n, 1));
      END IF;
    END LOOP;
  END $$;`;
  await measure(
    `DO block: detect-changed + targeted restore (${rows} rows/table)`,
    testWrites,
    () => client.query(doRestore),
  );
  // Sanity: after reset, touched tables are back to baseline count.
  const { rows: chk } = await client.query(`SELECT count(*)::int AS c FROM t1`);
  if (chk[0].c !== rows)
    console.log(`  !! restore check failed: t1 has ${chk[0].c} rows, expected ${rows}`);
}

await client.end();
