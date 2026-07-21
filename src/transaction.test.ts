import { describe, expect, test } from "vitest";

import {
  assertWorkerDatabase,
  TestTransaction,
  testTransaction,
  type MinimalClient,
} from "./transaction.js";

// Everything in this file runs without a database: the guard is a pure check, and the
// engine's error paths all fire before any query reaches the client. The stub below is
// shaped like the slice of a Prisma client the Routing Proxy touches — none of its
// members is ever invoked, because every call is intercepted first.

function stubClient() {
  return {
    $transaction: (async () => undefined) as MinimalClient["$transaction"],
    $queryRaw: async () => undefined as unknown,
    $disconnect: async () => undefined,
    author: { findMany: () => undefined as unknown },
  };
}

const WORKER_URL = "postgresql://u:p@localhost:5432/prisma_test_1";

// `assertWorkerDatabase` guards the entry to every Test Transaction. Worker Databases
// are named `<databaseName>_<pool id>`, so the guard admits exactly that shape: every
// near-miss below is refused, including the Template Database itself and — the case the
// guard exists for — the dev database.

describe("assertWorkerDatabase", () => {
  test("accepts a worker database name", () => {
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/prisma_test_1", "prisma_test"),
    ).not.toThrow();
  });

  test("accepts a multi-digit worker id", () => {
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/prisma_test_12", "prisma_test"),
    ).not.toThrow();
  });

  test("rejects `prisma_test` — the Template Database hosts no test transaction", () => {
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/prisma_test", "prisma_test"),
    ).toThrow("refusing to open a test transaction on prisma_test");
  });

  test("rejects `prisma_test_` — an underscore with no worker id", () => {
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/prisma_test_", "prisma_test"),
    ).toThrow("refusing to open a test transaction on prisma_test_");
  });

  test("rejects `prisma_test_1x` — a worker id must be digits only", () => {
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/prisma_test_1x", "prisma_test"),
    ).toThrow("refusing to open a test transaction on prisma_test_1x");
  });

  test("rejects `prisma_testx` — a longer name sharing the prefix", () => {
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/prisma_testx", "prisma_test"),
    ).toThrow("refusing to open a test transaction on prisma_testx");
  });

  test("rejects `myapp` — the dev database is what this guard exists to refuse", () => {
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/myapp", "myapp_test"),
    ).toThrow("refusing to open a test transaction on myapp");
  });

  test("rejects a URL with no path — the database name is empty", () => {
    expect(() => assertWorkerDatabase("postgresql://u:p@localhost:5432", "prisma_test")).toThrow(
      "refusing to open a test transaction on ",
    );
  });

  test("derives the pattern from the configured name, not a hard-coded one", () => {
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/myapp_test_3", "myapp_test"),
    ).not.toThrow();
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/prisma_test_1", "myapp_test"),
    ).toThrow("refusing to open a test transaction on prisma_test_1");
  });

  test("matches the configured name literally, not as a regex", () => {
    // A `.` in the name must not act as a wildcard admitting a foreign database.
    expect(() =>
      assertWorkerDatabase("postgresql://u:p@localhost:5432/myxapp_1", "my.app"),
    ).toThrow("refusing to open a test transaction on myxapp_1");
  });

  test("throws on an empty string — not a parseable URL", () => {
    expect(() => assertWorkerDatabase("", "prisma_test")).toThrow(/Invalid URL/);
  });

  test("throws on a malformed URL", () => {
    expect(() => assertWorkerDatabase("not a url", "prisma_test")).toThrow(/Invalid URL/);
  });
});

describe("engine guards", () => {
  test("start() refuses a non-worker database before touching the client", async () => {
    const url = "postgresql://u:p@localhost:5432/prisma_test";
    const engine = new TestTransaction(stubClient(), url, "prisma_test");

    await expect(engine.start()).rejects.toThrow(
      "refusing to open a test transaction on prisma_test",
    );
  });

  test("a delegate call with no live transaction throws the actionable error", () => {
    const engine = new TestTransaction(stubClient(), WORKER_URL, "prisma_test");
    expect(() => engine.client.author.findMany()).toThrow(/setupDatabase/);
  });

  test("a raw method with no live transaction throws the actionable error", () => {
    const engine = new TestTransaction(stubClient(), WORKER_URL, "prisma_test");
    expect(() => engine.client.$queryRaw()).toThrow(/setupDatabase/);
  });

  test("$transaction with no live transaction throws the actionable error", () => {
    const engine = new TestTransaction(stubClient(), WORKER_URL, "prisma_test");
    expect(() => engine.client.$transaction(async () => undefined)).toThrow(/setupDatabase/);
  });

  test("rollback() before start() is a no-op", async () => {
    const engine = new TestTransaction(stubClient(), WORKER_URL, "prisma_test");
    await expect(engine.rollback()).resolves.toBeUndefined();
  });

  test("non-query properties pass through to the underlying client", () => {
    const engine = new TestTransaction(stubClient(), WORKER_URL, "prisma_test");
    expect(typeof engine.client.$disconnect).toBe("function");
  });

  test("engine access before install throws its own actionable error", () => {
    // This file never calls `installTestTransaction`, so the worker-level engine slot
    // is empty — exactly the state of a suite whose Client Seam never ran.
    expect(() => testTransaction()).toThrow(/module mock/);
  });
});
