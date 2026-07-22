import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
// Brings the "vitest" module into the program so the ProvidedContext augmentation
// below attaches to it; erased from the emitted JS.
import type {} from "vitest";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    /** Connection URI of this run's container, pointing at the Template Database. */
    templateDatabaseUri: string;
    /**
     * Name of the Template Database the Worker Databases were cloned from. Workers
     * rewrite the URI path from it (`<databaseName>_<pool id>`) and the Test Transaction
     * guard derives the shape it admits from it.
     */
    templateDatabaseName: string;
  }
}

/** Options for {@link createGlobalSetup}. */
export interface CreateGlobalSetupOptions {
  /**
   * Postgres image to run. Pin it to the same major as your production database, so a
   * test never runs against a different Postgres than the one you deploy on.
   * @default "postgres:17-alpine"
   */
  image?: string;
  /**
   * Name of the Template Database: migrated once per run, then cloned once per Vitest
   * worker slot into the Worker Databases `<databaseName>_1..N`. It never hosts a test.
   * @default "prisma_test"
   */
  databaseName?: string;
}

// initdb refuses a data directory it does not own, and a tmpfs mount is root-owned.
// PGDATA must therefore be a subdirectory the container creates itself.
const PGDATA_MOUNT = "/var/lib/postgresql/data";
const PGDATA = `${PGDATA_MOUNT}/pgdata`;

/**
 * Build a Vitest `globalSetup` function: `export default createGlobalSetup()` from the
 * file your `globalSetup` config points at.
 *
 * It runs once per test run, in the main process, before any worker is forked. It
 * starts one throwaway Postgres on a random host port, migrates the Template Database
 * with the consumer project's own `prisma migrate deploy`, and clones one Worker
 * Database per worker slot: `<databaseName>_1..maxWorkers`. `VITEST_POOL_ID` is always
 * within that range — the pool leases ids from a fixed `1..maxWorkers` map — so every
 * fork finds its database already provisioned.
 *
 * The clones run here, in one psql invocation, while nothing else is connected to
 * the template. `CREATE DATABASE … TEMPLATE` fails when the template has other
 * connections (SQLSTATE 55006), which is why cloning from inside workers would
 * need a lock; cloning before workers exist needs none.
 */
export function createGlobalSetup(options: CreateGlobalSetupOptions = {}) {
  const { image = "postgres:17-alpine", databaseName = "prisma_test" } = options;

  return async function setup(project: TestProject): Promise<() => Promise<void>> {
    await assertDockerReachable();

    const container = await new PostgreSqlContainer(image)
      .withDatabase(databaseName)
      .withEnvironment({ PGDATA })
      .withTmpFs({ [PGDATA_MOUNT]: "rw,noexec,nosuid" })
      .withCommand([
        "postgres",
        "-c",
        "fsync=off",
        "-c",
        "synchronous_commit=off",
        "-c",
        "full_page_writes=off",
      ])
      .start();

    try {
      migrate(container.getConnectionUri());
      await cloneWorkerDatabases(container, databaseName, workerCount(project));
    } catch (error) {
      // A failed stop (e.g. the daemon died, failing migrate and stop alike) must not
      // mask the diagnostic error being thrown; Ryuk reaps the container regardless.
      await container.stop().catch(() => {});
      throw error;
    }

    project.provide("templateDatabaseUri", container.getConnectionUri());
    project.provide("templateDatabaseName", databaseName);

    // Ryuk is the backstop: it removes the whole session even when Vitest is killed
    // and this teardown never runs.
    return async function teardown(): Promise<void> {
      await container.stop();
    };
  };
}

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
 * `--maxWorkers=0` run would find no database provisioned. Exported for that test.
 *
 * @example
 * workerCount(project); // 4 when maxWorkers is 4; availableParallelism() when unset or 0
 */
export function workerCount(project: TestProject): number {
  return project.config.maxWorkers || project.vitest.config.maxWorkers || os.availableParallelism();
}

/**
 * Fail with an actionable message when no container runtime answers.
 *
 * Testcontainers tries each connection strategy in turn and reports only that they all
 * failed, naming sockets rather than the missing dependency. Probing here separates
 * "Docker is not running" — the one failure a reader is expected to hit and fix — from
 * every other startup failure, which keeps its own error rather than being relabelled.
 */
async function assertDockerReachable(): Promise<void> {
  try {
    await getContainerRuntimeClient();
  } catch (cause) {
    throw new Error(
      "The test suite could not reach a container runtime. " +
        "@flefebvre/prisma-test-helper starts a Postgres container for the run, so " +
        "Docker must be running — start Docker and run the tests again.",
      { cause },
    );
  }
}

/**
 * Apply all migrations to this run's Template Database.
 *
 * Runs the consumer project's own `prisma` CLI — resolved from the working directory
 * and executed with the current Node, so no package manager is involved — relying on
 * Prisma's own schema discovery (`prisma.config.ts`, `./prisma/schema.prisma`, …).
 * `DATABASE_URL` is pointed at the container for the child process only. Output is
 * captured rather than inherited: a clean run should print nothing.
 */
function migrate(databaseUrl: string): void {
  const prismaBin = resolvePrismaBin();
  try {
    execFileSync(process.execPath, [prismaBin, "migrate", "deploy"], {
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (cause) {
    const output =
      cause && typeof cause === "object" && "stdout" in cause
        ? String((cause as { stdout?: unknown }).stdout ?? "") +
          String((cause as { stderr?: unknown }).stderr ?? "")
        : "";
    throw new Error(`\`prisma migrate deploy\` failed:\n${output}`, { cause });
  }
}

/**
 * Resolve the consumer's `prisma` CLI entry point (its published bin, exported as
 * `prisma/build/index.js`), starting from the project that is running Vitest.
 */
function resolvePrismaBin(): string {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  try {
    return require.resolve("prisma/build/index.js");
  } catch (cause) {
    throw new Error(
      "Could not resolve the `prisma` CLI from " +
        process.cwd() +
        ". @flefebvre/prisma-test-helper migrates the Template Database with your " +
        "project's own Prisma — install the `prisma` package (it is a peer " +
        "dependency) and run the tests again.",
      { cause },
    );
  }
}

/**
 * The psql argv that clones every Worker Database (`<databaseName>_1..workerCount`)
 * from the template in a single invocation. Each clone is its own `--command` flag:
 * psql runs a multi-statement `--command` in an implicit transaction, and
 * `CREATE DATABASE` refuses to run inside one. `ON_ERROR_STOP` makes the first
 * failed clone abort the invocation with a non-zero exit, since psql otherwise
 * continues past errors and exits 0. Exported so the argv can be unit-tested
 * without a container.
 *
 * @example
 * cloneCommand("prisma_test", "postgres", 2)
 * // → ["psql", "--username", "postgres", "--dbname", "postgres",
 * //    "--set", "ON_ERROR_STOP=1",
 * //    "--command", 'CREATE DATABASE "prisma_test_1" TEMPLATE "prisma_test"',
 * //    "--command", 'CREATE DATABASE "prisma_test_2" TEMPLATE "prisma_test"']
 */
export function cloneCommand(
  databaseName: string,
  username: string,
  workerCount: number,
): string[] {
  const argv = ["psql", "--username", username, "--dbname", "postgres", "--set", "ON_ERROR_STOP=1"];
  for (let workerId = 1; workerId <= workerCount; workerId++) {
    argv.push(
      "--command",
      `CREATE DATABASE "${databaseName}_${workerId}" TEMPLATE "${databaseName}"`,
    );
  }
  return argv;
}

/**
 * Clone the migrated template into the Worker Databases, via `psql` inside the
 * container — over the local socket, which the official image trusts, so no
 * client library or credentials are involved. One exec covers every clone: the
 * exec round-trip costs more than the clone itself.
 */
async function cloneWorkerDatabases(
  postgres: StartedPostgreSqlContainer,
  databaseName: string,
  workerCount: number,
): Promise<void> {
  const { exitCode, output } = await postgres.exec(
    cloneCommand(databaseName, postgres.getUsername(), workerCount),
  );
  if (exitCode !== 0) {
    throw new Error(`cloning the Worker Databases from ${databaseName} failed:\n${output}`);
  }
}
