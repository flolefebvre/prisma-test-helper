// The url-mode server provider: an existing Postgres server, possibly shared with other
// runs and other projects. Everything the run creates there carries a run id, so two runs
// never collide; the URL the user gave is only connected through, for `CREATE DATABASE` /
// `DROP DATABASE`, and nothing is ever written into its database. The SQL is built by the
// pure helpers of `./server.js`; this only sends it.
//
// The server outlives the run, so a run killed before its teardown leaves its databases
// there. Each run therefore holds one admin connection for its whole life, carrying an
// advisory lock keyed by its run id, and marks every database it creates with a Run
// marker. That connection goes to the server's `postgres` database, whatever the URL
// names: advisory locks are per database, and every run must see every other's. At startup the Sweep drops the marked databases of every run whose lock is
// free — a run whose session is gone — and leaves those of a live run alone.

import {
  openAdminConnection,
  withAdminConnection,
  type AdminConnection,
  type HeldAdminConnection,
} from "./admin-connection.js";
import {
  assertNamesFit,
  assertServerUsable,
  dropDatabaseStatement,
  dropStatements,
  leftoversByRun,
  LOCK_DATABASE,
  lostLockMessage,
  MARKED_DATABASES_QUERY,
  markStatement,
  newRunId,
  noLockDatabaseError,
  redactUrl,
  runLockStatement,
  runTemplateName,
  runUnlockStatement,
  SERVER_CHECK_QUERY,
  sweepFailedMessage,
  sweptMessage,
  tryRunLockStatement,
  type MarkedDatabase,
  type ServerCheck,
  type ServerHandle,
  type UrlSource,
} from "./server.js";
import { databaseUrl } from "./worker-database.js";

/**
 * Open the run on the server at `url`, and hand back its {@link ServerHandle}.
 *
 * Before anything is created: the names are checked against the identifier limit, then
 * the run opens the admin connection it holds until teardown — to the server's
 * `postgres` database, whatever database `url` names, because advisory locks are per
 * database — and one round-trip on it checks the role is a superuser and the server
 * Postgres 13+. The run then takes its own
 * lock, so no other run's Sweep can take it for dead, and sweeps the server. Only then is
 * the run's template, `<databaseName>_<run id>`, created — empty, from the server's default
 * template, ready to migrate — and marked. The admin URL is `url` itself; the handle's
 * `markStatement` marks each Worker Database the pipeline clones.
 *
 * The handle's teardown drops the run's Worker Databases `1..workerCount` and its
 * template over a fresh admin connection — the full derived set, whatever a failed setup
 * got to create, and nothing else — and only then closes the held connection, releasing
 * the lock.
 */
export async function openUrlServer(options: {
  url: string;
  source: UrlSource;
  databaseName: string;
  workerCount: number;
}): Promise<ServerHandle> {
  const { url, source, databaseName, workerCount } = options;
  const runId = newRunId();
  const templateName = runTemplateName(databaseName, runId);
  assertNamesFit(templateName, workerCount, databaseName);
  const server = redactUrl(url);

  // Held on the lock database, not the URL's: advisory locks are per database, and every
  // run must see every other's. Once it drops, the lock is gone with it: say so, once,
  // and never close what pg already closed.
  let lost = false;
  let held: HeldAdminConnection;
  try {
    held = await openAdminConnection(databaseUrl(url, LOCK_DATABASE), (error) => {
      if (lost) return;
      lost = true;
      console.warn(lostLockMessage(server, error.message));
    });
  } catch (cause) {
    // SQLSTATE 3D000: the database does not exist.
    if ((cause as { code?: unknown } | null)?.code === "3D000") {
      throw noLockDatabaseError(server, cause);
    }
    throw connectFailure(cause, url, source);
  }
  const closeHeld = async () => {
    if (!lost) await held.close();
  };

  const handle: ServerHandle = {
    templateName,
    templateUrl: databaseUrl(url, templateName),
    adminUrl: url,
    markStatement: (database) => markStatement(database, runId),
    teardown: async () => {
      try {
        await dropRunDatabases(url, source, templateName, workerCount);
      } catch (error) {
        // The drops' error is the diagnostic one: a failed close must not mask it.
        await closeHeld().catch(() => {});
        throw error;
      }
      await closeHeld();
    },
  };

  let created = false;
  try {
    const [check] = await held.connection.query<ServerCheck>(SERVER_CHECK_QUERY);
    assertServerUsable(check!, server);
    await held.connection.query(runLockStatement(runId));
    await sweep(held.connection, runId, server);
    try {
      await held.connection.query(`CREATE DATABASE "${templateName}"`);
      created = true;
      await held.connection.query(markStatement(templateName, runId));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `could not create the Template Database ${templateName} on ${server}: ${message}`,
        { cause },
      );
    }
  } catch (error) {
    // Before the template exists there is nothing to drop; after, the teardown drops it.
    // Either way the held connection closes, and the startup error is what rejects.
    await (created ? handle.teardown() : closeHeld()).catch(() => {});
    throw error;
  }
  return handle;
}

/**
 * The Sweep: drop the marked databases of every other run on the server whose lock this
 * session can take — its owner's session is gone, so the run is dead — and release that
 * lock again. A run whose lock is held is live, and its databases stay. Only databases
 * carrying a Run marker are ever considered, whatever their names.
 *
 * A database that cannot be dropped is another run's leftover, not this run's problem:
 * it is reported in one line, and the run goes on. Reading the list or taking a lock is
 * admin work like any other, and its failure fails the run.
 */
async function sweep(connection: AdminConnection, runId: string, server: string): Promise<void> {
  const marked = await connection.query<MarkedDatabase>(MARKED_DATABASES_QUERY);
  const dropped: string[] = [];
  const failed: string[] = [];
  for (const [deadRunId, databases] of leftoversByRun(marked, runId)) {
    const [attempt] = await connection.query<{ locked: boolean }>(tryRunLockStatement(deadRunId));
    if (attempt?.locked !== true) continue;
    for (const database of databases) {
      try {
        await connection.query(dropDatabaseStatement(database));
        dropped.push(database);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        failed.push(`${database} (${message})`);
      }
    }
    await connection.query(runUnlockStatement(deadRunId));
  }
  if (dropped.length > 0) console.warn(sweptMessage(server, dropped));
  if (failed.length > 0) console.warn(sweepFailedMessage(server, failed));
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
 * such (see {@link connectFailure}). Failures once connected keep their own error.
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
    throw connectFailure(cause, url, source);
  }
}

/**
 * The error a failed connect to the user's server rejects with: pg's own error names
 * neither the URL nor which option supplied it.
 */
function connectFailure(cause: unknown, url: string, source: UrlSource): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `could not connect to the Postgres server given by ${source} (${redactUrl(url)}): ` +
      `${message} — check that the server is reachable from the test process and the ` +
      "URL's credentials are right",
    { cause },
  );
}
