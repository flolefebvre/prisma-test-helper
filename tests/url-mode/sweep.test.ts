import { expect, inject, test } from "vitest";

import { openAdminConnection, withAdminConnection } from "../../src/admin-connection.js";
import {
  dropDatabaseStatement,
  markStatement,
  newRunId,
  runLockStatement,
  runMarker,
} from "../../src/server.js";
import { openUrlServer } from "../../src/url-server.js";

// url mode only: the Run markers this run carries, and the Sweep a run does at startup,
// against the server tests/global-setup-url.ts pointed this run at. Under
// scripts/concurrent-url-runs.mjs another copy of this file runs against the same server
// at once, so every fixture is named after a fresh run id: the two copies never share a
// database or a lock, and either may sweep the other's dead-run fixture first. The
// Sweep's line is left on stderr: that script reads it to see who dropped what.

/**
 * The admin URL of the server this run is on: the template's URL, on `postgres`. The run's
 * own URL names another database (the stand-in's `test`), so its lock is seen across them.
 */
function serverUrl(): string {
  const url = new URL(inject("templateDatabaseUri"));
  url.pathname = "/postgres";
  return url.toString();
}

/** Each database's comment, `null` when it has none; a database not on the server is absent. */
async function markers(databases: string[]): Promise<Map<string, string | null>> {
  const list = databases.map((name) => `'${name}'`).join(", ");
  const rows = await withAdminConnection(serverUrl(), (connection) =>
    connection.query<{ datname: string; marker: string | null }>(
      "SELECT datname, shobj_description(oid, 'pg_database') AS marker FROM pg_database " +
        `WHERE datname IN (${list})`,
    ),
  );
  return new Map(rows.map(({ datname, marker }) => [datname, marker]));
}

test("marks the run's template and every Worker Database with its run id", async () => {
  const template = inject("templateDatabaseName");
  const runId = template.slice(-8);

  const found = await markers([template, `${template}_1`, `${template}_2`]);

  expect(Object.fromEntries(found)).toEqual({
    [template]: runMarker(runId),
    [`${template}_1`]: runMarker(runId),
    [`${template}_2`]: runMarker(runId),
  });
});

test("the Sweep drops a dead run's marked database, and keeps a live run's and an unmarked one", async () => {
  // Arrange: (a) marked by a run nobody holds the lock of — dead; (b) marked by a run whose
  // lock this test holds, as a live run's admin session does; (c) named like a run's
  // template, with no marker.
  const server = serverUrl();
  const dead = `sweep_test_${newRunId()}`;
  const liveRunId = newRunId();
  const live = `sweep_test_${liveRunId}`;
  const unmarked = `sweep_test_${newRunId()}`;
  const ours = inject("templateDatabaseName");

  const liveRun = await openAdminConnection(server);
  let handle: Awaited<ReturnType<typeof openUrlServer>> | undefined;
  try {
    await liveRun.connection.query(runLockStatement(liveRunId));
    await withAdminConnection(server, async (connection) => {
      await connection.query(`CREATE DATABASE "${dead}"`);
      await connection.query(markStatement(dead, dead.slice(-8)));
      await connection.query(`CREATE DATABASE "${live}"`);
      await connection.query(markStatement(live, liveRunId));
      await connection.query(`CREATE DATABASE "${unmarked}"`);
    });

    // Act
    handle = await openUrlServer({
      url: server,
      source: "`url`",
      databaseName: "sweep_test",
      workerCount: 1,
    });

    // Assert: (a) is gone — whether this Sweep or a concurrent copy's dropped it — and
    // (b), (c) and this run's own template, held by the run's lock, are still there.
    const found = await markers([dead, live, unmarked, ours, handle.templateName]);
    expect(found.has(dead)).toBe(false);
    expect(found.get(live)).toBe(runMarker(liveRunId));
    expect(found.get(unmarked)).toBeNull();
    expect(found.get(ours)).toBe(runMarker(ours.slice(-8)));
    expect(found.get(handle.templateName)).toBe(runMarker(handle.templateName.slice(-8)));
  } finally {
    await handle?.teardown();
    await liveRun.close();
    await withAdminConnection(server, async (connection) => {
      for (const database of [dead, live, unmarked]) {
        await connection.query(dropDatabaseStatement(database));
      }
    });
  }
});
