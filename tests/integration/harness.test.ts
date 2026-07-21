import { afterEach, expect, test } from "vitest";

import { isDatabaseSetUp, setupDatabase } from "../../src/index.js";
import { db } from "../db/client.js";

// Ported from pvm3.0's harness suite: the smoke test that the whole recipe works from a
// consumer's seat. Nothing here reaches for library internals — `setupDatabase()` and the
// mocked client module are the entire surface, which is the point. `db` is the Routing
// Proxy, installed by the Client Seam in tests/setup.ts.

setupDatabase();

test("reports the file as opted in, so factories may run", () => {
  // The `true` half of the guard; tests/integration/opt-in.test.ts holds the `false` half.
  expect(isDatabaseSetUp()).toBe(true);
});

test("inserts an author and reads it back", async () => {
  // Arrange
  await db.author.create({ data: { name: "Ada" } });

  // Act
  const authors = await db.author.findMany();

  // Assert
  expect(authors).toHaveLength(1);
  expect(authors[0]?.name).toBe("Ada");
});

test("starts empty — the previous test's transaction was rolled back", async () => {
  // Assert: this test runs after the insert above, yet the table is empty, proving every
  // test starts from a pristine Worker Database.
  expect(await db.author.count()).toBe(0);
});

test("a relation written across two tables is rolled back whole", async () => {
  // Arrange + Act: the required relation makes this two statements in one transaction.
  const author = await db.author.create({
    data: { name: "Grace", posts: { create: [{ title: "On compilers" }] } },
    include: { posts: true },
  });

  // Assert
  expect(author.posts).toHaveLength(1);
  expect(await db.post.count()).toBe(1);
});

test("the relation is gone too", async () => {
  // Assert: both tables, not just the one the test touched directly.
  expect(await db.author.count()).toBe(0);
  expect(await db.post.count()).toBe(0);
});

// Pins the ordering `setupDatabase`'s docs promise: registered after that call, this
// hook is *earlier* in the reverse-order stack than the rollback, so the database is
// still reachable from it. If the rollback ever ran first, the query below would throw
// the engine's "no test transaction live" error and fail the test.
let cleanupSawLiveTransaction = false;

afterEach(async () => {
  await db.author.count();
  cleanupSawLiveTransaction = true;
});

test("cleanup registered after setupDatabase() runs inside the live transaction", () => {
  // Assert on the previous test's afterEach — this one's has not run yet.
  expect(cleanupSawLiveTransaction).toBe(true);
});
