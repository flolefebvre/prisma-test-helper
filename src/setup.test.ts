import { afterEach, describe, expect, test } from "vitest";

import { setupWorkerDatabase } from "./setup.js";

// Everything here runs Docker-free. The pure half, the path rewrite, is
// `workerDatabaseUrl`, tested in worker-database.test.ts. `setupWorkerDatabase`'s own
// failure modes are reachable without a container too: this project registers no
// `globalSetup`, so `inject` returns `undefined` for both keys, which is exactly the
// half-wired case. Its success path needs real provided values and is covered by the
// dogfood run (tests/setup.ts calls it for every integration file).

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
    // The path the docs prescribe, so the error and the docs name the same file.
    expect(() => setupWorkerDatabase()).toThrow('globalSetup: ["tests/global-setup.ts"]');
  });
});
