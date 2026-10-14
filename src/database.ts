import { afterAll, afterEach, beforeAll, beforeEach, expect, inject } from "vitest";

import { isOptedIn, markOptedIn } from "./opt-in.js";
import {
  assertWorkerDatabase,
  prepareReset,
  type PreparedReset,
  type ResetClient,
} from "./reset.js";

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

// Whether this file opted in lives in ./opt-in.js, which the `/setup` entry clears at the
// start of every file — so it is per file under `isolate: true` (this module is new per
// file) and under `isolate: false` (this module serves every file on its worker) alike.
// The Reset Hooks below are per module instance instead: per file under `isolate: true`,
// per worker under `isolate: false`, where a hook registered by one file carries over.

/**
 * Whether {@link setupDatabase} has run in this test file.
 *
 * Factories read it to fail loudly when a file forgot to opt in, rather than run against
 * an unseeded generator and write rows that no Reset clears between that file's tests.
 *
 * @example
 * if (!isDatabaseSetUp()) {
 *   throw new Error("call setupDatabase(db) at the top of this test file");
 * }
 */
export function isDatabaseSetUp(): boolean {
  return isOptedIn();
}

const resetHooks = new Set<ResetHook>();

/**
 * Register a callback to run in every `beforeEach`, before the test body, against a
 * database the previous Reset already returned to its Baseline: empty, but for the rows
 * the migrations inserted.
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
 * Opt a test file into the database. Call it once, at the top of the file, with the
 * Prisma client your app uses.
 *
 * Tests commit for real; the Reset returns the Worker Database to its Baseline around
 * them — every table empty but those the migrations left rows in, which it restores. A
 * `beforeAll` runs it once, so the file starts clean whatever an earlier file on this
 * worker left behind, and an `afterEach` runs it after every test. A `beforeEach` runs
 * the Reset Hooks. An `afterAll` vacuums the tables the file wrote to and every Baseline
 * table, which keeps the next file's Resets cheap; it is best effort and never fails the
 * file.
 *
 * It refuses — synchronously, before registering anything — unless `DATABASE_URL` names
 * a Worker Database: with real commits, a misrouted suite would empty a real database.
 * The `beforeAll` also checks that `db` is connected to that same database before the
 * first Reset.
 *
 * Vitest runs `afterEach` hooks in reverse registration order (`sequence.hooks:
 * "stack"`, the default), so an `afterEach` your file registers *after* this call still
 * sees the test's rows. `onTestFinished` callbacks run after the Reset, so rows they
 * write survive into the next test. Writes in a `beforeAll` of your own are allowed but
 * last only until the first test's Reset.
 *
 * @example
 * import { setupDatabase } from "@flefebvre/prisma-test-helper";
 * import { db } from "../src/db/client.js";
 *
 * setupDatabase(db);
 *
 * test("persists an author", async () => {
 *   await db.author.create({ data: { name: "Ada" } });
 *   expect(await db.author.count()).toBe(1);
 * });
 */
export function setupDatabase(db: ResetClient): void {
  // Typed as `string`, but `inject` is a plain lookup in the context the main process
  // provided: an unregistered globalSetup yields `undefined` at runtime, not an error.
  const templateName = inject("templateDatabaseName") as string | undefined;
  registerDatabase(db, process.env.DATABASE_URL, templateName);
}

/**
 * {@link setupDatabase} with its two environment reads made explicit, so the lifecycle
 * can be unit-tested without a provided context. Internal: not on the package root.
 */
export function registerDatabase(
  db: ResetClient,
  databaseUrl: string | undefined,
  templateName: string | undefined,
): void {
  if (isOptedIn()) {
    throw new Error(
      "setupDatabase() was called twice in this file — call it once, at the top of the file",
    );
  }
  if (!databaseUrl || !templateName) {
    throw new Error(
      "refusing to reset — no Worker Database is configured for this file. " +
        "`setupWorkerDatabase()` must run from a file listed in `setupFiles`, and the " +
        "global-setup file exporting `createGlobalSetup()` must be listed in `globalSetup`.",
    );
  }
  assertWorkerDatabase(databaseUrl, templateName);
  markOptedIn();

  let prepared: PreparedReset | undefined;

  beforeAll(async () => {
    prepared = await prepareReset(db, databaseUrl, templateName);
    await prepared.reset();
  });

  beforeEach(async () => {
    const testName = expect.getState().currentTestName ?? "";
    const seed = hashName(testName);
    // Sequential, not Promise.all: hooks reset shared per-test state, and the order they
    // were registered in is the order a consumer can reason about.
    for (const hook of resetHooks) await hook({ testName, seed });
  });

  afterEach(async () => {
    // Unset only when the `beforeAll` failed — which Vitest has already reported, and
    // which skipped every test, so there is nothing to reset.
    await prepared?.reset();
  });

  afterAll(async () => {
    // Returns the heaps this file wrote to 0 bytes, so the next file's first Reset on a
    // fresh backend skips those tables unopened, and clears the dead rows Baseline
    // restores left. Never rejects; unset as above.
    await prepared?.vacuum();
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
