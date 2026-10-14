import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
// Brings the "vitest" module into the program so the ProvidedContext augmentation
// below attaches to it; erased from the emitted JS.
import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { withAdminConnection } from "./admin-connection.js";
import { cloneStatements, databaseUrl, workerCount } from "./worker-database.js";

declare module "vitest" {
  interface ProvidedContext {
    /** Connection URI of this run's container, pointing at the Template Database. */
    templateDatabaseUri: string;
    /**
     * Name of the Template Database the Worker Databases were cloned from. Workers
     * rewrite the URI path from it (`<databaseName>_<pool id>`) and the Worker Database
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
   * @default "postgres:18-alpine"
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
// From 18 the image's VOLUME is /var/lib/postgresql: this tmpfs nests inside it, the
// data directory still lives on tmpfs, and the empty volume goes with the container at stop.
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
 * The clones run here, over one admin connection to the `postgres` database that is
 * closed before this returns, while nothing is connected to the template.
 * `CREATE DATABASE … TEMPLATE` fails when the template has other connections
 * (SQLSTATE 55006), which is why cloning from inside workers would need a lock;
 * cloning before workers exist needs none.
 */
export function createGlobalSetup(options: CreateGlobalSetupOptions = {}) {
  const { image = "postgres:18-alpine", databaseName = "prisma_test" } = options;

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
      await cloneWorkerDatabases(
        databaseUrl(container.getConnectionUri(), "postgres"),
        databaseName,
        workerCount(project),
      );
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
 * Clone the migrated template into the Worker Databases, over an admin connection to
 * `adminUrl` — the `postgres` database, never the template, which must have no
 * connections while it is cloned.
 *
 * It goes through `pg` from this process, not a client inside the container, because
 * that is the harness's one SQL path: it can return rows, which the Baseline snapshot
 * (#38) reads back, and it needs no container to run in, which the `url` mode (#44)
 * lacks. Each clone is its own query — `CREATE DATABASE` refuses to run in the implicit
 * transaction of a multi-statement string — and the first failure stops the run,
 * naming the Worker Database that failed.
 */
async function cloneWorkerDatabases(
  adminUrl: string,
  databaseName: string,
  count: number,
): Promise<void> {
  await withAdminConnection(adminUrl, async (connection) => {
    for (const { workerDatabase, statement } of cloneStatements(databaseName, count)) {
      try {
        await connection.query(statement);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `cloning the Worker Databases from ${databaseName} failed at ${workerDatabase}: ${message}`,
          { cause },
        );
      }
    }
  });
}
