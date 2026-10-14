// The harness's one SQL path from the main process: a `pg` connection for admin work —
// DDL such as cloning the Worker Databases, and catalog reads that return rows. Workers
// never come here: the Reset runs through the consumer's own Prisma client, so `pg` is
// only ever loaded by the global-setup entry. It is imported lazily, inside `open`, so
// that nothing reaching this module's import graph pays for — or depends on — the driver
// until a connection is actually opened.

import type { Client } from "pg";

/** An open admin connection: send one simple query, get its rows back. */
export interface AdminConnection {
  /**
   * Run `sql` as one simple query and resolve with its rows (empty for DDL). A string
   * holding several statements runs in one implicit transaction — `CREATE DATABASE`
   * refuses that, so send such statements one call each.
   */
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<Row[]>;
}

/** An admin connection the caller holds, and closes when it is done with it. */
export interface HeldAdminConnection {
  connection: AdminConnection;
  close(): Promise<void>;
}

/**
 * Open an admin connection to `url` that lives until the caller closes it — for a session
 * that must outlast any one piece of work, such as one holding an advisory lock.
 *
 * `onError` receives what `pg` emits when the connection drops while idle: unhandled,
 * that `error` event would crash the process. A query in flight rejects with the same
 * error on its own. Without `onError` the event is ignored. A failed connect rejects with
 * `pg`'s own error.
 */
export async function openAdminConnection(
  url: string,
  onError: (error: Error) => void = () => {},
): Promise<HeldAdminConnection> {
  const { default: pg } = await import("pg");
  // `ssl: false` is the default only: an `sslmode` in the URL still overrides it. Without
  // it pg would fall back to the host's PGSSLMODE — which the old in-container path never
  // saw — and fail against a plaintext server where the URL asked for nothing.
  const client: Client = new pg.Client({ connectionString: url, ssl: false });
  client.on("error", onError);
  await client.connect();
  return {
    connection: {
      async query<Row extends Record<string, unknown>>(sql: string): Promise<Row[]> {
        return (await client.query<Row>(sql)).rows;
      },
    },
    close: () => client.end(),
  };
}

/**
 * Open an admin connection to `url`, hand it to `use`, and close it once `use` settles —
 * on success and on failure alike, so no admin connection outlives the work it was opened
 * for (an open connection to a template database makes `CREATE DATABASE … TEMPLATE` fail
 * with SQLSTATE 55006). When `use` fails, its error is what rejects, even if the close
 * fails too; on success a failed close rejects. A failed connect rejects with `pg`'s own
 * error.
 *
 * @example
 * await withAdminConnection("postgresql://u:p@host:5432/postgres", async (connection) => {
 *   await connection.query('CREATE DATABASE "prisma_test_1" TEMPLATE "prisma_test"');
 * });
 */
export async function withAdminConnection<T>(
  url: string,
  use: (connection: AdminConnection) => Promise<T>,
): Promise<T> {
  const { connection, close } = await openAdminConnection(url);
  let result: T;
  try {
    result = await use(connection);
  } catch (error) {
    // As with the container stop in `createGlobalSetup`: a failed close must not mask
    // the diagnostic error being thrown.
    await close().catch(() => {});
    throw error;
  }
  await close();
  return result;
}
