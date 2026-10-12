import { afterAll, expect, test } from "vitest";

import { setupDatabase, type ResetClient } from "../../src/index.js";
import { db } from "../db/client.js";

// The VACUUM between files is best effort: when it fails, the file still passes. This
// file hands `setupDatabase` the app's client with every VACUUM made to fail, and passes
// only if the `afterAll` that sends it swallows the failure — an error there would fail
// the file. The heaps it leaves nonzero only cost the next file some speed.

const vacuums: string[] = [];

const failingVacuum: ResetClient = {
  $queryRawUnsafe: (query, ...values) => db.$queryRawUnsafe(query, ...values),
  $executeRawUnsafe: (query, ...values) => {
    if (!query.startsWith("VACUUM")) return db.$executeRawUnsafe(query, ...values);
    vacuums.push(query);
    return Promise.reject(new Error("VACUUM refused"));
  },
};

// Registered before `setupDatabase`, so with Vitest's default `sequence.hooks: "stack"` it
// runs after the harness's `afterAll`: the VACUUM was attempted, and it failed.
afterAll(() => {
  expect(vacuums).toHaveLength(1);
  expect(vacuums[0]).toMatch(/^VACUUM \(SKIP_LOCKED\) .*"public"\."Author"/);
});

setupDatabase(failingVacuum);

test("writes a table, so the file ends with a heap to vacuum", async () => {
  await db.author.create({ data: { name: "left behind" } });

  expect(await db.author.count()).toBe(1);
});
