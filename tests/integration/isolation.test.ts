import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, expect, test } from "vitest";

import { setupDatabase } from "../../src/index.js";
import { db } from "../db/client.js";
import { PrismaClient } from "../generated/prisma/client.js";

// Rollback proven from outside the transaction. `db` is the Routing Proxy, so its own
// reads see uncommitted rows by definition; `committed` is a second client on the same
// Worker Database, reading over its own connection, so it sees only what actually
// committed. Names are scoped to this file: other integration files share this Worker
// Database when the pool assigns them the same slot.

let committed: PrismaClient;

beforeAll(() => {
  // The URL the setup file resolved and exported through the environment — the same one
  // the Client Seam handed the engine.
  committed = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
});

afterAll(() => committed.$disconnect());

setupDatabase();

test("points DATABASE_URL at this worker's Worker Database", () => {
  // Assert: the setup file's rewrite landed — this is the wiring every other guarantee
  // in the suite rests on.
  expect(process.env.DATABASE_URL).toContain(`/prisma_test_${process.env.VITEST_POOL_ID}`);
});

test("a write through the harness never reaches the Worker Database", async () => {
  // Act
  await db.author.create({ data: { name: "isolation-uncommitted" } });

  // Assert: live in the transaction, absent from the database itself.
  expect(await db.author.count({ where: { name: "isolation-uncommitted" } })).toBe(1);
  expect(await committed.author.count({ where: { name: "isolation-uncommitted" } })).toBe(0);
});

test("the Worker Database did not accumulate the previous test's row", async () => {
  // Assert: the row is gone for good — not merely invisible while its transaction was
  // live. This is the guarantee that lets a whole run reuse one database.
  expect(await committed.author.count({ where: { name: "isolation-uncommitted" } })).toBe(0);
  expect(await db.author.count({ where: { name: "isolation-uncommitted" } })).toBe(0);
});
