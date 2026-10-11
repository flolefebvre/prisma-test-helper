import { afterEach, expect, onTestFinished, test } from "vitest";

import { isDatabaseSetUp, setupDatabase } from "../../src/index.js";
import { db } from "../db/client.js";

// Ported from pvm3.0's harness suite: the smoke test that the whole recipe works from a
// consumer's seat. Nothing here reaches for library internals — `setupDatabase(db)` and
// the app's own client module are the entire surface, which is the point.

setupDatabase(db);

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

test("starts empty — the previous test's rows were reset", async () => {
  // Assert: this test runs after the insert above, yet the table is empty, proving every
  // test starts from an empty Worker Database.
  expect(await db.author.count()).toBe(0);
});

test("a relation written across two tables commits whole", async () => {
  // Arrange + Act: the required relation makes this two inserts.
  const author = await db.author.create({
    data: { name: "Grace", posts: { create: [{ title: "On compilers" }] } },
    include: { posts: true },
  });

  // Assert
  expect(author.posts).toHaveLength(1);
  expect(await db.post.count()).toBe(1);
});

test("the relation is gone too", async () => {
  // Assert: both tables, not just the one the test touched directly — the Reset empties
  // tables bound by a foreign key without a cascade.
  expect(await db.author.count()).toBe(0);
  expect(await db.post.count()).toBe(0);
});

// Pins the ordering `setupDatabase`'s docs promise: registered after that call, this hook
// is *earlier* in the reverse-order stack than the Reset, so it still sees the test's
// rows.
let authorsSeenByCleanup: number | null = null;

afterEach(async () => {
  authorsSeenByCleanup = await db.author.count();
});

test("cleanup registered after setupDatabase() runs before the Reset", async () => {
  await db.author.create({ data: { name: "cleanup-sees-me" } });
});

test("…and saw the previous test's row", () => {
  // Assert on the previous test's afterEach — this one's has not run yet.
  expect(authorsSeenByCleanup).toBe(1);
});

test("onTestFinished cleanup can still read the database", async () => {
  // Fired after every afterEach, so past the Reset: the database is empty, but reachable
  // — nothing parks or closes a connection between tests any more. (Rows written here
  // would survive into the next test; the docs keep writes in afterEach.)
  onTestFinished(async () => {
    expect(await db.author.count()).toBe(0);
  });
  await db.author.create({ data: { name: "finished" } });
});
