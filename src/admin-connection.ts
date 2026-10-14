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

/**
 * Open an admin connection to `url`, hand it to `use`, and close it once `use` settles —
 * on success and on failure alike, so no admin connection outlives the work it was opened
 * for (an open connection to a template database makes `CREATE DATABASE … TEMPLATE` fail
 * with SQLSTATE 55006). A failed connect rejects with `pg`'s own error.
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
  const { connection, close } = await open(url);
  try {
    return await use(connection);
  } finally {
    await close();
  }
}

/** Connect to `url`; the caller owns closing it. */
async function open(
  url: string,
): Promise<{ connection: AdminConnection; close: () => Promise<void> }> {
  const { default: pg } = await import("pg");
  const client: Client = new pg.Client({ connectionString: url });
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
