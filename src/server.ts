// The pure half of choosing and addressing the run's Postgres server: which server the
// run uses (a container it starts, or an existing one given by `url`), the names a run
// on a shared server derives, the checks that server must pass, and the statements that
// drop what the run created. No container, no connection — the global setup hands these
// to the server providers (`./container-server.js`, `./url-server.js`), so each piece is
// exercised without a database.

import { randomBytes } from "node:crypto";

/**
 * The Postgres server a run works against, as the global setup's pipeline sees it —
 * whichever provider started or opened it.
 */
export interface ServerHandle {
  /** Name of the Template Database the pipeline migrates, seeds and clones. */
  templateName: string;
  /** Connection URI of the Template Database. */
  templateUrl: string;
  /**
   * Connection URI of a database on the same server that is not the template, for admin
   * work: the clones, and the check that nothing is connected to the template.
   */
  adminUrl: string;
  /** Release everything the run holds on the server. */
  teardown(): Promise<void>;
}

/** The environment variable that points a run at an existing server, over the option. */
export const URL_ENV_VAR = "PRISMA_TEST_HELPER_URL";

/** The options that configure the container, and so mean nothing in url mode. */
const CONTAINER_OPTIONS = ["image", "postgresSettings"] as const;

/** What supplied a url-mode run's URL, as an error message names it. */
export type UrlSource = "`url`" | `\`${typeof URL_ENV_VAR}\``;

/** Where a run's server comes from. */
export type ServerMode =
  | { kind: "container" }
  | {
      kind: "url";
      url: string;
      source: UrlSource;
      /** Container options the config carries that this mode ignores (env var only). */
      ignored: string[];
    };

/**
 * Choose the run's server: `PRISMA_TEST_HELPER_URL` when it is non-empty, else the `url`
 * option when it is non-empty, else a container.
 *
 * The `url` option alongside `image` or `postgresSettings` is a contradiction in one
 * config, so it fails here, before any I/O, naming the options. The environment variable
 * is a per-machine switch over a shared config that may well pin `image`: those options
 * are returned as `ignored`, for the caller to report, and the run proceeds. A URL that
 * does not parse fails here too, without echoing it — it may carry a password.
 *
 * @example
 * resolveServerMode({ url: "postgresql://u:p@db:5432/postgres" }, {});
 * // → { kind: "url", url: "postgresql://u:p@db:5432/postgres", source: "`url`", ignored: [] }
 */
export function resolveServerMode(
  options: { url?: string; image?: string; postgresSettings?: object },
  env: Record<string, string | undefined>,
): ServerMode {
  const present = CONTAINER_OPTIONS.filter((name) => options[name] !== undefined);
  const fromEnv = env[URL_ENV_VAR];
  if (fromEnv) {
    assertParses(fromEnv, URL_ENV_VAR);
    return { kind: "url", url: fromEnv, source: `\`${URL_ENV_VAR}\``, ignored: [...present] };
  }
  if (!options.url) return { kind: "container" };
  if (present.length > 0) {
    const names = present.join(" and ");
    throw new Error(
      `url: cannot be combined with ${names} — ${present.length > 1 ? "they configure" : "it configures"} ` +
        "the container the harness starts, and with url the run uses an existing server " +
        `instead. Remove ${names}, or remove url to run in a container.`,
    );
  }
  assertParses(options.url, "url");
  return { kind: "url", url: options.url, source: "`url`", ignored: [] };
}

function assertParses(url: string, name: string): void {
  if (!URL.canParse(url)) {
    throw new Error(
      `${name}: not a valid connection URL — expected ` +
        "postgresql://user:password@host:port/database",
    );
  }
}

/**
 * The one line reported when `PRISMA_TEST_HELPER_URL` overrides a config that carries
 * container options.
 */
export function ignoredOptionsWarning(ignored: string[]): string {
  return (
    `@flefebvre/prisma-test-helper: ignoring ${ignored.join(" and ")} — ` +
    `${URL_ENV_VAR} is set, so the run uses that server and starts no container.`
  );
}

/**
 * A URL fit to print: no password, no query parameters (they can carry one too).
 *
 * @example
 * redactUrl("postgresql://app:s3cret@db:5432/postgres?sslmode=require");
 * // → "postgresql://app:***@db:5432/postgres"
 */
export function redactUrl(url: string): string {
  if (!URL.canParse(url)) return "(unparseable URL)";
  const parsed = new URL(url);
  if (parsed.password !== "") parsed.password = "***";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** A fresh run id: 8 lowercase hex characters, unique enough to share a server. */
export function newRunId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * The Template Database name of a run on a shared server: `<databaseName>_<run id>`, so
 * two runs never collide. Its Worker Databases are `<template>_<n>`, the shape the Worker
 * Database guard already admits.
 */
export function runTemplateName(databaseName: string, runId: string): string {
  return `${databaseName}_${runId}`;
}

/** Postgres truncates identifiers longer than this, in bytes, without an error. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Fail when the longest Worker Database name, `<templateName>_<count>`, exceeds the
 * 63-byte identifier limit: Postgres would truncate it silently, and two truncated names
 * could collide. `databaseName` only shapes the message, which says how far to shorten it.
 */
export function assertNamesFit(
  templateName: string,
  workerCount: number,
  databaseName: string,
): void {
  const longest = `${templateName}_${workerCount}`;
  const bytes = Buffer.byteLength(longest);
  if (bytes <= MAX_IDENTIFIER_BYTES) return;
  const room = MAX_IDENTIFIER_BYTES - (bytes - Buffer.byteLength(databaseName));
  throw new Error(
    `databaseName: "${databaseName}" is too long for url mode — the run names its ` +
      `Worker Databases <databaseName>_<run id>_<n>, and ${longest} is ${bytes} bytes, ` +
      `over Postgres's ${MAX_IDENTIFIER_BYTES}-byte identifier limit (Postgres would ` +
      `truncate it silently, so names could collide). Shorten databaseName to at most ` +
      `${room} bytes.`,
  );
}

/** What the startup check reads from the server, in one round-trip. */
export const SERVER_CHECK_QUERY =
  "SELECT current_user AS role, " +
  "(SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser, " +
  "current_setting('server_version_num')::int AS version_num, " +
  "current_setting('server_version') AS version";

/** One row of {@link SERVER_CHECK_QUERY}. */
export interface ServerCheck extends Record<string, unknown> {
  role: string;
  superuser: boolean;
  version_num: number;
  version: string;
}

/**
 * Fail unless the server can host a run: the role must be a superuser (the Reset sets
 * `session_replication_role` and reads `pg_stat_file`), and the server Postgres 13 or
 * later (teardown drops with `DROP DATABASE … WITH (FORCE)`). `server` is the redacted
 * URL the messages name.
 */
export function assertServerUsable(check: ServerCheck, server: string): void {
  if (!check.superuser) {
    throw new Error(
      `the role "${check.role}" on the Postgres server ${server} is not a superuser — ` +
        "the Reset needs one: it sets session_replication_role and reads pg_stat_file. " +
        "Connect as a superuser role (see the requirements in docs/setup.md).",
    );
  }
  if (check.version_num < 130000) {
    throw new Error(
      `the Postgres server ${server} runs Postgres ${check.version} — url mode needs ` +
        "Postgres 13 or later, because teardown drops the run's databases with " +
        "DROP DATABASE … WITH (FORCE). Point url at a newer server, or remove it to run " +
        "in a container.",
    );
  }
}

/** One database to drop, and the statement that drops it. */
export interface DropStatement {
  database: string;
  statement: string;
}

/**
 * The statements that drop everything a run on a shared server derives: its Worker
 * Databases `<templateName>_1..count`, then its template — and nothing else. `IF EXISTS`
 * makes them safe whatever a failed setup got to create; `WITH (FORCE)` ends sessions a
 * test left open. Each must be sent as its own query: `DROP DATABASE` refuses to run in
 * the implicit transaction of a multi-statement string.
 *
 * @example
 * dropStatements("prisma_test_0a1b2c3d", 1)
 * // → [{ database: "prisma_test_0a1b2c3d_1",
 * //      statement: 'DROP DATABASE IF EXISTS "prisma_test_0a1b2c3d_1" WITH (FORCE)' },
 * //    { database: "prisma_test_0a1b2c3d",
 * //      statement: 'DROP DATABASE IF EXISTS "prisma_test_0a1b2c3d" WITH (FORCE)' }]
 */
export function dropStatements(templateName: string, count: number): DropStatement[] {
  const databases = [
    ...Array.from({ length: count }, (_, index) => `${templateName}_${index + 1}`),
    templateName,
  ];
  return databases.map((database) => ({
    database,
    statement: `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
  }));
}
