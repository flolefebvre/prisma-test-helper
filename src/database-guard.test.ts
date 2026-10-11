import { expect, test } from "vitest";

import { isDatabaseSetUp, registerDatabase } from "./database.js";
import type { ResetClient } from "./reset.js";

// The refusals, in a file of their own: module state is per file, and src/database.test.ts
// has already opted in, so there the duplicate-call check would fire first. Every
// refusal must happen on the synchronous path, before any hook is registered or any
// query is sent — the stub below fails the test if it is ever reached.

const untouchable: ResetClient = {
  $queryRawUnsafe: async () => expect.fail("a refused setupDatabase() sent a query"),
  $executeRawUnsafe: async () => expect.fail("a refused setupDatabase() sent a Reset"),
};

test.each([
  ["the Template Database", "postgresql://u:p@localhost:5432/prisma_test", /reset prisma_test —/],
  ["a dev-shaped name", "postgresql://u:p@localhost:5432/myapp", /reset myapp —/],
  ["an unset DATABASE_URL", undefined, /no Worker Database is configured/],
])("refuses %s and leaves the file opted out", (_, url, message) => {
  expect(() => registerDatabase(untouchable, url, "prisma_test")).toThrow(message);
  expect(isDatabaseSetUp()).toBe(false);
});

test("refuses when no Template Database name was provided", () => {
  expect(() =>
    registerDatabase(untouchable, "postgresql://u:p@localhost:5432/prisma_test_1", undefined),
  ).toThrow(/globalSetup/);
  expect(isDatabaseSetUp()).toBe(false);
});
