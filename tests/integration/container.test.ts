import { expect, inject, test } from "vitest";

import { templateClient } from "../db/template.js";

// Container mode only — the url project excludes this file. These tests run against the
// container the repo's own globalSetup file (tests/global-setup.ts) started with the
// documented defaults, plus one `postgresSettings` entry (`log_checkpoints: false`):
// Template Database `prisma_test`, with no run id, cloned into exactly
// `prisma_test_1..2` — the container is private to the run — and the container's own
// tuning, which an existing server never gets.

test("provisions exactly one Worker Database per worker slot, under the bare name", async () => {
  const template = templateClient();

  const rows = await template.$queryRaw<
    { datname: string }[]
  >`SELECT datname FROM pg_database WHERE datname LIKE 'prisma_test_%' ORDER BY datname`;

  expect(rows.map((row) => row.datname)).toEqual(["prisma_test_1", "prisma_test_2"]);
});

test("starts the server with postgresSettings applied over the built-in defaults", async () => {
  const template = templateClient();
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
