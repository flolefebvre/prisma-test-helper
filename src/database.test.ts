import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  hashName,
  isDatabaseSetUp,
  registerDatabase,
  registerResetHook,
  type ResetHookContext,
} from "./database.js";
import { beginFile } from "./opt-in.js";
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

/**
 * Where the Reset Hook below logs. Reset Hooks are module-wide, so the lifecycles at the
 * end of this file point it at their own log while they run.
 */
let hookLog = events;

/** Answers the guard's check, the discovery query and the vacuum probe, logging the probe. */
function answerQuery(log: string[], query: string): unknown[] {
  if (query.includes("current_database()::text")) return [{ name: "prisma_test_1" }];
  if (query.includes("t.item AS name")) {
    log.push("vacuum probe");
    return [{ name: '"public"."Author"' }];
  }
  return [{ kind: "table", schema: "public", name: "Author", relkind: "r", start_value: null }];
}

const stub: ResetClient = {
  $queryRawUnsafe: async (query: string) => answerQuery(events, query),
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
  vi.resetConfig();
});

// Short, so the Resets held open below time their hook out quickly; every other hook in
// this file is a stub that settles at once. Set before any hook is registered.
vi.setConfig({ hookTimeout: 500 });

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
    hookLog.push("reset hook");
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

/**
 * A stub client whose next Reset can be held open — past `hookTimeout`, as a slow server
 * would — then released, and can fail. Each lifecycle below gets its own log.
 */
function holdableStub() {
  const log: string[] = [];
  let hold: { gate?: Promise<void>; failWith?: Error } | undefined;
  let release = () => {};

  const client: ResetClient = {
    $queryRawUnsafe: async (query: string) => answerQuery(log, query),
    $executeRawUnsafe: async (query: string) => {
      if (query.startsWith("VACUUM")) {
        log.push("vacuum");
        return 0;
      }
      log.push("reset");
      const held = hold;
      hold = undefined;
      if (held?.gate) {
        await held.gate;
        log.push("held reset finished");
      }
      if (held?.failWith) throw held.failWith;
      return 0;
    },
  };

  return {
    client,
    log,
    /** Hold the next Reset open until {@link releaseSoon}; then fail it, if given. */
    holdNextReset(failWith?: Error) {
      hold = { gate: new Promise<void>((resolve) => (release = resolve)), failWith };
    },
    /** Fail the next Reset at once. */
    failNextReset(error: Error) {
      hold = { failWith: error };
    },
    /**
     * Release the held Reset on the next macrotask — after the hook that calls this has
     * returned and the harness's own hook has started — so a harness hook that did not wait
     * for the Reset would run ahead of it.
     */
    releaseSoon() {
      // Bound now: a Reset held after this call is not the one it releases.
      const releaseHeld = release;
      setTimeout(() => releaseHeld(), 0);
    },
  };
}

/**
 * The errors each test failed with, by test name. Register it before `registerDatabase`:
 * it then runs after the harness's `afterEach` — when that one passed.
 */
function recordTestErrors(): Map<string, string[]> {
  const testErrors = new Map<string, string[]>();
  afterEach(({ task }) => {
    testErrors.set(task.name, task.result?.errors?.map((error) => error.message) ?? []);
  });
  return testErrors;
}

/** The message the Reset's error carries when the stub fails it with "boom". */
const BOOM = /^the Reset could not empty prisma_test_1: boom\n/;

// The Reset's `afterEach` has no timeout of its own: when one outlasts `hookTimeout`,
// Vitest fails that test and moves on while the Reset keeps running. These lifecycles hold
// a Reset open until a hook of the next step releases it, so the timeout always fires and
// the release always comes after it. Each registers in its own describe, after
// `beginFile()` (what the `/setup` entry does per file), so its hooks scope to it.

describe("a Reset that outlasts hookTimeout", () => {
  const stub = holdableStub();
  beforeAll(() => {
    hookLog = stub.log;
  });

  // Registered before `registerDatabase`, so it runs ahead of the harness's `beforeEach`.
  beforeEach(() => stub.releaseSoon());

  beginFile();
  registerDatabase(stub.client, WORKER_URL, "prisma_test");

  test("leaves the normal path unchanged: one Reset, then the hooks", () => {
    expect(stub.log).toEqual(["reset", "reset hook"]);
  });

  test.fails("fails the test whose afterEach it timed out", () => {
    stub.holdNextReset();
  });

  test("is awaited by the next test before the Reset Hooks run", () => {
    expect(stub.log.slice(-3)).toEqual(["reset", "held reset finished", "reset hook"]);
  });
});

describe("a Reset that outlasts hookTimeout, then fails", () => {
  const stub = holdableStub();
  const failure = new Error("boom");
  beforeAll(() => {
    hookLog = stub.log;
  });

  // Registered before `registerDatabase`: runs ahead of the harness's `beforeEach`.
  beforeEach(() => stub.releaseSoon());
  const testErrors = recordTestErrors();

  beginFile();
  registerDatabase(stub.client, WORKER_URL, "prisma_test");

  test.fails("fails the test whose afterEach it timed out", () => {
    stub.holdNextReset(failure);
  });

  test.fails("fails the next test with its own error, before the Reset Hooks", () => {});

  test("fails one test only: the one after runs on a fresh Reset", () => {
    expect(
      testErrors.get("fails the next test with its own error, before the Reset Hooks"),
    ).toEqual([expect.stringMatching(BOOM)]);
    // The failed test ran no Reset Hook: the held Reset failed it first.
    expect(stub.log.slice(-5)).toEqual([
      "reset hook",
      "reset",
      "held reset finished",
      "reset",
      "reset hook",
    ]);
  });
});

describe("a Reset still running when the file ends", () => {
  const stub = holdableStub();
  beforeAll(() => {
    hookLog = stub.log;
  });

  // Registered before `registerDatabase`: with `sequence.hooks: "stack"` this `afterAll`
  // runs after the harness's, and checks the VACUUM waited for the held Reset.
  afterAll(() => {
    expect(stub.log.slice(-4)).toEqual(["reset", "held reset finished", "vacuum probe", "vacuum"]);
  });

  beginFile();
  registerDatabase(stub.client, WORKER_URL, "prisma_test");

  // Registered after: runs ahead of the harness's `afterAll`.
  afterAll(() => stub.releaseSoon());

  test.fails("is awaited by the afterAll before it vacuums", () => {
    stub.holdNextReset();
  });
});

describe("a Reset that outlasts the next test's beforeEach too", () => {
  const stub = holdableStub();
  beforeAll(() => {
    hookLog = stub.log;
  });

  beginFile();
  registerDatabase(stub.client, WORKER_URL, "prisma_test");

  // Registered after: runs ahead of the harness's `afterEach`, once the next test's
  // `beforeEach` has timed out waiting for the held Reset.
  afterEach(({ task }) => {
    if (task.name.startsWith("times out")) stub.releaseSoon();
  });

  test.fails("holds its Reset open", () => {
    stub.holdNextReset();
  });

  test.fails("times out waiting for it in beforeEach", () => {});

  test("never overlaps it: the next Reset starts once it settles", () => {
    // The timed-out test ran no Reset Hook, not even once the held Reset settled.
    expect(stub.log).toEqual([
      "reset",
      "reset hook",
      "reset",
      "held reset finished",
      "reset",
      "reset hook",
    ]);
  });
});

describe("a Reset that fails at once", () => {
  const stub = holdableStub();
  beforeAll(() => {
    hookLog = stub.log;
  });
  const testErrors = recordTestErrors();

  beginFile();
  registerDatabase(stub.client, WORKER_URL, "prisma_test");

  test.fails("fails the test it ran after", () => {
    stub.failNextReset(new Error("boom"));
  });

  test.fails("fails the next test with its error: its database was not emptied", () => {});

  test("fails no other: the test after runs on a fresh Reset", () => {
    expect(
      testErrors.get("fails the next test with its error: its database was not emptied"),
    ).toEqual([expect.stringMatching(BOOM)]);
    expect(stub.log).toEqual(["reset", "reset hook", "reset", "reset", "reset hook"]);
  });
});
