import { describe, expect, test } from "vitest";
import type { TestProject } from "vitest/node";

import { cloneCommand, workerCount, workerDatabaseUrl } from "./worker-database.js";

// The pure half of Worker Database provisioning and addressing, exercised without a
// container: the clone argv, the worker count, and the per-worker URI rewrite.

function projectWith(maxWorkers: number | undefined): TestProject {
  return {
    config: { maxWorkers },
    vitest: { config: { maxWorkers } },
  } as unknown as TestProject;
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

const TEMPLATE_URI = "postgresql://test:test@localhost:32768/prisma_test";

describe("workerDatabaseUrl", () => {
  test("rewrites the path to this worker's clone", () => {
    expect(workerDatabaseUrl(TEMPLATE_URI, "prisma_test", "1")).toBe(
      "postgresql://test:test@localhost:32768/prisma_test_1",
    );
  });

  test("uses the pool id verbatim, including multi-digit ids", () => {
    expect(workerDatabaseUrl(TEMPLATE_URI, "prisma_test", "12")).toBe(
      "postgresql://test:test@localhost:32768/prisma_test_12",
    );
  });

  test("derives the clone name from the configured template name", () => {
    expect(workerDatabaseUrl("postgresql://u:p@host:5432/myapp_test", "myapp_test", "3")).toBe(
      "postgresql://u:p@host:5432/myapp_test_3",
    );
  });

  test("preserves credentials, host, port and query parameters", () => {
    // Testcontainers can hand back a URI carrying parameters; dropping them would
    // silently change how the worker connects.
    expect(
      workerDatabaseUrl("postgresql://u:s%40cret@127.0.0.1:5433/db?sslmode=disable", "db", "2"),
    ).toBe("postgresql://u:s%40cret@127.0.0.1:5433/db_2?sslmode=disable");
  });
});
