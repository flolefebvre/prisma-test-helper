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

// Per-test reset strategies on a tuned throwaway Postgres: wall-clock from Node over a
// real connection, which is what a Vitest test pays.
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
  ddl += `CREATE TABLE _prisma_migrations (id text primary key, name text);`;
  names.forEach((n, i) => {
    const fk = i > 0 ? `, parent_id int references ${names[i - 1]}(id)` : "";
    ddl += `CREATE TABLE ${n} (id serial primary key, name text not null, email text, amount numeric(10,2), created_at timestamptz default now()${fk});`;
    ddl += `CREATE INDEX ${n}_name_idx ON ${n}(name);`;
    if (i > 0) ddl += `CREATE INDEX ${n}_parent_idx ON ${n}(parent_id);`;
  });
  await client.query(ddl);
}

async function seed(rowsPerTable) {
  let sql = "";
  names.forEach((n, i) => {
    const parent = i > 0 ? `, (g % ${rowsPerTable}) + 1` : "";
    const col = i > 0 ? ", parent_id" : "";
    sql += `INSERT INTO ${n} (name, email, amount${col}) SELECT 'name ' || g, 'u' || g || '@x.io', g * 1.5${parent} FROM generate_series(1, ${rowsPerTable}) g;`;
  });
  await client.query(sql);
}

async function snapshotBaseline() {
  let sql = "CREATE SCHEMA baseline;";
  for (const n of names) sql += `CREATE TABLE baseline.${n} AS TABLE ${n};`;
  await client.query(sql);
}

// A "typical test" write set: 5 rows into each of 5 tables, committed.
async function testWrites() {
  let sql = "";
  for (const n of names.slice(0, 5)) {
    sql += `INSERT INTO ${n} (name, email, amount) SELECT 'w' || g, 'w' || g || '@x.io', 1 FROM generate_series(1,5) g;`;
  }
  await client.query(sql);
}

const truncateSql = `TRUNCATE ${names.join(", ")} RESTART IDENTITY CASCADE`;
const truncateNoRestartSql = `TRUNCATE ${names.join(", ")} CASCADE`;

const deleteSql =
  "SET session_replication_role = replica;" +
  names.map((n) => `DELETE FROM ${n};`).join("") +
  names.map((n) => `ALTER SEQUENCE ${n}_id_seq RESTART WITH 1;`).join("") +
  "SET session_replication_role = DEFAULT;";

const restoreSql =
  "SET session_replication_role = replica;" +
  names.map((n) => `DELETE FROM ${n}; INSERT INTO ${n} SELECT * FROM baseline.${n};`).join("") +
  names
    .map((n) => `SELECT setval('${n}_id_seq', (SELECT COALESCE(MAX(id),1) FROM ${n}));`)
    .join("") +
  "SET session_replication_role = DEFAULT;";

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
  console.log(`${label.padEnd(52)} median ${median.padStart(6)} ms   p95 ${p95.padStart(6)} ms`);
}

console.log(`\n== ${TABLES} tables, ${ITER} iterations ==`);

// --- Transaction rollback (current design) ---
await createSchema();
await measure(
  "rollback: BEGIN + 5 inserts + ROLLBACK (whole test)",
  async () => {},
  async () => {
    await client.query("BEGIN");
    await testWrites();
    await client.query("ROLLBACK");
  },
);
await measure(
  "rollback: ROLLBACK only",
  async () => {
    await client.query("BEGIN");
    await testWrites();
  },
  async () => client.query("ROLLBACK"),
);

// --- Empty baseline ---
await createSchema();
await measure("truncate all, RESTART IDENTITY (empty baseline)", testWrites, () =>
  client.query(truncateSql),
);
await measure("truncate all, no RESTART IDENTITY", testWrites, () =>
  client.query(truncateNoRestartSql),
);
await measure("batched DELETE + sequence restart (empty baseline)", testWrites, () =>
  client.query(deleteSql),
);

// --- Seeded baseline, restore from baseline schema ---
for (const rows of [20, 200, 2000]) {
  await createSchema();
  await seed(rows);
  await snapshotBaseline();
  await measure(`DELETE + restore from baseline (${rows} rows/table)`, testWrites, () =>
    client.query(restoreSql),
  );
}

// --- Seeded baseline, truncate + in-process re-seed (one round trip per table) ---
await createSchema();
await measure("truncate + re-seed 20 rows/table via INSERTs", testWrites, async () => {
  await client.query(truncateSql);
  await seed(20);
});

await client.end();
