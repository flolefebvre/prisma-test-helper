import { expect, test } from "vitest";

import { isDatabaseSetUp } from "../../src/index.js";

// The other half of the opt-in guard. This file never calls `setupDatabase()`, while
// several files in the same run do — and it must still read `false`, because a factory
// reading `true` here would happily write to a database with no Test Transaction live
// and commit. The guarantee comes from `isolate: true` giving every file its own module
// registry; under `isolate: false` this file would inherit a neighbour's opt-in whenever
// the pool assigned them the same worker.
//
// (Which files share a worker slot is the pool's choice, so this asserts the contract
// rather than reproducing one specific pairing.)

test("reads false in a file that never opted in", () => {
  expect(isDatabaseSetUp()).toBe(false);
});

test("stays false for the whole file", () => {
  expect(isDatabaseSetUp()).toBe(false);
});
