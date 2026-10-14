// url-mode runs sharing one server, one of them killed: `pnpm run test:url-concurrent`.
// Needs Docker; not part of the gate.
//
// It starts one Postgres (standing in for a shared server), then launches
// `vitest run --project integration-url` runs with PRISMA_TEST_HELPER_URL pointing at it:
//
// 1. K starts. Once its marked template is on the server, A starts. A's Sweep must leave
//    K's databases alone: K is alive and holds its lock.
// 2. Once its Worker Databases are cloned and marked, K is killed with SIGKILL, process
//    group and all, so its teardown never runs and its databases stay behind.
// 3. While A is still running, B starts. B's Sweep must drop K's databases, and leave A's.
//
// It fails unless A and B both pass, they had their templates on the server together, K's
// databases outlived K until a Sweep dropped them (and said so), and afterwards no
// `prisma_test` database is left.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const TEMPLATES = String.raw`SELECT datname FROM pg_database WHERE datname ~ '^prisma_test_[0-9a-f]{8}$'`;
const MARKED_TEMPLATES =
  `${TEMPLATES} AND shobj_description(oid, 'pg_database') ` +
  `= 'prisma-test-helper run ' || right(datname, 8)`;
const LEFT = String.raw`SELECT datname FROM pg_database WHERE datname LIKE 'prisma\_test%' ORDER BY datname`;

/**
 * Start one url-mode suite against `url`, its output prefixed with `label` and kept. It
 * runs in its own process group, so it can be killed with every worker it forked.
 */
function start(label, url) {
  // `--silent=false`: Vitest keeps a passing test's console to itself otherwise, and the
  // Sweep line of tests/url-mode/sweep.test.ts is one this script reads.
  const child = spawn("vitest", ["run", "--project", "integration-url", "--silent=false"], {
    env: { ...process.env, PRISMA_TEST_HELPER_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const output = [];
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (line.trim() === "") continue;
        output.push(line);
        console.log(`[${label}] ${line}`);
      }
    });
  }
  const exited = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve(code ?? signal)),
  );
  let running = true;
  void exited.then(() => (running = false));
  return { child, output, exited, isRunning: () => running };
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

/** Poll until `database` is on the server, carrying a Run marker. */
async function marked(url, database, what) {
  const sql =
    `SELECT datname FROM pg_database WHERE datname = '${database}' ` +
    "AND shobj_description(oid, 'pg_database') LIKE 'prisma-test-helper run %'";
  for (let waited = 0; waited < 120_000; waited += 100) {
    if ((await query(url, sql)).length > 0) return;
    await sleep(100);
  }
  throw new Error(`${what} never appeared on the server`);
}

/** Poll until a marked run template not in `known` is on the server, and return it. */
async function newTemplate(url, known, what) {
  for (let waited = 0; waited < 120_000; waited += 100) {
    const fresh = (await query(url, MARKED_TEMPLATES)).find((name) => !known.includes(name));
    if (fresh !== undefined) return fresh;
    await sleep(100);
  }
  throw new Error(`${what}'s template never appeared on the server`);
}

const server = await new PostgreSqlContainer("postgres:18-alpine").start();
const url = server.getConnectionUri();
const failures = [];
const check = (ok, failure) => {
  if (!ok) failures.push(failure);
};
try {
  // Every set of run templates on the server at one moment, to prove A and B overlapped.
  const snapshots = [];
  const poll = setInterval(() => {
    query(url, TEMPLATES)
      .then((templates) => snapshots.push(templates))
      .catch(() => {});
  }, 100);

  const k = start("K", url);
  const kTemplate = await newTemplate(url, [], "K");
  console.log(`\nK's template is on the server: ${kTemplate}`);

  const a = start("A", url);
  const aTemplate = await newTemplate(url, [kTemplate], "A");
  // A swept before creating its template, while K was alive.
  check(
    (await query(url, TEMPLATES)).includes(kTemplate),
    "A's Sweep dropped the databases of K while K was alive",
  );

  // Mid-suite: K has cloned and marked its Worker Databases, and its tests are running.
  await marked(url, `${kTemplate}_2`, "K's last Worker Database");
  process.kill(-k.child.pid, "SIGKILL");
  await k.exited;
  const kLeft = (await query(url, LEFT)).filter((name) => name.startsWith(kTemplate));
  console.log(`\nK killed; its databases left on the server: ${kLeft.join(", ") || "none"}`);
  check(kLeft.includes(kTemplate), "K's template did not outlive K");

  check(a.isRunning(), "A finished before B started: B's Sweep never ran beside a live run");
  const b = start("B", url);
  const [aCode, bCode] = await Promise.all([a.exited, b.exited]);
  clearInterval(poll);

  check(aCode === 0, `run A exited with ${aCode}`);
  check(bCode === 0, `run B exited with ${bCode}`);
  const bTemplate = snapshots.flat().find((name) => name !== kTemplate && name !== aTemplate);
  const together = snapshots.some((set) => set.includes(aTemplate) && set.includes(bTemplate));
  console.log(`\nA and B had their templates on the server together: ${together ? "yes" : "no"}`);
  check(together, "A and B never had their templates on the server together");
  // B's startup Sweep drops them, unless A's or B's own tests/url-mode/sweep.test.ts,
  // which sweeps the server too, got there first: either way a Sweep line names each one.
  const swept = [...a.output, ...b.output].filter((line) =>
    line.includes("dropped databases left on"),
  );
  console.log(`Sweep lines:\n${swept.map((line) => `  ${line}`).join("\n") || "  none"}`);
  check(
    kLeft.every((name) => swept.some((line) => new RegExp(`[:,] ${name}(,|$)`).test(line))),
    "no Sweep reported dropping every database K left",
  );

  const left = await query(url, LEFT);
  console.log(
    `prisma_test databases left on the server: ${left.length ? left.join(", ") : "none"}`,
  );
  check(left.length === 0, `left behind: ${left.join(", ")}`);
} finally {
  await server.stop();
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  "\nPASS: a killed run's databases were dropped by the next run's Sweep, the live runs " +
    "passed beside it, and nothing was left behind",
);
