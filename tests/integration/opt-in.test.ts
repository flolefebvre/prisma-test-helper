import { expect, test } from "vitest";

import { isDatabaseSetUp } from "../../src/index.js";

// The other half of the opt-in guard. This file never calls `setupDatabase(db)`, while
// several files in the same run do — and it must still read `false`, because a factory
// reading `true` here would write rows no Reset clears between this file's tests. Under
// `isolate: true` every file has its own module registry; under `isolate: false`
// (the `integration-no-isolate` project) this file may share a worker's modules with a
// neighbour that opted in, and still reads `false` because the `/setup` entry begins each
// file's opt-in state afresh.
//
// (Which files share a worker slot is the pool's choice, so this asserts the contract
// rather than reproducing one specific pairing; src/opt-in.test.ts pins the pairings.)

test("reads false in a file that never opted in", () => {
  expect(isDatabaseSetUp()).toBe(false);
});

test("stays false for the whole file", () => {
  expect(isDatabaseSetUp()).toBe(false);
});
