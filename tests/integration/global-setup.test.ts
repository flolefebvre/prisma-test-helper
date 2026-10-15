import { expect, inject, test } from "vitest";

import { templateClient } from "../db/template.js";

// These tests run in both integration projects: against the container the repo's own
// globalSetup file (tests/global-setup.ts) started, and against the existing server the
// url project's (tests/global-setup-url.ts) points at. Either way the Template Database
// is migrated with the fixture schema, seeded, and cloned into `<template>_1..2` (both
// projects pin maxWorkers to 2). What only one mode guarantees lives in
// container.test.ts and tests/url-mode/.

test("migrates the fixture schema into the Template Database", async () => {
  const template = templateClient();

  // The count queries fail unless `prisma migrate deploy` created the tables.
  await expect(template.author.count()).resolves.toBe(0);
  await expect(template.post.count()).resolves.toBe(0);
});

test("snapshots the template's non-empty tables into the harness schema", async () => {
  const template = templateClient();

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
  const template = templateClient();

  // The rows are in the template, and the clones, made after the seed, inherit them —
  // seed.test.ts reads them in a Worker Database.
  expect(await template.tag.findMany({ orderBy: { id: "asc" } })).toEqual([
    { id: 1, name: "typescript" },
    { id: 2, name: "postgres" },
  ]);
});

test("provisions one Worker Database per worker slot", async () => {
  const name = inject("templateDatabaseName");
  const template = templateClient();

  const rows = await template.$queryRawUnsafe<{ datname: string }[]>(
    "SELECT datname FROM pg_database WHERE datname ~ $1 ORDER BY datname",
    `^${name}_[0-9]+$`,
  );

  expect(rows.map((row) => row.datname)).toEqual([`${name}_1`, `${name}_2`]);
});
