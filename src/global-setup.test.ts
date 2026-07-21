import { execFileSync } from "node:child_process";

import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type { TestProject } from "vitest/node";

import { cloneCommand, createGlobalSetup, workerCount } from "./global-setup.js";

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
    getUsername: () => "test",
    exec: vi.fn(async () => ({ exitCode: 0, output: "" })),
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

beforeEach(() => {
  postgres.images.length = 0;
  postgres.databases.length = 0;
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

// `cloneCommand` is the pure half of Worker Database provisioning: one psql argv
// that clones every worker slot in a single container exec.

describe("cloneCommand", () => {
  test("carries one CREATE DATABASE … TEMPLATE per worker slot", () => {
    const argv = cloneCommand("prisma_test", "test", 3);

    expect(argv.filter((flag) => flag === "--command")).toHaveLength(3);
    expect(argv.filter((arg) => arg.startsWith("CREATE DATABASE"))).toEqual([
      'CREATE DATABASE "prisma_test_1" TEMPLATE "prisma_test"',
      'CREATE DATABASE "prisma_test_2" TEMPLATE "prisma_test"',
      'CREATE DATABASE "prisma_test_3" TEMPLATE "prisma_test"',
    ]);
  });

  test("derives clone names from the configured database name", () => {
    const argv = cloneCommand("acme_test", "postgres", 1);

    expect(argv).toContain('CREATE DATABASE "acme_test_1" TEMPLATE "acme_test"');
  });

  test("stops at the first error, so a failed clone fails the exec", () => {
    const argv = cloneCommand("prisma_test", "test", 1);

    const flagIndex = argv.indexOf("--set");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(argv[flagIndex + 1]).toBe("ON_ERROR_STOP=1");
  });
});

// Vitest resolves `maxWorkers` with a truthy check, so `0` means "unset" and a real
// worker count is derived. `workerCount` must mirror that: treating `0` as literal
// would provision zero databases while Vitest still forks workers.

describe("workerCount", () => {
  test("passes an explicit maxWorkers through", () => {
    expect(workerCount(projectWith(4))).toBe(4);
  });

  test("treats 0 as unset, like Vitest, and derives a positive count", () => {
    expect(workerCount(projectWith(0))).toBeGreaterThan(0);
  });
});

describe("createGlobalSetup", () => {
  test("defaults to postgres:17-alpine and a prisma_test Template Database", async () => {
    await runSetup();

    expect(postgres.images).toEqual(["postgres:17-alpine"]);
    expect(postgres.databases).toEqual(["prisma_test"]);
  });

  test("honors the image and databaseName options end-to-end", async () => {
    await runSetup({ image: "postgres:16-alpine", databaseName: "acme_test" });

    expect(postgres.images).toEqual(["postgres:16-alpine"]);
    expect(postgres.databases).toEqual(["acme_test"]);
    expect(postgres.started.exec).toHaveBeenCalledWith(cloneCommand("acme_test", "test", 2));
  });

  test("clones one Worker Database per worker slot in a single exec", async () => {
    await runSetup(undefined, projectWith(3));

    expect(postgres.started.exec).toHaveBeenCalledTimes(1);
    expect(postgres.started.exec).toHaveBeenCalledWith(cloneCommand("prisma_test", "test", 3));
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
  // the worker rewrites the URI path from it, and `installTestTransaction` derives the
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

  test("surfaces the psql output when cloning fails, and stops the container", async () => {
    postgres.started.exec.mockResolvedValueOnce({ exitCode: 1, output: "ERROR: already exists" });

    await expect(runSetup()).rejects.toThrow(/ERROR: already exists/);
    expect(postgres.started.stop).toHaveBeenCalledTimes(1);
  });
});
