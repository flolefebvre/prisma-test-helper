// Two url-mode runs at once against one server: `pnpm run test:url-concurrent`. Needs
// Docker; not part of the gate.
//
// It starts one Postgres (standing in for a shared server), then launches two
// `vitest run --project integration-url` with PRISMA_TEST_HELPER_URL pointing at it, at
// the same time. While they run it polls the server for the run templates present at
// once, to prove the runs overlapped. It fails unless both runs pass, both templates
// were on the server together, and afterwards no `prisma_test` database is left.

import { spawn } from "node:child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const TEMPLATES = String.raw`SELECT datname FROM pg_database WHERE datname ~ '^prisma_test_[0-9a-f]{8}$'`;
const LEFT = String.raw`SELECT datname FROM pg_database WHERE datname LIKE 'prisma\_test%' ORDER BY datname`;

/** Run one url-mode suite against `url`, its output prefixed with `label`. */
function run(label, url) {
  return new Promise((resolve) => {
    const child = spawn("vitest", ["run", "--project", "integration-url"], {
      env: { ...process.env, PRISMA_TEST_HELPER_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop();
        for (const line of lines) if (line.trim() !== "") console.log(`[${label}] ${line}`);
      });
    }
    child.on("close", (code) => resolve(code));
  });
}

async function query(url, sql) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return (await client.query(sql)).rows.map((row) => row.datname);
  } finally {
    await client.end();
  }
}

const server = await new PostgreSqlContainer("postgres:18-alpine").start();
const url = server.getConnectionUri();
const failures = [];
try {
  let overlap = 0;
  const poll = setInterval(() => {
    query(url, TEMPLATES)
      .then((templates) => (overlap = Math.max(overlap, templates.length)))
      .catch(() => {});
  }, 100);
  const codes = await Promise.all([run("A", url), run("B", url)]);
  clearInterval(poll);

  codes.forEach((code, index) => {
    if (code !== 0) failures.push(`run ${"AB"[index]} exited with ${code}`);
  });
  console.log(`\nrun templates on the server at once, at most: ${overlap}`);
  if (overlap < 2) failures.push("the two runs never had their templates on the server together");
  const left = await query(url, LEFT);
  console.log(
    `prisma_test databases left on the server: ${left.length ? left.join(", ") : "none"}`,
  );
  if (left.length > 0) failures.push(`left behind: ${left.join(", ")}`);
} finally {
  await server.stop();
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nPASS: both runs passed against one server, and left nothing behind");
