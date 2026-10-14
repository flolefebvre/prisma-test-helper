import { describe, expect, test } from "vitest";

import { setupDatabase } from "../../src/index.js";
import { db } from "../db/client.js";

// The global setup's `seed` as a consumer relies on it: the two `Tag` rows the seed of
// tests/global-setup.ts inserts, into a table its migration created empty, are Baseline
// rows like the ones a migration inserts. They are there at the start of every test,
// whatever the test before did to them. Tests in this file run in order and lean on it:
// each "after" test reads what the one before it left.

setupDatabase(db);

const TAGS = [
  { id: 1, name: "typescript" },
  { id: 2, name: "postgres" },
];

const tags = () => db.tag.findMany({ orderBy: { id: "asc" } });

describe("rows the seed inserted", () => {
  test("are there in a file's first test", async () => {
    expect(await tags()).toEqual(TAGS);
  });

  test("an insert gets the id after the seed's, not the start value", async () => {
    const tag = await db.tag.create({ data: { name: "vitest" } });

    expect(tag.id).toBe(3);
  });

  test("…and the next test sees only the seed's rows, and gets that same id again", async () => {
    expect(await tags()).toEqual(TAGS);

    const tag = await db.tag.create({ data: { name: "prisma" } });
    expect(tag.id).toBe(3);
  });

  test("an update", async () => {
    await db.tag.update({ where: { id: 1 }, data: { name: "javascript" } });
  });

  test("…is undone", async () => {
    expect(await tags()).toEqual(TAGS);
  });

  test("a delete of every row", async () => {
    await db.tag.deleteMany();
    expect(await db.tag.count()).toBe(0);
  });

  test("…is undone", async () => {
    expect(await tags()).toEqual(TAGS);
  });
});
