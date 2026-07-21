import { afterEach, beforeEach, expect } from "vitest";

import { testTransaction } from "./transaction.js";

/** What every Reset Hook receives when it runs. */
export interface ResetHookContext {
  /** Vitest's name for the running test, describe blocks included. */
  testName: string;
  /**
   * A deterministic 32-bit seed derived from `testName` alone — never from the worker
   * id, the file, or the run order. Rerunning one test with `-t` therefore hands it the
   * same seed the full-suite run did, so faker produces the same data both times.
   */
  seed: number;
}

/** A callback registered with {@link registerResetHook}. May be async; it is awaited. */
export type ResetHook = (context: ResetHookContext) => void | Promise<void>;

// Vitest isolates test files (`isolate: true`), so this module is re-instantiated per
// file: the flag below resets for each, and hooks registered by one file's imports never
// leak into another's.
let databaseSetUp = false;

/**
 * Whether {@link setupDatabase} has run in this test file.
 *
 * Factories read it to fail loudly when a file forgot to opt in, rather than run against
 * an unseeded generator or — worse — outside any Test Transaction, where their writes
 * would commit.
 *
 * @example
 * if (!isDatabaseSetUp()) {
 *   throw new Error("call setupDatabase() at the top of this test file");
 * }
 */
export function isDatabaseSetUp(): boolean {
  return databaseSetUp;
}

const resetHooks = new Set<ResetHook>();

/**
 * Register a callback to run in every `beforeEach`, after the Test Transaction opens.
 *
 * This is the seam factories plug into: reset a per-test sequence counter, seed faker
 * from `seed`, or anything else that must be fresh per test. Hooks are held in a Set, so
 * registering the same function twice runs it once. The library itself never depends on
 * faker — it only hands you the seed.
 *
 * @example
 * registerResetHook(({ seed }) => {
 *   faker.seed(seed);
 *   nextId = 0;
 * });
 */
export function registerResetHook(hook: ResetHook): void {
  resetHooks.add(hook);
}

/**
 * Opt a test file into the database. Call it once, at the top of the file.
 *
 * Wraps every test in its own Test Transaction: a `beforeEach` opens it and runs the
 * Reset Hooks; an `afterEach` rolls it back, discarding every write — the Worker
 * Database itself never changes, so each test starts from the same pristine clone.
 * Because Vitest runs `afterEach` hooks in reverse registration order, cleanup a test
 * registers itself (`onTestFinished`, a later `afterEach`) still runs while the
 * transaction is live.
 *
 * @example
 * import { setupDatabase } from "@flolefebvre/prisma-test-helper";
 * import { db } from "../src/db/client.js";
 *
 * setupDatabase();
 *
 * test("persists an author", async () => {
 *   await db.author.create({ data: { name: "Ada" } });
 *   expect(await db.author.count()).toBe(1);
 * });
 */
export function setupDatabase(): void {
  databaseSetUp = true;

  beforeEach(async () => {
    await testTransaction().start();
    const testName = expect.getState().currentTestName ?? "";
    const seed = hashName(testName);
    // Sequential, not Promise.all: hooks reset shared per-test state, and the order they
    // were registered in is the order a consumer can reason about.
    for (const hook of resetHooks) await hook({ testName, seed });
  });

  afterEach(async () => {
    await testTransaction().rollback();
  });
}

/**
 * FNV-1a, 32-bit — a small, fast, well-mixed string hash. Exported for its own unit
 * test; consumers receive its result as `seed` rather than calling it.
 *
 * @example
 * hashName("persists an author"); // → a stable uint32
 */
export function hashName(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
