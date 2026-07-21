import { describe, expect, test } from "vitest";

import {
  hashName,
  isDatabaseSetUp,
  registerResetHook,
  setupDatabase,
  type ResetHookContext,
} from "./database.js";
import { installTestTransaction, type MinimalClient } from "./transaction.js";

// Docker-free: the engine is installed around a stub client that parks its "transaction"
// the way a real one does — `$transaction` calls the callback, which hangs until the
// engine rejects it on rollback. That is enough to drive `setupDatabase`'s hooks without
// a database. The per-test rollback these hooks produce is proven for real by the
// dogfood suite (tests/integration/harness.test.ts).

const WORKER_URL = "postgresql://u:p@localhost:5432/prisma_test_1";

/** Records every engine event, so hook ordering relative to the transaction is checkable. */
const events: string[] = [];

const stub: MinimalClient = {
  $transaction: (async (
    fn: (tx: { $executeRawUnsafe: () => Promise<unknown> }) => Promise<unknown>,
  ) => {
    events.push("transaction opened");
    return fn({ $executeRawUnsafe: async () => undefined });
  }) as MinimalClient["$transaction"],
};

installTestTransaction(stub, WORKER_URL, "prisma_test");

// Read before `setupDatabase()` runs: the opt-in flag has to start out false, and
// `setupDatabase()` below flips it during collection.
const setUpBeforeOptIn = isDatabaseSetUp();

// The FNV-1a offset basis and prime are fixed, so these are the values every consumer of
// the library will see for these names — pinned here to catch a silent algorithm change,
// which would reshuffle every project's test data.
describe("hashName", () => {
  test("is a stable 32-bit hash of the test name", () => {
    expect(hashName("")).toBe(2166136261);
    expect(hashName("a")).toBe(3826002220);
    expect(hashName("persists a user")).toBe(hashName("persists a user"));
  });

  test("different names hash differently", () => {
    expect(hashName("creates a post")).not.toBe(hashName("creates a user"));
  });

  test("stays an unsigned 32-bit integer", () => {
    for (const name of ["", "a", "creates a post", "x".repeat(500), "é — ünïcode"]) {
      const seed = hashName(name);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("setupDatabase", () => {
  const seen: ResetHookContext[] = [];
  let asyncHookFinished = false;

  const hook = (context: ResetHookContext) => {
    events.push("reset hook");
    seen.push(context);
  };
  // Registered twice on purpose: hooks are held in a Set, so one registration wins.
  registerResetHook(hook);
  registerResetHook(hook);

  registerResetHook(async () => {
    await Promise.resolve();
    asyncHookFinished = true;
  });

  setupDatabase();

  test("flips the opt-in flag that factories guard on", () => {
    expect(setUpBeforeOptIn).toBe(false);
    expect(isDatabaseSetUp()).toBe(true);
  });

  test("hands each hook the current test name and its seed", () => {
    const context = seen.at(-1)!;

    expect(context.testName).toContain("hands each hook the current test name and its seed");
    expect(context.seed).toBe(hashName(context.testName));
  });

  test("derives the seed from the test name alone, so a -t rerun reproduces it", () => {
    // Nothing about the worker, the file, or the run order feeds the seed: the same
    // name yields the same number in any process.
    const context = seen.at(-1)!;

    expect(context.seed).toBe(hashName(context.testName));
    expect(hashName(context.testName)).toBe(hashName(context.testName));
  });

  test("runs hooks after the transaction opens, and awaits async ones", () => {
    expect(events.slice(-2)).toEqual(["transaction opened", "reset hook"]);
    expect(asyncHookFinished).toBe(true);
  });

  test("registers a hook once even when added twice", () => {
    expect(events.filter((event) => event === "reset hook")).toHaveLength(seen.length);
  });
});
