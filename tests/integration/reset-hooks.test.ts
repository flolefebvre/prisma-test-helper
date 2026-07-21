import { expect, test } from "vitest";

import { registerResetHook, setupDatabase, type ResetHookContext } from "../../src/index.js";
import { db } from "../db/client.js";

// The Reset Hook seam as a consumer meets it: a factory registers once at import, and the
// harness calls it per test with the name and seed. The seed assertions below are pinned
// to literals rather than compared against the library's own hash — a self-comparison
// would pass even if the algorithm changed under every consumer's feet.

const seen: ResetHookContext[] = [];
let authorsAtHookTime: number | null = null;

registerResetHook(async (context) => {
  seen.push(context);
  // Runs after the Test Transaction opened, so a hook can already query — this is what
  // lets a factory reset sequences against live data.
  authorsAtHookTime = await db.author.count();
});

setupDatabase();

test("receives the running test's name", () => {
  expect(seen).toHaveLength(1);
  expect(seen.at(-1)!.testName).toBe("receives the running test's name");
});

test("receives a seed derived from that name alone", () => {
  // FNV-1a 32-bit of this test's full name. It is a literal on purpose: rerunning this
  // file with `-t "receives a seed derived from that name alone"` must produce the same
  // number as a full-suite run, and only a pinned value can prove that. The seed never
  // draws on the worker id, the file, or the run order.
  expect(seen.at(-1)!.seed).toBe(2828983899);
});

test("runs after the Test Transaction is open", () => {
  // Assert: the hook's own query succeeded, and saw a clean database.
  expect(authorsAtHookTime).toBe(0);
});

test("fires once per test, not once per file", () => {
  expect(seen).toHaveLength(4);
  expect(new Set(seen.map((context) => context.testName)).size).toBe(4);
});
