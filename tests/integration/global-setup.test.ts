import { PrismaPg } from "@prisma/adapter-pg";
import { expect, inject, onTestFinished, test } from "vitest";

import { PrismaClient } from "../generated/prisma/client.js";

// These tests run against the container the repo's own globalSetup file
// (tests/global-setup.ts) started with the documented defaults, plus one
// `postgresSettings` entry (`log_checkpoints: false`): Template Database
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

test("snapshots the template's non-empty tables into the harness schema", async () => {
  const template = clientFor(inject("templateDatabaseUri"));

  // `Category` and `Reading` hold the rows the fixture's migrations insert, `Tag` the rows
  // the seed inserts; `Author` and `Post` are empty, so they stay out of the Baseline.
  const catalog = await template.$queryRawUnsafe<{ name: string; relkind: string }[]>(
    "SELECT name, relkind FROM prisma_test_helper.baseline ORDER BY ordinal",
  );
  expect(catalog).toEqual([
    { name: "Category", relkind: "r" },
    { name: "Reading", relkind: "p" },
    { name: "Tag", relkind: "r" },
  ]);
  const sequences = await template.$queryRawUnsafe<
    { name: string; last_value: string; is_called: boolean }[]
  >("SELECT name, last_value::text, is_called FROM prisma_test_helper.sequence ORDER BY name");
  expect(sequences).toEqual([
    { name: "Category_id_seq", last_value: "3", is_called: true },
    { name: "Reading_id_seq", last_value: "2", is_called: true },
    { name: "Tag_id_seq", last_value: "2", is_called: true },
  ]);
});

test("runs the seed on the Template Database, before the Worker Databases are cloned", async () => {
  const template = clientFor(inject("templateDatabaseUri"));

  // The rows are in the template, and the clones, made after the seed, inherit them —
  // seed.test.ts reads them in a Worker Database.
  expect(await template.tag.findMany({ orderBy: { id: "asc" } })).toEqual([
    { id: 1, name: "typescript" },
    { id: 2, name: "postgres" },
  ]);
});

test("provisions one Worker Database per worker slot", async () => {
  const template = clientFor(inject("templateDatabaseUri"));

  const rows = await template.$queryRaw<
    { datname: string }[]
  >`SELECT datname FROM pg_database WHERE datname LIKE 'prisma_test_%' ORDER BY datname`;

  expect(rows.map((row) => row.datname)).toEqual(["prisma_test_1", "prisma_test_2"]);
});

test("starts the server with postgresSettings applied over the built-in defaults", async () => {
  const template = clientFor(inject("templateDatabaseUri"));
  const show = async (name: string) => {
    const [row] = await template.$queryRawUnsafe<Record<string, string>[]>(`SHOW ${name}`);
    return row?.[name];
  };

  expect(await show("log_checkpoints")).toBe("off");
  // The override merge keeps every default the settings did not name.
  expect(await show("fsync")).toBe("off");
  expect(await show("synchronous_commit")).toBe("off");
  expect(await show("full_page_writes")).toBe("off");
});

test("provides the Template Database name alongside the URI", () => {
  // The name has to cross the process boundary too: the worker rewrites the URI path
  // from it, and the Worker Database guard derives its accepted shape from it.
  expect(inject("templateDatabaseName")).toBe("prisma_test");
});
