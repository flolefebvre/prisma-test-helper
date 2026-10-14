// The pure half of Worker Database provisioning and addressing: how many Worker
// Databases a run needs, the SQL that clones them from the Template Database, and the
// URIs the admin connection and each worker connect through. No container, no I/O — the
// global setup and the per-worker setup feed these from Vitest and Testcontainers, so
// each piece is exercised exhaustively without a database.

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

/** One Worker Database to clone, and the statement that clones it. */
export interface CloneStatement {
  /** Name of the Worker Database the statement creates: `<databaseName>_<n>`. */
  workerDatabase: string;
  statement: string;
}

/**
 * The statements that clone every Worker Database (`<databaseName>_1..count`) from the
 * template, one per worker slot. Each must be sent as its own simple query: a
 * multi-statement string runs in an implicit transaction, and `CREATE DATABASE` refuses
 * to run inside one. Each carries the database it creates, so a failure can name it.
 *
 * @example
 * cloneStatements("prisma_test", 2)
 * // → [{ workerDatabase: "prisma_test_1",
 * //      statement: 'CREATE DATABASE "prisma_test_1" TEMPLATE "prisma_test"' },
 * //    { workerDatabase: "prisma_test_2",
 * //      statement: 'CREATE DATABASE "prisma_test_2" TEMPLATE "prisma_test"' }]
 */
export function cloneStatements(databaseName: string, count: number): CloneStatement[] {
  return Array.from({ length: count }, (_, index) => {
    const workerDatabase = `${databaseName}_${index + 1}`;
    return {
      workerDatabase,
      statement: `CREATE DATABASE "${workerDatabase}" TEMPLATE "${databaseName}"`,
    };
  });
}

/**
 * Swap the database in a connection URI, keeping everything else — credentials, host,
 * port, query parameters — untouched.
 *
 * @example
 * databaseUrl("postgresql://u:p@host:5432/prisma_test", "postgres");
 * // → "postgresql://u:p@host:5432/postgres"
 */
export function databaseUrl(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Swap the database in a connection URI for this worker's clone (see {@link databaseUrl}).
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
  return databaseUrl(templateUri, `${databaseName}_${poolId}`);
}
