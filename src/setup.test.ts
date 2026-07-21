import { afterEach, describe, expect, test } from "vitest";

import { setupWorkerDatabase, workerDatabaseUrl } from "./setup.js";

// Everything here runs Docker-free. `workerDatabaseUrl` is the pure half — the path
// rewrite — and is exercised exhaustively. `setupWorkerDatabase`'s own failure modes are
// reachable without a container too: this project registers no `globalSetup`, so
// `inject` returns `undefined` for both keys, which is exactly the half-wired case. Its
// success path needs real provided values and is covered by the dogfood run
// (tests/setup.ts calls it for every integration file).

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

describe("setupWorkerDatabase", () => {
  const poolId = process.env.VITEST_POOL_ID;

  afterEach(() => {
    process.env.VITEST_POOL_ID = poolId;
  });

  test("without VITEST_POOL_ID, names the pool requirement", () => {
    delete process.env.VITEST_POOL_ID;

    expect(() => setupWorkerDatabase()).toThrow(/VITEST_POOL_ID/);
    expect(() => setupWorkerDatabase()).toThrow(/pool: "forks"/);
  });

  test("without a registered globalSetup, names the missing wiring", () => {
    // This project provides neither key — the same state a consumer is in when they
    // added the setup file but never registered the global-setup one.
    expect(() => setupWorkerDatabase()).toThrow(/globalSetup/);
    expect(() => setupWorkerDatabase()).toThrow(/createGlobalSetup/);
  });
});
