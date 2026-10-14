// The pure half of choosing and addressing the run's Postgres server: which server the
// run uses (a container it starts, or an existing one given by `url`), the names a run
// on a shared server derives, the checks that server must pass, and the statements that
// drop what the run created. No container, no connection — the global setup hands these
// to the server providers (`./container-server.js`, `./url-server.js`), so each piece is
// exercised without a database.
//
// A url-mode run can be killed before its teardown, leaving its databases on a server
// that outlives it. So every database it creates carries a Run marker (a comment naming
// its run id), and the run holds an advisory lock keyed by that id for as long as it
// lives. The next run's Sweep drops the marked databases of every run whose lock is free —
// a dead one — and never a database without a marker, whatever its name.

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
  /**
   * The statement that marks a database the run just created as its own, sent by the
   * pipeline right after each clone on the same connection. Only a server other runs may
   * share needs one: a container dies with its run, so its provider leaves this unset.
   */
  markStatement?(database: string): string;
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

/**
 * The statement that drops `database`. `IF EXISTS` makes it safe whatever got created;
 * `WITH (FORCE)` ends sessions a test (or a killed run's workers) left open. Send it as its
 * own query: `DROP DATABASE` refuses to run in the implicit transaction of a
 * multi-statement string.
 */
export function dropDatabaseStatement(database: string): string {
  return `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`;
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
  return databases.map((database) => ({ database, statement: dropDatabaseStatement(database) }));
}

/** What every Run marker starts with; the run id follows. */
const MARKER_PREFIX = "prisma-test-helper run ";

/**
 * The Run marker of a run: the comment every database it creates carries. A comment lives
 * in `pg_shdescription`, keyed by the database's OID, so a clone made with
 * `CREATE DATABASE … TEMPLATE` does not inherit its template's: each is marked itself.
 *
 * @example
 * runMarker("0a1b2c3d"); // → "prisma-test-helper run 0a1b2c3d"
 */
export function runMarker(runId: string): string {
  return `${MARKER_PREFIX}${runId}`;
}

/**
 * The statement that marks `database` as created by the run `runId`. Postgres lets only
 * the database's owner comment on it, which the run is: it created it.
 *
 * @example
 * markStatement("prisma_test_0a1b2c3d", "0a1b2c3d");
 * // → `COMMENT ON DATABASE "prisma_test_0a1b2c3d" IS 'prisma-test-helper run 0a1b2c3d'`
 */
export function markStatement(database: string, runId: string): string {
  return `COMMENT ON DATABASE "${database}" IS '${runMarker(runId)}'`;
}

/**
 * The run id a comment marks, or `undefined` when it is not exactly a Run marker — a
 * comment someone else wrote that merely starts like one names no run, so the Sweep
 * leaves its database alone.
 */
export function parseRunMarker(comment: string | null): string | undefined {
  return /^prisma-test-helper run ([0-9a-f]{8})$/.exec(comment ?? "")?.[1];
}

/** Every database on the server whose comment looks like a Run marker, in one read. */
export const MARKED_DATABASES_QUERY =
  "SELECT datname, shobj_description(oid, 'pg_database') AS marker FROM pg_database " +
  `WHERE shobj_description(oid, 'pg_database') LIKE '${MARKER_PREFIX}%' ORDER BY datname`;

/** One row of {@link MARKED_DATABASES_QUERY}. */
export interface MarkedDatabase extends Record<string, unknown> {
  datname: string;
  marker: string | null;
}

/**
 * The marked databases grouped by the run that created them, minus `ownRunId`'s, in the
 * order listed. A row whose marker does not parse is dropped from the plan.
 */
export function leftoversByRun(rows: MarkedDatabase[], ownRunId: string): Map<string, string[]> {
  const byRun = new Map<string, string[]>();
  for (const { datname, marker } of rows) {
    const runId = parseRunMarker(marker);
    if (runId === undefined || runId === ownRunId) continue;
    byRun.set(runId, [...(byRun.get(runId) ?? []), datname]);
  }
  return byRun;
}

/**
 * The harness's advisory-lock namespace: the first key of every lock it takes, so its
 * locks never collide with an application's that use the two-key form. "pth\0" in ASCII.
 */
export const RUN_LOCK_NAMESPACE = 0x70746800;

/**
 * The second advisory-lock key of a run: its 32-bit run id read as a signed `int4`, which
 * is what Postgres takes. A bijection, so two runs never share a lock.
 *
 * @example
 * runLockKey("0000002a"); // → 42
 * runLockKey("ffffffff"); // → -1
 */
export function runLockKey(runId: string): number {
  return Number.parseInt(runId, 16) | 0;
}

/**
 * The statement a run sends to hold its own lock for as long as its admin session lives.
 * Session-level: Postgres releases it when the connection ends, however the run ends.
 */
export function runLockStatement(runId: string): string {
  return `SELECT pg_advisory_lock(${RUN_LOCK_NAMESPACE}, ${runLockKey(runId)})`;
}

/**
 * The statement that tries another run's lock without waiting: `locked` is true only
 * when no live session holds it, i.e. that run is dead.
 */
export function tryRunLockStatement(runId: string): string {
  return `SELECT pg_try_advisory_lock(${RUN_LOCK_NAMESPACE}, ${runLockKey(runId)}) AS locked`;
}

/** The statement that releases a lock {@link tryRunLockStatement} took. */
export function runUnlockStatement(runId: string): string {
  return `SELECT pg_advisory_unlock(${RUN_LOCK_NAMESPACE}, ${runLockKey(runId)})`;
}

/** The line the Sweep prints when it dropped a dead run's databases. */
export function sweptMessage(server: string, databases: string[]): string {
  return (
    `@flefebvre/prisma-test-helper: dropped databases left on ${server} by a run that ` +
    `was killed: ${databases.join(", ")}`
  );
}

/**
 * The line the Sweep prints for a dead run's databases it could not drop. Each entry is
 * `<name> (<Postgres's message>)`. They are another run's leftovers, so this run goes on.
 */
export function sweepFailedMessage(server: string, failures: string[]): string {
  return (
    `@flefebvre/prisma-test-helper: could not drop databases left on ${server} by a run ` +
    `that was killed: ${failures.join(", ")} — this run goes on; drop them by hand with ` +
    'DROP DATABASE "<name>" WITH (FORCE)'
  );
}

/**
 * The line printed when the connection holding the run's lock drops mid-run: from then
 * on, the next run to start on that server takes this run for dead.
 */
export function lostLockMessage(server: string, reason: string): string {
  return (
    `@flefebvre/prisma-test-helper: lost the admin connection to ${server} (${reason}) — ` +
    "this run no longer holds its lock, so a run starting on that server now may drop " +
    "this run's databases"
  );
}
