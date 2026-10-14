// The pure half of Worker Database provisioning and addressing: how many Worker
// Databases a run needs, the psql argv that clones them from the Template Database, and
// the URI a worker connects through. No container, no I/O — the global setup and the
// per-worker setup feed these from Vitest and Testcontainers, so each piece is exercised
// exhaustively without Docker.

import os from "node:os";

import type { TestProject } from "vitest/node";

/**
 * How many Worker Databases to provision.
 *
 * `maxWorkers` is resolved lazily inside the pool, so at globalSetup time the config
 * carries it only when set explicitly (config file or CLI). Without one, Vitest
 * derives its worker count from `availableParallelism()` — minus one in run mode,
 * halved in watch mode — so the undiminished value is an upper bound on every pool
 * id in both modes, at the cost of spare clones: one in run mode, up to half the
 * cores in watch mode. Vitest resolves `maxWorkers` with a truthy check — `0` means
 * "unset", not "zero workers" — so this falls through on `0` the same way, or a
 * `--maxWorkers=0` run would find no database provisioned.
 *
 * @example
 * workerCount(project); // 4 when maxWorkers is 4; availableParallelism() when unset or 0
 */
export function workerCount(project: TestProject): number {
  return project.config.maxWorkers || project.vitest.config.maxWorkers || os.availableParallelism();
}

/**
 * The psql argv that clones every Worker Database (`<databaseName>_1..count`) from the
 * template in a single invocation. Each clone is its own `--command` flag: psql runs a
 * multi-statement `--command` in an implicit transaction, and `CREATE DATABASE` refuses
 * to run inside one. `ON_ERROR_STOP` makes the first failed clone abort the invocation
 * with a non-zero exit, since psql otherwise continues past errors and exits 0.
 *
 * @example
 * cloneCommand("prisma_test", "postgres", 2)
 * // → ["psql", "--username", "postgres", "--dbname", "postgres",
 * //    "--set", "ON_ERROR_STOP=1",
 * //    "--command", 'CREATE DATABASE "prisma_test_1" TEMPLATE "prisma_test"',
 * //    "--command", 'CREATE DATABASE "prisma_test_2" TEMPLATE "prisma_test"']
 */
export function cloneCommand(databaseName: string, username: string, count: number): string[] {
  const argv = ["psql", "--username", username, "--dbname", "postgres", "--set", "ON_ERROR_STOP=1"];
  for (let workerId = 1; workerId <= count; workerId++) {
    argv.push(
      "--command",
      `CREATE DATABASE "${databaseName}_${workerId}" TEMPLATE "${databaseName}"`,
    );
  }
  return argv;
}

/**
 * Swap the database in a connection URI for this worker's clone, keeping everything
 * else — credentials, host, port, query parameters — untouched.
 *
 * @example
 * workerDatabaseUrl("postgresql://u:p@host:5432/prisma_test", "prisma_test", "1");
 * // → "postgresql://u:p@host:5432/prisma_test_1"
 */
export function workerDatabaseUrl(
  templateUri: string,
  databaseName: string,
  poolId: string,
): string {
  const url = new URL(templateUri);
  url.pathname = `/${databaseName}_${poolId}`;
  return url.toString();
}
