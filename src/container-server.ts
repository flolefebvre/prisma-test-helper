// The default server provider: a throwaway Postgres container, private to the run. The
// Template Database is created with the container, under `databaseName` itself — nothing
// else can reach the server, so the name needs no run id — and teardown stops the whole
// container, every database in it included.

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";

import { postgresCommand, type PostgresSettingValue } from "./postgres-command.js";
import type { ServerHandle } from "./server.js";
import { databaseUrl } from "./worker-database.js";

// initdb refuses a data directory it does not own, and a tmpfs mount is root-owned.
// PGDATA must therefore be a subdirectory the container creates itself.
// From 18 the image's VOLUME is /var/lib/postgresql: this tmpfs nests inside it, the
// data directory still lives on tmpfs, and the empty volume goes with the container at stop.
const PGDATA_MOUNT = "/var/lib/postgresql/data";
const PGDATA = `${PGDATA_MOUNT}/pgdata`;

/**
 * Start the run's container on a random host port, with its data directory on tmpfs and
 * the server command built from `postgresSettings`, and hand back its {@link ServerHandle}.
 * The admin URL is the container's `postgres` database.
 */
export async function startContainerServer(options: {
  image: string;
  databaseName: string;
  postgresSettings: Record<string, PostgresSettingValue> | undefined;
}): Promise<ServerHandle> {
  // Built first: a malformed setting name is a config error, reported as such even
  // when Docker is down, and never after a container started.
  const command = postgresCommand(options.postgresSettings);
  await assertDockerReachable();

  const container = await new PostgreSqlContainer(options.image)
    .withDatabase(options.databaseName)
    .withEnvironment({ PGDATA })
    .withTmpFs({ [PGDATA_MOUNT]: "rw,noexec,nosuid" })
    .withCommand(command)
    .start();

  return {
    templateName: options.databaseName,
    templateUrl: container.getConnectionUri(),
    adminUrl: databaseUrl(container.getConnectionUri(), "postgres"),
    // Ryuk is the backstop: it removes the whole session even when Vitest is killed
    // and this teardown never runs.
    teardown: async () => {
      await container.stop();
    },
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
