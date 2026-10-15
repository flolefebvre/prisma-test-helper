import { describe, expect, test } from "vitest";

import { isDatabaseSetUp, registerDatabase } from "./database.js";
import { beginFile } from "./opt-in.js";
import type { ResetClient } from "./reset.js";

// Docker-free: the opt-in state across test files on one worker, as `isolate: false`
// sees it. This file is one module registry, like a worker that keeps its modules across
// files; `beginFile()` stands in for the `/setup` entry, which calls it at the start of
// every file (setup.test.ts pins that). Every step runs during collection, where
// `setupDatabase(db)` runs in a real file, and the tests read what each step saw. Which
// files share a worker is the pool's choice, so the integration project
// (`integration-no-isolate`) proves the whole thing end to end instead.

const WORKER_URL = "postgresql://u:p@localhost:5432/prisma_test_1";

const stub: ResetClient = {
  $queryRawUnsafe: async (query: string) =>
    query.includes("current_database()::text") ? [{ name: "prisma_test_1" }] : [],
  $executeRawUnsafe: async () => 0,
};

/** The error `register` threw, if any. */
function attempt(register: () => void): unknown {
  try {
    register();
    return undefined;
  } catch (error) {
    return error;
  }
}

// File 1 opts in.
beginFile();
const firstFile = attempt(() => registerDatabase(stub, WORKER_URL, "prisma_test"));
const firstFileSetUp = isDatabaseSetUp();

// File 2, on the same worker, never opts in.
beginFile();
const optedOutFileSetUp = isDatabaseSetUp();

// File 3 opts in, then calls `setupDatabase` a second time.
beginFile();
const thirdFile = attempt(() => registerDatabase(stub, WORKER_URL, "prisma_test"));
const thirdFileSetUp = isDatabaseSetUp();
const thirdFileTwice = attempt(() => registerDatabase(stub, WORKER_URL, "prisma_test"));

describe("the opt-in across files on one worker", () => {
  test("the first file opts in", () => {
    expect(firstFile).toBeUndefined();
    expect(firstFileSetUp).toBe(true);
  });

  test("a file that never opted in reads false after a neighbour opted in", () => {
    expect(optedOutFileSetUp).toBe(false);
  });

  test("a later file opts in without being called a duplicate", () => {
    expect(thirdFile).toBeUndefined();
    expect(thirdFileSetUp).toBe(true);
  });

  test("a second call within one file still throws", () => {
    expect(thirdFileTwice).toBeInstanceOf(Error);
    expect((thirdFileTwice as Error).message).toContain(
      "setupDatabase() was called twice in this file",
    );
  });
});
