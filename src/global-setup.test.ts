import { execFileSync } from "node:child_process";

import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type { TestProject } from "vitest/node";

import {
  BASELINE_CANDIDATES_QUERY,
  HARNESS_SCHEMA_STATEMENT,
  nonEmptyTablesQuery,
  snapshotStatement,
  type BaselineCandidate,
} from "./baseline.js";
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

// A stand-in for pg's Client that records every connection it was opened with, every
// query it was sent, and the order connections opened and closed in. `failOn` makes the
// query matching it reject the way pg does, with Postgres's message; `answers` makes the
// first query containing a key resolve with those rows.
const pg = vi.hoisted(() => {
  const connections: { connectionString: string; ssl?: unknown }[] = [];
  const queries: string[] = [];
  const events: string[] = [];
  const answers = new Map<string, unknown[]>();
  // `failWith` makes closing a connection to `failFor` reject.
  const ended = {
    count: 0,
    failWith: undefined as string | undefined,
    failFor: undefined as string | undefined,
  };
  const failure: { failOn?: string; message?: string } = {};
  class Client {
    readonly database: string;
    constructor(config: { connectionString: string; ssl?: unknown }) {
      connections.push(config);
      this.database = new URL(config.connectionString).pathname.slice(1);
    }
    async connect() {
      events.push(`open ${this.database}`);
    }
    async query(sql: string) {
      queries.push(sql);
      if (failure.failOn !== undefined && sql.includes(failure.failOn)) {
        throw new Error(failure.message);
      }
      for (const [key, rows] of answers) if (sql.includes(key)) return { rows };
      return { rows: [] };
    }
    async end() {
      events.push(`close ${this.database}`);
      ended.count++;
      if (ended.failWith !== undefined && ended.failFor === this.database) {
        throw new Error(ended.failWith);
      }
    }
  }
  return { Client, connections, queries, events, answers, ended, failure };
});
vi.mock("pg", () => ({ default: { Client: pg.Client } }));

beforeEach(() => {
  postgres.images.length = 0;
  postgres.databases.length = 0;
  pg.connections.length = 0;
  pg.queries.length = 0;
  pg.events.length = 0;
  pg.answers.clear();
  pg.ended.count = 0;
  pg.ended.failWith = undefined;
  pg.ended.failFor = undefined;
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

/** The clone statements sent, in order — the install's queries left out. */
const clones = () => pg.queries.filter((query) => query.startsWith("CREATE DATABASE"));

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
    expect(clones()).toEqual([
      'CREATE DATABASE "acme_test_1" TEMPLATE "acme_test"',
      'CREATE DATABASE "acme_test_2" TEMPLATE "acme_test"',
    ]);
  });

  // `CREATE DATABASE` refuses the implicit transaction of a multi-statement query, so
  // every clone must be a query of its own.
  test("clones one Worker Database per worker slot, one query each", async () => {
    await runSetup(undefined, projectWith(3));

    expect(clones()).toEqual([
      'CREATE DATABASE "prisma_test_1" TEMPLATE "prisma_test"',
      'CREATE DATABASE "prisma_test_2" TEMPLATE "prisma_test"',
      'CREATE DATABASE "prisma_test_3" TEMPLATE "prisma_test"',
    ]);
  });

  // Anything connected to the template makes `CREATE DATABASE … TEMPLATE` fail
  // (SQLSTATE 55006), so the clones go over a connection to `postgres`, opened only
  // once the install's connection to the template is closed.
  test("installs over the template, then clones over the postgres database", async () => {
    await runSetup();

    expect(pg.connections).toEqual([
      expect.objectContaining({
        connectionString: "postgresql://test:test@localhost:32768/prisma_test",
      }),
      expect.objectContaining({
        connectionString: "postgresql://test:test@localhost:32768/postgres",
      }),
    ]);
    expect(pg.events).toEqual([
      "open prisma_test",
      "close prisma_test",
      "open postgres",
      "close postgres",
    ]);
  });

  // The container speaks plaintext. Left unset, pg would take TLS from the host's
  // PGSSLMODE (`prefer` and `require` both mean TLS to pg) and fail to connect.
  test("connects without TLS unless the URL asks for it", async () => {
    await runSetup();

    expect(pg.connections).toEqual([
      expect.objectContaining({ ssl: false }),
      expect.objectContaining({ ssl: false }),
    ]);
  });

  test("closes every admin connection before the run starts", async () => {
    await runSetup();

    expect(pg.ended.count).toBe(2);
  });

  describe("the Baseline install", () => {
    const candidates: BaselineCandidate[] = [
      {
        kind: "sequence",
        schema: "public",
        name: "Category_id_seq",
        relkind: "S",
        owner_schema: "public",
        owner_name: "Category",
      },
      ...["Author", "Category"].map((name): BaselineCandidate => ({
        kind: "table",
        schema: "public",
        name,
        relkind: "r",
        owner_schema: null,
        owner_name: null,
      })),
    ];

    test("always creates the harness schema, then reads the candidates, before cloning", async () => {
      await runSetup();

      expect(pg.queries.slice(0, 2)).toEqual([HARNESS_SCHEMA_STATEMENT, BASELINE_CANDIDATES_QUERY]);
      // No table, so nothing to ask about and nothing to snapshot.
      expect(pg.queries.slice(2)).toEqual(clones());
    });

    test("snapshots the tables that hold rows, with the sequences they own", async () => {
      pg.answers.set(BASELINE_CANDIDATES_QUERY, candidates);
      pg.answers.set("AS index WHERE EXISTS", [{ index: 1 }]);

      await runSetup();

      expect(pg.queries.slice(2, 4)).toEqual([
        nonEmptyTablesQuery(candidates.filter((candidate) => candidate.kind === "table")),
        snapshotStatement({
          tables: [{ schema: "public", name: "Category", relkind: "r" }],
          sequences: [{ schema: "public", name: "Category_id_seq" }],
        }),
      ]);
    });

    test("sends no snapshot when every table is empty", async () => {
      pg.answers.set(BASELINE_CANDIDATES_QUERY, candidates);

      await runSetup();

      expect(pg.queries.filter((query) => query.includes("CREATE TABLE"))).toEqual([
        HARNESS_SCHEMA_STATEMENT,
      ]);
    });

    test("names the harness schema when the migrations already created one", async () => {
      pg.failure.failOn = 'CREATE SCHEMA "prisma_test_helper"';
      pg.failure.message = 'schema "prisma_test_helper" already exists';

      await expect(runSetup()).rejects.toThrow(
        'could not create the harness schema "prisma_test_helper" in prisma_test: ' +
          'schema "prisma_test_helper" already exists — the harness owns that schema',
      );
      expect(clones()).toEqual([]);
      expect(pg.ended.count).toBe(1);
      expect(postgres.started.stop).toHaveBeenCalledTimes(1);
    });

    test("names the template when the snapshot fails, and stops the container", async () => {
      pg.answers.set(BASELINE_CANDIDATES_QUERY, candidates);
      pg.answers.set("AS index WHERE EXISTS", [{ index: 0 }]);
      pg.failure.failOn = 'CREATE TABLE "prisma_test_helper"."t1"';
      pg.failure.message = "out of shared memory";

      await expect(runSetup()).rejects.toThrow(
        "snapshotting the Baseline of prisma_test failed: out of shared memory",
      );
      expect(clones()).toEqual([]);
      expect(postgres.started.stop).toHaveBeenCalledTimes(1);
    });
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
    expect(clones()).toHaveLength(2);
    expect(postgres.started.stop).toHaveBeenCalledTimes(1);
  });

  test("closes the admin connection when a clone fails", async () => {
    pg.failure.failOn = '"prisma_test_1"';
    pg.failure.message = "boom";

    await expect(runSetup()).rejects.toThrow(/boom/);
    // The install's connection, then the clones'.
    expect(pg.ended.count).toBe(2);
  });

  test("keeps the clone error when closing the admin connection also fails", async () => {
    pg.failure.failOn = '"prisma_test_1"';
    pg.failure.message = 'database "prisma_test_1" already exists';
    pg.ended.failWith = "Connection terminated unexpectedly";
    pg.ended.failFor = "postgres";

    await expect(runSetup()).rejects.toThrow(/failed at prisma_test_1: .*already exists/);
    expect(postgres.started.stop).toHaveBeenCalledTimes(1);
  });
});
