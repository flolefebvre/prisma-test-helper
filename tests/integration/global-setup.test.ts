import { PrismaPg } from "@prisma/adapter-pg";
import { expect, inject, onTestFinished, test } from "vitest";

import { PrismaClient } from "../generated/prisma/client.js";

// These tests run against the container the repo's own globalSetup file
// (tests/global-setup.ts) started with the documented defaults: Template Database
// `prisma_test`, migrated with the fixture schema, cloned into `prisma_test_1..2`
// (the integration project pins maxWorkers to 2).

function clientFor(uri: string): PrismaClient {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: uri }) });
  onTestFinished(() => client.$disconnect());
  return client;
}

test("migrates the fixture schema into the Template Database", async () => {
  const template = clientFor(inject("templateDatabaseUri"));

  // The count queries fail unless `prisma migrate deploy` created the tables.
  await expect(template.author.count()).resolves.toBe(0);
  await expect(template.post.count()).resolves.toBe(0);
});

test("provisions one Worker Database per worker slot", async () => {
  const template = clientFor(inject("templateDatabaseUri"));

  const rows = await template.$queryRaw<
    { datname: string }[]
  >`SELECT datname FROM pg_database WHERE datname LIKE 'prisma_test_%' ORDER BY datname`;

  expect(rows.map((row) => row.datname)).toEqual(["prisma_test_1", "prisma_test_2"]);
});

test("provides the Template Database name alongside the URI", () => {
  // The name has to cross the process boundary too: the worker rewrites the URI path
  // from it, and the Test Transaction guard derives its accepted shape from it.
  expect(inject("templateDatabaseName")).toBe("prisma_test");
});
