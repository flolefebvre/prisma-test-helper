// The url-mode server provider: an existing Postgres server, possibly shared with other
// runs and other projects. Everything the run creates there carries a run id, so two runs
// never collide; the URL the user gave is only connected through, for `CREATE DATABASE` /
// `DROP DATABASE`, and nothing is ever written into its database. The SQL is built by the
// pure helpers of `./server.js`; this only sends it.

import { withAdminConnection, type AdminConnection } from "./admin-connection.js";
import {
  assertNamesFit,
  assertServerUsable,
  dropStatements,
  newRunId,
  redactUrl,
  runTemplateName,
  SERVER_CHECK_QUERY,
  type ServerCheck,
  type ServerHandle,
  type UrlSource,
} from "./server.js";
import { databaseUrl } from "./worker-database.js";

/**
 * Open the run on the server at `url`, and hand back its {@link ServerHandle}.
 *
 * Before anything is created: the names are checked against the identifier limit, then
 * one admin round-trip checks the role is a superuser and the server Postgres 13+. Only
 * then is the run's template, `<databaseName>_<run id>`, created — empty, from the
 * server's default template, ready to migrate. The admin URL is `url` itself.
 *
 * The handle's teardown drops the run's Worker Databases `1..workerCount` and its
 * template over a fresh admin connection — the full derived set, whatever a failed setup
 * got to create, and nothing else.
 */
export async function openUrlServer(options: {
  url: string;
  source: UrlSource;
  databaseName: string;
  workerCount: number;
}): Promise<ServerHandle> {
  const { url, source, databaseName, workerCount } = options;
  const templateName = runTemplateName(databaseName, newRunId());
  assertNamesFit(templateName, workerCount, databaseName);
  const server = redactUrl(url);

  await withServer(url, source, async (connection) => {
    const [check] = await connection.query<ServerCheck>(SERVER_CHECK_QUERY);
    assertServerUsable(check!, server);
    try {
      await connection.query(`CREATE DATABASE "${templateName}"`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `could not create the Template Database ${templateName} on ${server}: ${message}`,
        { cause },
      );
    }
  });

  return {
    templateName,
    templateUrl: databaseUrl(url, templateName),
    adminUrl: url,
    teardown: () => dropRunDatabases(url, source, templateName, workerCount),
  };
}

/**
 * Drop every database the run derives, one query each, over a fresh admin connection.
 * Every statement is attempted even when one fails, so a failure leaves as little behind
 * as it can; then one error names each database that could not be dropped.
 */
async function dropRunDatabases(
  url: string,
  source: UrlSource,
  templateName: string,
  workerCount: number,
): Promise<void> {
  const failures = await withServer(url, source, async (connection) => {
    const failed: string[] = [];
    for (const { database, statement } of dropStatements(templateName, workerCount)) {
      try {
        await connection.query(statement);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        failed.push(`${database} (${message})`);
      }
    }
    return failed;
  });
  if (failures.length > 0) {
    throw new Error(
      `could not drop this run's databases on ${redactUrl(url)}: ${failures.join(", ")} — ` +
        `drop them by hand with DROP DATABASE "<name>" WITH (FORCE)`,
    );
  }
}

/**
 * {@link withAdminConnection} to the user's server, with a failed connect reported as
 * such: pg's own error names neither the URL nor which option supplied it. Failures
 * once connected keep their own error.
 */
async function withServer<T>(
  url: string,
  source: UrlSource,
  use: (connection: AdminConnection) => Promise<T>,
): Promise<T> {
  let connected = false;
  try {
    return await withAdminConnection(url, (connection) => {
      connected = true;
      return use(connection);
    });
  } catch (cause) {
    if (connected) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `could not connect to the Postgres server given by ${source} (${redactUrl(url)}): ` +
        `${message} — check that the server is reachable from the test process and the ` +
        "URL's credentials are right",
      { cause },
    );
  }
}
