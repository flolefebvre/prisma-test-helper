import { PrismaPg } from "@prisma/adapter-pg";
import { afterEach, expect, inject, test } from "vitest";

import { isDatabaseSetUp, setupDatabase } from "../../src/index.js";
import { prepareReset } from "../../src/reset.js";
import { db } from "../db/client.js";
import { PrismaClient } from "../generated/prisma/client.js";

// The Worker Database guard, from a consumer's seat. With real commits a misrouted suite
// would have the Reset empty a real database, so `setupDatabase(db)` refuses anything but
// `<template>_<pool id>`. This file never opts in for real: each refusal happens inside a
// test, with `DATABASE_URL` swapped for the case, and leaves the file opted out.

const workerUrl = process.env.DATABASE_URL!;
// `prisma_test`, or `prisma_test_<run id>` in url mode.
const template = inject("templateDatabaseName");

afterEach(() => {
  process.env.DATABASE_URL = workerUrl;
});

/** `DATABASE_URL` as a misrouted suite would see it: same server, another database. */
function urlFor(databaseName: string): string {
  const url = new URL(workerUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

test.each([template, "myapp"])("setupDatabase refuses %s", (databaseName) => {
  process.env.DATABASE_URL = urlFor(databaseName);

  expect(() => setupDatabase(db)).toThrow(`refusing to reset ${databaseName} —`);
  expect(isDatabaseSetUp()).toBe(false);
});

test("the Reset refuses a client connected elsewhere than DATABASE_URL names", async () => {
  // Arrange: a client module that read some other variable — here, the template's URI.
  const templateDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString: inject("templateDatabaseUri") }),
  });

  try {
    // Act + Assert: refused on the client's own report of where it is connected.
    await expect(prepareReset(templateDb, workerUrl, template)).rejects.toThrow(
      `the client passed to setupDatabase() is connected to ${template}, but DATABASE_URL ` +
        `names ${template}_${process.env.VITEST_POOL_ID}`,
    );
  } finally {
    await templateDb.$disconnect();
  }
});
