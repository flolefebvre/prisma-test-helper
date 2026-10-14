import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type { TestProject } from "vitest/node";

import {
  BASELINE_CANDIDATES_QUERY,
  HARNESS_SCHEMA_STATEMENT,
  nonEmptyTablesQuery,
  snapshotStatement,
  type BaselineCandidate,
} from "./baseline.js";
import { createGlobalSetup } from "./global-setup.js";
import { postgresCommand } from "./postgres-command.js";
import {
  lostLockMessage,
  MARKED_DATABASES_QUERY,
  markStatement,
  runLockKey,
  runLockStatement,
  runMarker,
  runUnlockStatement,
  SERVER_CHECK_QUERY,
  sweepFailedMessage,
  sweptMessage,
  tryRunLockStatement,
} from "./server.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const runtime = vi.hoisted(() => ({
  getContainerRuntimeClient: vi.fn(async () => ({})),
}));
vi.mock("testcontainers", () => runtime);

// A chainable stand-in for PostgreSqlContainer that records what the setup asked
// for (image, database, server command) and hands out one fake started container per run.
const postgres = vi.hoisted(() => {
  const started = {
    getConnectionUri: () => "postgresql://test:test@localhost:32768/prisma_test",
    stop: vi.fn(async () => {}),
  };
  const images: string[] = [];
  const databases: string[] = [];
  const commands: string[][] = [];
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
    withCommand(command: string[]) {
      commands.push(command);
      return this;
    }
    async start() {
      return started;
    }
  }
  return { PostgreSqlContainer, started, images, databases, commands };
});
vi.mock("@testcontainers/postgresql", () => ({
  PostgreSqlContainer: postgres.PostgreSqlContainer,
}));

// A stand-in for pg's Client that records every connection it was opened with, every
// query it was sent, and the order connections opened and closed in. `failOn` makes the
// query matching it reject the way pg does, with Postgres's message; `answers` makes the
// first query containing a key resolve with those rows (a function answers each such
// query anew). `connect` makes every connect reject with that message (and `connectCode`
// as its SQLSTATE). `errorListeners`
// holds each client's `error` listener, so a test can drop a connection the way pg does.
const pg = vi.hoisted(() => {
  const connections: { connectionString: string; ssl?: unknown }[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const queries: string[] = [];
  const events: string[] = [];
  const answers = new Map<string, unknown[] | ((sql: string) => unknown[])>();
  // `failWith` makes closing a connection to `failFor` reject.
  const ended = {
    count: 0,
    failWith: undefined as string | undefined,
    failFor: undefined as string | undefined,
  };
  const failure: { failOn?: string; message?: string; connect?: string; connectCode?: string } = {};
  class Client {
    readonly database: string;
    constructor(config: { connectionString: string; ssl?: unknown }) {
      connections.push(config);
      this.database = new URL(config.connectionString).pathname.slice(1);
    }
    on(event: string, listener: (error: Error) => void) {
      if (event === "error") errorListeners.push(listener);
      return this;
    }
    async connect() {
      if (failure.connect !== undefined) {
        throw Object.assign(new Error(failure.connect), { code: failure.connectCode });
      }
      events.push(`open ${this.database}`);
    }
    async query(sql: string) {
      queries.push(sql);
      if (failure.failOn !== undefined && sql.includes(failure.failOn)) {
        throw new Error(failure.message);
      }
      for (const [key, rows] of answers) {
        if (sql.includes(key)) return { rows: typeof rows === "function" ? rows(sql) : rows };
      }
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
  return { Client, connections, errorListeners, queries, events, answers, ended, failure };
});
vi.mock("pg", () => ({ default: { Client: pg.Client } }));

beforeEach(() => {
  postgres.images.length = 0;
  postgres.databases.length = 0;
  postgres.commands.length = 0;
  pg.connections.length = 0;
  pg.errorListeners.length = 0;
  pg.queries.length = 0;
  pg.events.length = 0;
  pg.answers.clear();
  pg.ended.count = 0;
  pg.ended.failWith = undefined;
  pg.ended.failFor = undefined;
  delete pg.failure.failOn;
  delete pg.failure.message;
  delete pg.failure.connect;
  delete pg.failure.connectCode;
  vi.stubEnv("PRISMA_TEST_HELPER_URL", "");
});

// A developer may have PRISMA_TEST_HELPER_URL set: every test starts with it empty.
afterEach(() => {
  vi.unstubAllEnvs();
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

  describe("postgresSettings", () => {
    test("starts the container with the built-in defaults when none are given", async () => {
      await runSetup();

      expect(postgres.commands).toEqual([postgresCommand()]);
    });

    test("starts the container with the command built from the settings", async () => {
      const postgresSettings = { fsync: true, log_min_duration_statement: 0 };
      await runSetup({ postgresSettings });

      expect(postgres.commands).toEqual([postgresCommand(postgresSettings)]);
    });

    // A config error must read as one: reported even when Docker is down, and never
    // after a container started.
    test("fails naming the invalid key before probing Docker or starting a container", async () => {
      runtime.getContainerRuntimeClient.mockClear();

      const error = await runSetup({ postgresSettings: { "log-statement": "all" } }).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^postgresSettings: .*"log-statement"/);
      expect((error as Error).message).not.toMatch(/Docker/);
      expect(runtime.getContainerRuntimeClient).not.toHaveBeenCalled();
      expect(postgres.images).toHaveLength(0);
    });
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

  // A container dies with its run: nothing on it can outlive the run, so nothing is
  // marked, locked or swept.
  test("marks nothing, takes no lock and sweeps nothing", async () => {
    const { teardown } = await runSetup();
    await teardown();

    expect(pg.queries.filter((query) => /COMMENT|advisory|shobj_description/.test(query))).toEqual(
      [],
    );
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

  describe("the seed", () => {
    const TEMPLATE_URI = "postgresql://test:test@localhost:32768/prisma_test";
    const SESSIONS_QUERY =
      "SELECT count(*)::int AS count FROM pg_stat_activity " +
      "WHERE datname = 'prisma_test' AND backend_type = 'client backend'";
    const sessionChecks = () => pg.queries.filter((query) => query.includes("pg_stat_activity"));

    beforeEach(() => {
      pg.answers.set("pg_stat_activity", [{ count: 0 }]);
      (execFileSync as Mock).mockImplementation(() => {
        pg.events.push("migrate");
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      (execFileSync as Mock).mockReset();
    });

    test("runs once, after migrate and before the install and the clones, on the template", async () => {
      const seed = vi.fn(() => {
        pg.events.push("seed");
      });

      await runSetup({ seed });

      expect(seed).toHaveBeenCalledTimes(1);
      expect(seed).toHaveBeenCalledWith(TEMPLATE_URI);
      // The check's connection to `postgres`, then the install's to the template, then
      // the clones'.
      expect(pg.events).toEqual([
        "migrate",
        "seed",
        "open postgres",
        "close postgres",
        "open prisma_test",
        "close prisma_test",
        "open postgres",
        "close postgres",
      ]);
      expect(pg.queries[0]).toBe(SESSIONS_QUERY);
      expect(pg.queries[1]).toBe(HARNESS_SCHEMA_STATEMENT);
    });

    test("awaits an async seed before going on", async () => {
      await runSetup({
        seed: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          pg.events.push("seed done");
        },
      });

      expect(pg.events.slice(0, 3)).toEqual(["migrate", "seed done", "open postgres"]);
    });

    // Autovacuum workers and other background processes report the template's name in
    // pg_stat_activity too, but `CREATE DATABASE … TEMPLATE` waits them out itself.
    test("counts only client backends connected to the template", async () => {
      await runSetup({ seed: () => {}, databaseName: "it's_test" });

      expect(sessionChecks()).toEqual([
        "SELECT count(*)::int AS count FROM pg_stat_activity " +
          "WHERE datname = 'it''s_test' AND backend_type = 'client backend'",
      ]);
    });

    test("fails naming the seed, with its error as cause, and stops the container", async () => {
      const error = new Error("duplicate key value violates unique constraint");

      await expect(
        runSetup({
          seed: async () => {
            throw error;
          },
        }),
      ).rejects.toMatchObject({
        message: "the seed failed: duplicate key value violates unique constraint",
        cause: error,
      });
      expect(pg.connections).toEqual([]);
      expect(postgres.started.stop).toHaveBeenCalledTimes(1);
    });

    test("waits for a backend that exits a moment after its client disconnected", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      let checks = 0;
      pg.answers.set("pg_stat_activity", () => [{ count: ++checks < 3 ? 1 : 0 }]);

      const run = runSetup({ seed: () => {} });
      await vi.advanceTimersByTimeAsync(2_000);
      await run;

      expect(sessionChecks()).toHaveLength(3);
      expect(clones()).toHaveLength(2);
    });

    test("fails actionably when the seed left a connection open, and clones nothing", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      pg.answers.set("pg_stat_activity", [{ count: 1 }]);

      const run = runSetup({ seed: () => {} });
      const failed = expect(run).rejects.toThrow(
        "the seed left a connection open to the Template Database prisma_test " +
          "(1 session(s) still connected after 2 s) — disconnect your client " +
          "(e.g. await db.$disconnect()) before the seed returns",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await failed;

      expect(sessionChecks()).toHaveLength(20);
      expect(clones()).toEqual([]);
      // Nothing is installed either: the check's connection is the only one opened.
      expect(pg.events).toEqual(["migrate", "open postgres", "close postgres"]);
      expect(postgres.started.stop).toHaveBeenCalledTimes(1);
    });

    test("without a seed, nothing is checked", async () => {
      await runSetup();

      expect(sessionChecks()).toEqual([]);
      expect(pg.connections).toHaveLength(2);
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

describe("createGlobalSetup in url mode", () => {
  const SERVER = "postgresql://app:s3cret@db.internal:5432/postgres";
  const REDACTED = "postgresql://app:***@db.internal:5432/postgres";
  const TEMPLATE = /^prisma_test_[0-9a-f]{8}$/;
  const check = (row: Record<string, unknown> = {}) =>
    pg.answers.set("rolsuper", [
      { role: "app", superuser: true, version_num: 180000, version: "18.0", ...row },
    ]);

  beforeEach(() => {
    runtime.getContainerRuntimeClient.mockClear();
    check();
  });

  /** The Template Database name the run provided to the workers. */
  const providedTemplate = (project: TestProject): string =>
    (project.provide as Mock).mock.calls.find(([key]) => key === "templateDatabaseName")![1];

  const created = () => pg.queries.filter((query) => query.startsWith("CREATE DATABASE"));
  const drops = () => pg.queries.filter((query) => query.startsWith("DROP DATABASE"));

  test("starts no container and never probes Docker", async () => {
    await runSetup({ url: SERVER });

    expect(runtime.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(postgres.images).toHaveLength(0);
  });

  test("checks the server, then creates a template unique to the run, then clones it", async () => {
    const { project } = await runSetup({ url: SERVER });

    const template = providedTemplate(project);
    expect(template).toMatch(TEMPLATE);
    expect(pg.queries[0]).toContain("rolsuper");
    expect(created()).toEqual([
      `CREATE DATABASE "${template}"`,
      `CREATE DATABASE "${template}_1" TEMPLATE "${template}"`,
      `CREATE DATABASE "${template}_2" TEMPLATE "${template}"`,
    ]);
  });

  test("migrates and provides the template's URL on the given server", async () => {
    const { project } = await runSetup({ url: SERVER });

    const url = `postgresql://app:s3cret@db.internal:5432/${providedTemplate(project)}`;
    expect((execFileSync as Mock).mock.calls[0]![2].env.DATABASE_URL).toBe(url);
    expect(project.provide).toHaveBeenCalledWith("templateDatabaseUri", url);
  });

  // The URL may name any database: the harness connects through it, never writes into it.
  test("does its admin work over the URL as given, and installs over the template", async () => {
    const { project } = await runSetup({ url: SERVER });

    expect(pg.connections.map(({ connectionString }) => connectionString)).toEqual([
      SERVER,
      `postgresql://app:s3cret@db.internal:5432/${providedTemplate(project)}`,
      SERVER,
    ]);
  });

  test("gives each run its own template", async () => {
    const first = providedTemplate((await runSetup({ url: SERVER })).project);
    const second = providedTemplate((await runSetup({ url: SERVER })).project);

    expect(first).not.toBe(second);
  });

  test("lets PRISMA_TEST_HELPER_URL override the url option", async () => {
    vi.stubEnv("PRISMA_TEST_HELPER_URL", "postgresql://dev:pw@localhost:5433/app");

    await runSetup({ url: SERVER });

    // The held connection goes to the server's postgres database; the clones, to the URL.
    expect(pg.connections[0]!.connectionString).toBe("postgresql://dev:pw@localhost:5433/postgres");
    expect(pg.connections.at(-1)!.connectionString).toBe("postgresql://dev:pw@localhost:5433/app");
  });

  test("runs in url mode from PRISMA_TEST_HELPER_URL alone", async () => {
    vi.stubEnv("PRISMA_TEST_HELPER_URL", SERVER);

    const { project } = await runSetup();

    expect(postgres.images).toHaveLength(0);
    expect(providedTemplate(project)).toMatch(TEMPLATE);
  });

  test("starts a container when the url option is empty", async () => {
    await runSetup({ url: "" });

    expect(postgres.images).toEqual(["postgres:18-alpine"]);
  });

  test("refuses the url option alongside image or postgresSettings, before any I/O", async () => {
    await expect(
      runSetup({ url: SERVER, image: "postgres:16-alpine", postgresSettings: {} }),
    ).rejects.toThrow(/^url: cannot be combined with image and postgresSettings/);
    expect(runtime.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(pg.connections).toHaveLength(0);
  });

  // The env var switches one machine over a shared config that pins `image`.
  test("ignores image and postgresSettings under PRISMA_TEST_HELPER_URL, saying so on stderr", async () => {
    vi.stubEnv("PRISMA_TEST_HELPER_URL", SERVER);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runSetup({ image: "postgres:16-alpine", postgresSettings: { fsync: true } });

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "@flefebvre/prisma-test-helper: ignoring image and postgresSettings — " +
        "PRISMA_TEST_HELPER_URL is set, so the run uses that server and starts no container.",
    );
    expect(postgres.images).toHaveLength(0);
  });

  test("refuses a role that is not a superuser before creating anything", async () => {
    check({ superuser: false });

    await expect(runSetup({ url: SERVER })).rejects.toThrow(
      `the role "app" on the Postgres server ${REDACTED} is not a superuser`,
    );
    expect(created()).toEqual([]);
    expect(drops()).toEqual([]);
  });

  test("refuses a server older than Postgres 13 before creating anything", async () => {
    check({ version_num: 120022, version: "12.22" });

    await expect(runSetup({ url: SERVER })).rejects.toThrow(/runs Postgres 12\.22 — url mode/);
    expect(created()).toEqual([]);
  });

  test("refuses a databaseName too long for the run's names before connecting", async () => {
    await expect(
      runSetup({ url: SERVER, databaseName: "d".repeat(52) }, projectWith(10)),
    ).rejects.toThrow(/^databaseName: "d+" is too long for url mode/);
    expect(pg.connections).toHaveLength(0);
  });

  test("names the source and the redacted server when it cannot connect, keeping pg's error", async () => {
    pg.failure.connect = "connect ECONNREFUSED 10.0.0.5:5432";

    const error = (await runSetup({ url: SERVER }).catch((thrown: unknown) => thrown)) as Error;

    expect(error.message).toBe(
      `could not connect to the Postgres server given by \`url\` (${REDACTED}): ` +
        "connect ECONNREFUSED 10.0.0.5:5432 — check that the server is reachable from the " +
        "test process and the URL's credentials are right",
    );
    expect(error.cause).toMatchObject({ message: "connect ECONNREFUSED 10.0.0.5:5432" });
    expect(error.message).not.toContain("s3cret");
  });

  test("teardown drops every Worker Database and the template, one query each", async () => {
    const { teardown, project } = await runSetup({ url: SERVER });
    const template = providedTemplate(project);
    pg.connections.length = 0;

    await teardown();

    expect(drops()).toEqual([
      `DROP DATABASE IF EXISTS "${template}_1" WITH (FORCE)`,
      `DROP DATABASE IF EXISTS "${template}_2" WITH (FORCE)`,
      `DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`,
    ]);
    // Over a fresh admin connection, closed once done.
    expect(pg.connections.map(({ connectionString }) => connectionString)).toEqual([SERVER]);
    expect(pg.events.at(-1)).toBe("close postgres");
  });

  test("drops what the run derived when setup fails partway, keeping the diagnostic error", async () => {
    pg.failure.failOn = '_2" TEMPLATE';
    pg.failure.message = "disk full";

    await expect(runSetup({ url: SERVER })).rejects.toThrow(
      /failed at prisma_test_[0-9a-f]{8}_2: disk full/,
    );
    expect(drops()).toHaveLength(3);
  });

  test("teardown attempts every drop, then names each database it could not drop", async () => {
    const { teardown, project } = await runSetup({ url: SERVER });
    const template = providedTemplate(project);
    pg.failure.failOn = `"${template}_1"`;
    pg.failure.message = "permission denied";

    await expect(teardown()).rejects.toThrow(
      `could not drop this run's databases on ${REDACTED}: ${template}_1 (permission denied) — ` +
        'drop them by hand with DROP DATABASE "<name>" WITH (FORCE)',
    );
    expect(drops()).toHaveLength(3);
  });

  describe("Run markers, the run lock and the Sweep", () => {
    /** The run id of the run, read back from its template's name. */
    const runIdOf = (project: TestProject) => providedTemplate(project).slice(-8);

    const DEAD = "0a1b2c3d";
    const LIVE = "ffffffff";
    // What the listing returns: a dead run's two databases, a live run's template, and a
    // database whose comment only starts like a marker.
    const leftovers = () =>
      pg.answers.set("shobj_description", [
        { datname: `prisma_test_${DEAD}`, marker: runMarker(DEAD) },
        { datname: `prisma_test_${DEAD}_1`, marker: runMarker(DEAD) },
        { datname: `app_test_${LIVE}`, marker: runMarker(LIVE) },
        { datname: "prisma_test_0b1b2c3d", marker: `${runMarker("0b1b2c3d")} (kept)` },
      ]);
    // Only the dead run's lock is free.
    const deadRunUnlocked = () =>
      pg.answers.set("pg_try_advisory_lock", (sql) => [
        { locked: sql.includes(`, ${runLockKey(DEAD)})`) },
      ]);

    // Advisory locks are per database: runs whose URLs name different databases must
    // still lock, and sweep, in the same one.
    test("holds its lock and sweeps on the postgres database, whatever the URL names", async () => {
      const app = "postgresql://app:s3cret@db.internal:5432/app";

      const { teardown, project } = await runSetup({ url: app });
      await teardown();

      expect(pg.connections.map(({ connectionString }) => connectionString)).toEqual([
        SERVER,
        `postgresql://app:s3cret@db.internal:5432/${providedTemplate(project)}`,
        app,
        app,
      ]);
      expect(pg.queries.slice(0, 2)).toEqual([
        SERVER_CHECK_QUERY,
        runLockStatement(runIdOf(project)),
      ]);
    });

    test("fails before creating anything when the server has no postgres database", async () => {
      pg.failure.connect = 'database "postgres" does not exist';
      pg.failure.connectCode = "3D000";

      const error = (await runSetup({ url: SERVER }).catch((thrown: unknown) => thrown)) as Error;

      expect(error.message).toBe(
        `the Postgres server ${REDACTED} has no "postgres" database — url mode needs one: ` +
          "each run holds its lock there, and sweeps the databases killed runs left from " +
          "there, so that runs whose URLs name different databases still see each other. " +
          "Create it (CREATE DATABASE postgres), or remove url to run in a container.",
      );
      expect(error.cause).toMatchObject({ code: "3D000" });
      expect(pg.queries).toEqual([]);
    });

    test("checks the server, takes its own lock, sweeps, then creates and marks the template", async () => {
      const { project } = await runSetup({ url: SERVER });
      const template = providedTemplate(project);

      expect(pg.queries.slice(0, 5)).toEqual([
        SERVER_CHECK_QUERY,
        runLockStatement(runIdOf(project)),
        MARKED_DATABASES_QUERY,
        `CREATE DATABASE "${template}"`,
        markStatement(template, runIdOf(project)),
      ]);
    });

    test("marks every Worker Database right after cloning it", async () => {
      const { project } = await runSetup({ url: SERVER });
      const template = providedTemplate(project);
      const runId = runIdOf(project);

      expect(
        pg.queries.filter((query) => /^(CREATE DATABASE|COMMENT)/.test(query)).slice(2),
      ).toEqual([
        `CREATE DATABASE "${template}_1" TEMPLATE "${template}"`,
        markStatement(`${template}_1`, runId),
        `CREATE DATABASE "${template}_2" TEMPLATE "${template}"`,
        markStatement(`${template}_2`, runId),
      ]);
    });

    test("names the Worker Database when marking it fails, and drops what the run derived", async () => {
      pg.failure.failOn = '_1" IS';
      pg.failure.message = "must be owner of database";

      await expect(runSetup({ url: SERVER })).rejects.toThrow(
        /failed at prisma_test_[0-9a-f]{8}_1: must be owner of database/,
      );
      expect(drops()).toHaveLength(3);
    });

    test("drops a dead run's marked databases under its lock, and leaves a live run's alone", async () => {
      leftovers();
      deadRunUnlocked();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { project } = await runSetup({ url: SERVER });

      const sweep = pg.queries.slice(
        pg.queries.indexOf(MARKED_DATABASES_QUERY) + 1,
        pg.queries.indexOf(`CREATE DATABASE "${providedTemplate(project)}"`),
      );
      expect(sweep).toEqual([
        tryRunLockStatement(DEAD),
        `DROP DATABASE IF EXISTS "prisma_test_${DEAD}" WITH (FORCE)`,
        `DROP DATABASE IF EXISTS "prisma_test_${DEAD}_1" WITH (FORCE)`,
        runUnlockStatement(DEAD),
        tryRunLockStatement(LIVE),
      ]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        sweptMessage(REDACTED, [`prisma_test_${DEAD}`, `prisma_test_${DEAD}_1`]),
      );
    });

    test("sweeps silently when no run left anything", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await runSetup({ url: SERVER });

      expect(warn).not.toHaveBeenCalled();
    });

    test("warns about a leftover it could not drop, and goes on with the run", async () => {
      leftovers();
      deadRunUnlocked();
      pg.failure.failOn = `"prisma_test_${DEAD}_1" WITH`;
      pg.failure.message = "permission denied";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { project } = await runSetup({ url: SERVER });

      expect(providedTemplate(project)).toMatch(TEMPLATE);
      expect(pg.queries).toContain(runUnlockStatement(DEAD));
      expect(warn).toHaveBeenCalledWith(sweptMessage(REDACTED, [`prisma_test_${DEAD}`]));
      expect(warn).toHaveBeenCalledWith(
        sweepFailedMessage(REDACTED, [`prisma_test_${DEAD}_1 (permission denied)`]),
      );
    });

    test("fails when the listing fails, creating nothing and closing its connection", async () => {
      pg.failure.failOn = "shobj_description";
      pg.failure.message = "canceling statement due to statement timeout";

      await expect(runSetup({ url: SERVER })).rejects.toThrow(
        "canceling statement due to statement timeout",
      );
      expect(created()).toEqual([]);
      expect(drops()).toEqual([]);
      expect(pg.events).toEqual(["open postgres", "close postgres"]);
    });

    test("closes its held connection when the server check refuses it", async () => {
      check({ superuser: false });

      await expect(runSetup({ url: SERVER })).rejects.toThrow(/is not a superuser/);
      expect(pg.events).toEqual(["open postgres", "close postgres"]);
    });

    test("drops the template and closes its held connection when marking the template fails", async () => {
      pg.failure.failOn = "COMMENT ON";
      pg.failure.message = "must be owner of database";

      await expect(runSetup({ url: SERVER })).rejects.toThrow(
        /^could not create the Template Database prisma_test_[0-9a-f]{8} on .*: must be owner/,
      );
      expect(drops()).toHaveLength(3);
      expect(pg.events).toEqual([
        "open postgres",
        "open postgres",
        "close postgres",
        "close postgres",
      ]);
    });

    // The lock must stay held until the run's databases are gone, or a run starting
    // in between could take this one for dead.
    test("teardown releases the lock only after the drops: the held connection closes last", async () => {
      const { teardown } = await runSetup({ url: SERVER });
      pg.events.length = 0;
      pg.answers.set("DROP DATABASE", () => {
        pg.events.push("drop");
        return [];
      });

      await teardown();

      expect(pg.events).toEqual([
        "open postgres",
        "drop",
        "drop",
        "drop",
        "close postgres",
        "close postgres",
      ]);
      expect(pg.errorListeners).toHaveLength(4);
    });

    test("teardown closes the held connection even when a drop fails", async () => {
      const { teardown } = await runSetup({ url: SERVER });
      pg.events.length = 0;
      pg.failure.failOn = "DROP DATABASE";
      pg.failure.message = "permission denied";

      await expect(teardown()).rejects.toThrow(/could not drop this run's databases/);
      expect(pg.events.filter((event) => event.startsWith("close"))).toHaveLength(2);
    });

    test("warns once when the held connection drops, and teardown does not close it again", async () => {
      const { teardown } = await runSetup({ url: SERVER });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const held = pg.errorListeners[0]!;

      held(new Error("Connection terminated unexpectedly"));
      held(new Error("Connection terminated unexpectedly"));
      pg.events.length = 0;
      await teardown();

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        lostLockMessage(REDACTED, "Connection terminated unexpectedly"),
      );
      expect(pg.events.filter((event) => event.startsWith("close"))).toHaveLength(1);
    });
  });
});
