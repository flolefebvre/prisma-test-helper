import { afterAll, describe, expect, test } from "vitest";

import {
  hashName,
  isDatabaseSetUp,
  registerDatabase,
  registerResetHook,
  type ResetHookContext,
} from "./database.js";
import type { ResetClient } from "./reset.js";

// Docker-free: `registerDatabase` — `setupDatabase` with its environment reads made
// explicit — is driven around a stub client that answers the guard's check, the
// discovery query and the vacuum probe, and records every Reset and VACUUM it is sent.
// That is enough to pin the lifecycle's shape: when the Reset runs relative to the Reset
// Hooks, and that the VACUUM between files comes last. That they really empty and vacuum
// a database is proven by tests/integration/reset.test.ts and vacuum.test.ts.

const WORKER_URL = "postgresql://u:p@localhost:5432/prisma_test_1";

/** Records every lifecycle event, so hook ordering relative to the Reset is checkable. */
const events: string[] = [];

const stub: ResetClient = {
  $queryRawUnsafe: async (query: string) => {
    if (query.includes("current_database()::text")) return [{ name: "prisma_test_1" }];
    if (query.includes("t.item AS name")) {
      events.push("vacuum probe");
      return [{ name: '"public"."Author"' }];
    }
    return [{ kind: "table", schema: "public", name: "Author", relkind: "r", start_value: null }];
  },
  $executeRawUnsafe: async (query: string) => {
    events.push(query.startsWith("VACUUM") ? "vacuum" : "reset");
    return 0;
  },
};

// Registered before `registerDatabase()`, so with Vitest's default `sequence.hooks:
// "stack"` it runs after the file's `afterAll` — and fails the file if the VACUUM between
// files did not run last.
afterAll(() => {
  expect(events.slice(-3)).toEqual(["reset", "vacuum probe", "vacuum"]);
});

// Read before `registerDatabase()` runs: the opt-in flag has to start out false, and the
// call below flips it during collection.
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

// Named for the public entry point it stands in for, which also keeps the pinned seed
// below identical to the one the rollback-era suite pinned.
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

  registerDatabase(stub, WORKER_URL, "prisma_test");

  test("flips the opt-in flag that factories guard on", () => {
    expect(setUpBeforeOptIn).toBe(false);
    expect(isDatabaseSetUp()).toBe(true);
  });

  test("resets once before the file's first test, then runs the hooks", () => {
    // The very first events of the file: the `beforeAll` Reset, then this test's hook.
    expect(events.slice(0, 2)).toEqual(["reset", "reset hook"]);
  });

  test("hands each hook the current test name and its seed", () => {
    const context = seen.at(-1)!;

    expect(context.testName).toContain("hands each hook the current test name and its seed");
    expect(context.seed).toBe(hashName(context.testName));
  });

  test("derives the seed from the test name alone, so a -t rerun reproduces it", () => {
    // Pinned literal, not a comparison against `hashName` — a self-comparison would hold
    // even if the seed started drawing on the worker id or the run order. This is the
    // FNV-1a hash of this test's own full name, so any such drift breaks it.
    expect(seen.at(-1)!.seed).toBe(1431033295);
  });

  test("resets after every test, before the next test's hooks, and awaits async hooks", () => {
    expect(events.slice(-3)).toEqual(["reset hook", "reset", "reset hook"]);
    expect(asyncHookFinished).toBe(true);
  });

  test("registers a hook once even when added twice", () => {
    // One entry per invocation, so a Set that stopped deduplicating would leave two
    // entries bearing this test's name.
    const thisTest = seen.at(-1)!.testName;

    expect(seen.filter((context) => context.testName === thisTest)).toHaveLength(1);
  });

  test("a second call in the same file names the duplicate", () => {
    expect(() => registerDatabase(stub, WORKER_URL, "prisma_test")).toThrow(
      "setupDatabase() was called twice in this file",
    );
  });
});
