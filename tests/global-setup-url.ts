// The url-mode counterpart of tests/global-setup.ts, for the `integration-url` project:
// the same `createGlobalSetup`, pointed at an existing server through `url`. Here a plain
// Postgres container started below stands in for that server — or, when
// PRISMA_TEST_HELPER_URL is already set (scripts/concurrent-url-runs.mjs), the server it
// names. Teardown then checks that the run left no database of its own behind.
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

import { withAdminConnection } from "../src/admin-connection.js";
import { createGlobalSetup } from "../src/global-setup.js";
import { seed } from "./seed.js";

export default async function setup(project: TestProject) {
  const existing = process.env.PRISMA_TEST_HELPER_URL;
  const standIn = existing
    ? undefined
    : await new PostgreSqlContainer("postgres:18-alpine").start();
  const url = existing || standIn!.getConnectionUri();

  try {
    const teardown = await createGlobalSetup({ url, seed })(project);
    return async () => {
      try {
        await teardown();
        await assertNothingLeft(url, project.getProvidedContext().templateDatabaseName);
      } finally {
        await standIn?.stop();
      }
    };
  } catch (error) {
    await standIn?.stop();
    throw error;
  }
}

/** Fail the run if its template, or any `<template>_<n>`, is still on the server. */
async function assertNothingLeft(url: string, template: string): Promise<void> {
  const left = await withAdminConnection(url, (connection) =>
    connection.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname = '${template}' ` +
        `OR datname ~ '^${template}_[0-9]+$'`,
    ),
  );
  if (left.length > 0) {
    throw new Error(`url-mode teardown left ${left.map((row) => row.datname).join(", ")}`);
  }
}
