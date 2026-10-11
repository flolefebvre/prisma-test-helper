import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, expect, test } from "vitest";

import { setupDatabase } from "../../src/index.js";
import { db } from "../db/client.js";
import { PrismaClient } from "../generated/prisma/client.js";

// Commit-and-reset proven from outside the app's client. `other` is a second client on the
// same Worker Database, reading over its own connections — the shape of a queue worker or
// any second process a test drives. It sees exactly what committed, which is now
// everything a test writes, until the Reset clears it.

let other: PrismaClient;

beforeAll(() => {
  // The URL the setup file resolved and exported through the environment — the same one
  // the app's client module was built from.
  other = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
});

afterAll(() => other.$disconnect());

setupDatabase(db);

test("points DATABASE_URL at this worker's Worker Database", () => {
  // Assert: the setup file's rewrite landed — this is the wiring every other guarantee
  // in the suite rests on.
  expect(process.env.DATABASE_URL).toContain(`/prisma_test_${process.env.VITEST_POOL_ID}`);
});

test("a write commits, so a second client sees it mid-test", async () => {
  // Act
  await db.author.create({ data: { name: "isolation-committed" } });

  // Assert: visible over a connection the app's client never touched.
  expect(await other.author.count({ where: { name: "isolation-committed" } })).toBe(1);
});

test("a second client's own write is reset along with the app's", async () => {
  // Arrange: the previous test's row is already gone, from both clients' view.
  expect(await other.author.count()).toBe(0);
  expect(await db.author.count()).toBe(0);

  // Act
  await other.author.create({ data: { name: "isolation-other" } });

  // Assert
  expect(await db.author.count({ where: { name: "isolation-other" } })).toBe(1);
});

test("the Worker Database did not accumulate either row", async () => {
  // Assert: the row is gone for good, from the database itself — the guarantee that
  // lets a whole run reuse one database.
  expect(await other.author.count()).toBe(0);
});
