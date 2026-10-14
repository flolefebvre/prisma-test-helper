import { execFileSync } from "node:child_process";

import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type { TestProject } from "vitest/node";

import { createGlobalSetup } from "./global-setup.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const runtime = vi.hoisted(() => ({
  getContainerRuntimeClient: vi.fn(async () => ({})),
}));
vi.mock("testcontainers", () => runtime);

// A chainable stand-in for PostgreSqlContainer that records what the setup asked
// for (image, database) and hands out one fake started container per run.
const postgres = vi.hoisted(() => {
  const started = {
    getConnectionUri: () => "postgresql://test:test@localhost:32768/prisma_test",
    stop: vi.fn(async () => {}),
  };
  const images: string[] = [];
  const databases: string[] = [];
  class PostgreSqlContainer {
    constructor(image: string) {
      images.push(image);
    }
    withDatabase(name: string) {
      databases.push(name);
      return this;
    }
    withEnvironment() {
      return this;
    }
    withTmpFs() {
      return this;
    }
    withCommand() {
      return this;
    }
    async start() {
      return started;
    }
  }
  return { PostgreSqlContainer, started, images, databases };
});
vi.mock("@testcontainers/postgresql", () => ({
  PostgreSqlContainer: postgres.PostgreSqlContainer,
}));

// A stand-in for pg's Client that records every connection it was opened with and
// every query it was sent. `failOn` makes the query matching it reject the way pg does,
// with Postgres's message.
const pg = vi.hoisted(() => {
  const connections: string[] = [];
  const queries: string[] = [];
  const ended = { count: 0 };
  const failure: { failOn?: string; message?: string } = {};
  class Client {
    constructor(config: { connectionString: string }) {
      connections.push(config.connectionString);
    }
    async connect() {}
    async query(sql: string) {
      queries.push(sql);
      if (failure.failOn !== undefined && sql.includes(failure.failOn)) {
        throw new Error(failure.message);
      }
      return { rows: [] };
    }
    async end() {
      ended.count++;
    }
  }
  return { Client, connections, queries, ended, failure };
});
vi.mock("pg", () => ({ default: { Client: pg.Client } }));

beforeEach(() => {
  postgres.images.length = 0;
  postgres.databases.length = 0;
  pg.connections.length = 0;
  pg.queries.length = 0;
  pg.ended.count = 0;
  delete pg.failure.failOn;
  delete pg.failure.message;
});

function projectWith(maxWorkers: number | undefined): TestProject {
  return {
    config: { maxWorkers },
    vitest: { config: { maxWorkers } },
    provide: vi.fn(),
  } as unknown as TestProject;
}

async function runSetup(
  options?: Parameters<typeof createGlobalSetup>[0],
  project = projectWith(2),
) {
  const teardown = await createGlobalSetup(options)(project);
  return { teardown, project };
}

describe("createGlobalSetup", () => {
  test("defaults to postgres:18-alpine and a prisma_test Template Database", async () => {
    await runSetup();

    expect(postgres.images).toEqual(["postgres:18-alpine"]);
    expect(postgres.databases).toEqual(["prisma_test"]);
  });

  test("honors the image and databaseName options end-to-end", async () => {
    await runSetup({ image: "postgres:16-alpine", databaseName: "acme_test" });

    expect(postgres.images).toEqual(["postgres:16-alpine"]);
    expect(postgres.databases).toEqual(["acme_test"]);
    expect(pg.queries).toEqual([
      'CREATE DATABASE "acme_test_1" TEMPLATE "acme_test"',
      'CREATE DATABASE "acme_test_2" TEMPLATE "acme_test"',
    ]);
  });

  // `CREATE DATABASE` refuses the implicit transaction of a multi-statement query, so
  // every clone must be a query of its own.
  test("clones one Worker Database per worker slot, one query each", async () => {
    await runSetup(undefined, projectWith(3));

    expect(pg.queries).toEqual([
      'CREATE DATABASE "prisma_test_1" TEMPLATE "prisma_test"',
      'CREATE DATABASE "prisma_test_2" TEMPLATE "prisma_test"',
      'CREATE DATABASE "prisma_test_3" TEMPLATE "prisma_test"',
    ]);
  });

  // Anything connected to the template makes `CREATE DATABASE … TEMPLATE` fail
  // (SQLSTATE 55006), so the admin connection goes to `postgres`, once.
  test("clones over one admin connection to the postgres database", async () => {
    await runSetup();

    expect(pg.connections).toEqual(["postgresql://test:test@localhost:32768/postgres"]);
  });

  test("closes the admin connection before the run starts", async () => {
    await runSetup();

    expect(pg.ended.count).toBe(1);
  });

  test("runs the consumer's prisma CLI with DATABASE_URL pointed at the container", async () => {
    await runSetup();

    const [command, args, options] = (execFileSync as Mock).mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      expect.stringMatching(/prisma[\\/]build[\\/]index\.js$/),
      "migrate",
      "deploy",
    ]);
    expect(options.env.DATABASE_URL).toBe("postgresql://test:test@localhost:32768/prisma_test");
  });

  test("provides the Template Database URI to the run", async () => {
    const { project } = await runSetup();

    expect(project.provide).toHaveBeenCalledWith(
      "templateDatabaseUri",
      "postgresql://test:test@localhost:32768/prisma_test",
    );
  });

  // The Template Database name has to cross the process boundary alongside the URI:
  // the worker rewrites the URI path from it, and `setupDatabase` derives the
  // `<databaseName>_<pool id>` guard pattern from it.
  test("provides the Template Database name to the run", async () => {
    const { project } = await runSetup();

    expect(project.provide).toHaveBeenCalledWith("templateDatabaseName", "prisma_test");
  });

  test("provides the configured Template Database name, not the default", async () => {
    const { project } = await runSetup({ databaseName: "myapp_test" });

    expect(project.provide).toHaveBeenCalledWith("templateDatabaseName", "myapp_test");
  });

  test("teardown stops the container", async () => {
    const { teardown } = await runSetup();
    expect(postgres.started.stop).not.toHaveBeenCalled();

    await teardown();

    expect(postgres.started.stop).toHaveBeenCalledTimes(1);
  });

  test("fails actionably, naming Docker, when no container runtime is reachable", async () => {
    runtime.getContainerRuntimeClient.mockRejectedValueOnce(new Error("socket not found"));

    await expect(runSetup()).rejects.toThrow(/start Docker/);
    expect(postgres.images).toHaveLength(0);
  });

  test("surfaces the captured CLI output when migrate fails, and stops the container", async () => {
    (execFileSync as Mock).mockImplementationOnce(() => {
      throw Object.assign(new Error("exit 1"), { stdout: "P3018: migration failed", stderr: "" });
    });

    await expect(runSetup()).rejects.toThrow(/P3018: migration failed/);
    expect(postgres.started.stop).toHaveBeenCalledTimes(1);
  });

  test("keeps the diagnostic error even when stopping the container also fails", async () => {
    (execFileSync as Mock).mockImplementationOnce(() => {
      throw Object.assign(new Error("exit 1"), { stdout: "P3018: migration failed", stderr: "" });
    });
    postgres.started.stop.mockRejectedValueOnce(new Error("daemon gone"));

    await expect(runSetup()).rejects.toThrow(/P3018: migration failed/);
  });

  test("names the failed Worker Database and Postgres's message, and stops the container", async () => {
    pg.failure.failOn = '"prisma_test_2"';
    pg.failure.message = 'database "prisma_test_2" already exists';

    await expect(runSetup()).rejects.toMatchObject({
      message:
        "cloning the Worker Databases from prisma_test failed at prisma_test_2: " +
        'database "prisma_test_2" already exists',
      cause: expect.objectContaining({ message: 'database "prisma_test_2" already exists' }),
    });
    expect(pg.queries).toHaveLength(2);
    expect(postgres.started.stop).toHaveBeenCalledTimes(1);
  });

  test("closes the admin connection when a clone fails", async () => {
    pg.failure.failOn = '"prisma_test_1"';
    pg.failure.message = "boom";

    await expect(runSetup()).rejects.toThrow(/boom/);
    expect(pg.ended.count).toBe(1);
  });
});
