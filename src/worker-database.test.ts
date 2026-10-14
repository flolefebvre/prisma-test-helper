import { describe, expect, test } from "vitest";
import type { TestProject } from "vitest/node";

import { cloneStatements, databaseUrl, workerCount, workerDatabaseUrl } from "./worker-database.js";

// The pure half of Worker Database provisioning and addressing, exercised without a
// database: the clone statements, the worker count, and the URI rewrites.

function projectWith(maxWorkers: number | undefined): TestProject {
  return {
    config: { maxWorkers },
    vitest: { config: { maxWorkers } },
  } as unknown as TestProject;
}

// The global setup sends each statement as its own query, and names the failing
// Worker Database from the entry it was sending.

describe("cloneStatements", () => {
  test("holds one CREATE DATABASE … TEMPLATE per worker slot, each a single statement", () => {
    expect(cloneStatements("prisma_test", 3)).toEqual([
      {
        workerDatabase: "prisma_test_1",
        statement: 'CREATE DATABASE "prisma_test_1" TEMPLATE "prisma_test"',
      },
      {
        workerDatabase: "prisma_test_2",
        statement: 'CREATE DATABASE "prisma_test_2" TEMPLATE "prisma_test"',
      },
      {
        workerDatabase: "prisma_test_3",
        statement: 'CREATE DATABASE "prisma_test_3" TEMPLATE "prisma_test"',
      },
    ]);
  });

  test("derives clone names from the configured database name", () => {
    expect(cloneStatements("acme_test", 1)).toEqual([
      {
        workerDatabase: "acme_test_1",
        statement: 'CREATE DATABASE "acme_test_1" TEMPLATE "acme_test"',
      },
    ]);
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

describe("databaseUrl", () => {
  test("swaps the path for the named database", () => {
    expect(databaseUrl(TEMPLATE_URI, "postgres")).toBe(
      "postgresql://test:test@localhost:32768/postgres",
    );
  });
});

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
