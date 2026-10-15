import { randomBytes } from "node:crypto";

import { expect, inject, test } from "vitest";

import { openUrlServer } from "../../src/url-server.js";
import { templateClient } from "../db/template.js";

// url mode only — the `integration-url` project runs this file, after
// tests/global-setup-url.ts pointed `createGlobalSetup({ url })` at an existing server.
// The rest of the suite (tests/integration/, less container.test.ts) runs there too.

test("names the Template Database after databaseName and an 8-hex run id", async () => {
  const name = inject("templateDatabaseName");
  const template = templateClient();

  expect(name).toMatch(/^prisma_test_[0-9a-f]{8}$/);
  const [row] = await template.$queryRawUnsafe<{ db: string }[]>("SELECT current_database() AS db");
  expect(row!.db).toBe(name);
});

test("leaves the server's own settings alone: the container tuning does not apply", async () => {
  const template = templateClient();

  // The stand-in is a stock Postgres; a container run would read `off` here.
  const [row] = await template.$queryRawUnsafe<{ fsync: string }[]>("SHOW fsync");
  expect(row!.fsync).toBe("on");
});

test("refuses a role that is not a superuser, before creating any database", async () => {
  // Arrange: a role allowed to create databases, so only the check can stop it. Random,
  // because roles are cluster-wide and concurrent runs may share this server.
  const template = templateClient();
  const role = `not_super_${randomBytes(4).toString("hex")}`;
  await template.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN CREATEDB PASSWORD 'pw'`);
  const url = new URL(inject("templateDatabaseUri"));
  url.username = role;
  url.password = "pw";
  url.pathname = "/postgres";

  try {
    // Act + Assert
    await expect(
      openUrlServer({
        url: url.toString(),
        source: "`url`",
        databaseName: "prisma_test",
        workerCount: 2,
      }),
    ).rejects.toThrow(
      `the role "${role}" on the Postgres server ${url.protocol}//${role}:***@${url.host}/postgres ` +
        "is not a superuser — the Reset needs one",
    );
    const [owned] = await template.$queryRawUnsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
       WHERE r.rolname = '${role}'`,
    );
    expect(owned!.count).toBe(0);
  } finally {
    await template.$executeRawUnsafe(`DROP ROLE ${role}`);
  }
});
