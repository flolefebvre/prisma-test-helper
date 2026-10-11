// The Reset: the pass that returns a Worker Database to empty, once before a file's
// first test and once after every test. Tests commit for real, so this is what keeps
// one test's rows out of the next. It runs through the consumer's own Prisma client —
// structurally typed below, never imported — so the package needs no database driver
// and the statement lands on the connection the tests themselves use.
//
// Why DELETE and not TRUNCATE, and the numbers behind it: docs/adr/0001.

/**
 * The slice of a Prisma client the Reset drives: one raw read (the guard's check and the
 * catalog discovery) and one raw write (the reset statement). Declared with method
 * syntax so the check is bivariant — a generated `PrismaClient`, whose raw methods are
 * generic and return a `PrismaPromise`, is assignable.
 */
export interface ResetClient {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/** A schema-qualified relation name, unquoted — quoting happens server-side, via `%I`. */
export interface QualifiedName {
  schema: string;
  name: string;
}

/**
 * Guard every Reset. With real commits, a suite whose `DATABASE_URL` wiring failed would
 * not merely lock the dev database — the Reset would empty it. Only Worker Databases,
 * named `<templateName>_<pool id>` after the Template Database they were cloned from, may
 * be reset; the template itself and every near-miss are refused. The name is matched
 * literally (no regex built from config). Returns the database name it admitted, so the
 * caller can compare it with what the client is actually connected to. Pure, so it is
 * unit-tested without a connection to a wrongly-named database.
 *
 * @example
 * assertWorkerDatabase("postgresql://u:p@host:5432/prisma_test_1", "prisma_test");
 * // → "prisma_test_1"
 */
export function assertWorkerDatabase(url: string, templateName: string): string {
  const name = new URL(url).pathname.slice(1);
  const prefix = `${templateName}_`;
  const workerId = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  if (!/^\d+$/.test(workerId)) {
    throw new Error(
      `refusing to reset ${name} — only Worker Databases (${prefix}<pool id>) may be reset`,
    );
  }
  return name;
}

/**
 * Every table the Reset empties, and every sequence it rewinds — one row per relation,
 * `kind` telling them apart.
 *
 * Tables: ordinary and partitioned (`relkind` `r`, `p`) in every schema but the system
 * ones, minus Prisma's own `_prisma_migrations`. Also left out: partitions, because a
 * DELETE on their partitioned parent already reaches them; temporary tables, which
 * belong to other sessions; and tables an extension owns (PostGIS's `spatial_ref_sys`),
 * which hold reference data the migrations never wrote.
 *
 * Sequences: those owned by a column of a discovered table — `serial` columns
 * (`pg_depend` type `a`) and identity columns (type `i`) — each with the `start_value`
 * the Reset rewinds it to, carried as text so no driver turns an `int8` into a `bigint`
 * or a `number` on its own terms. A standalone sequence no column owns is left alone:
 * nothing ties it to a table the Reset empties, and its value may be meant to outlive a
 * test.
 */
export const DISCOVERY_QUERY = `
WITH tables AS (
  SELECT c.oid, n.nspname::text AS schema, c.relname::text AS name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%'
    AND c.relname <> '_prisma_migrations'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend e
      WHERE e.classid = 'pg_catalog.pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e'
    )
)
SELECT 'table' AS kind, schema, name, NULL::text AS start_value FROM tables
UNION ALL
SELECT 'sequence', sn.nspname::text, s.relname::text, q.seqstart::text
FROM pg_catalog.pg_class s
JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
JOIN pg_catalog.pg_sequence q ON q.seqrelid = s.oid
JOIN pg_catalog.pg_depend d
  ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = s.oid
  AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')
JOIN tables t ON t.oid = d.refobjid
WHERE s.relkind = 'S'
ORDER BY 1, 2, 3`;

/** One row of {@link DISCOVERY_QUERY}. */
export interface DiscoveredRelation extends QualifiedName {
  kind: "table" | "sequence";
  /** The sequence's `start_value`, as decimal text; `null` for a table. */
  start_value: string | null;
}

/** A sequence the Reset rewinds: where it is, and the value it goes back to. */
export interface OwnedSequence extends QualifiedName {
  /** `pg_sequences.start_value`, as decimal text. */
  startValue: string;
}

// How long the Reset waits on a lock before failing. A test that leaves a lock behind —
// an interactive transaction it never awaited, a second client it never closed — would
// otherwise hang the suite; a few seconds is far above any honest wait.
const LOCK_TIMEOUT = "5s";

// The dollar-quote tags: one for the DO block, one for the statement it executes. An
// identifier containing either would end its quote early; the builder refuses one rather
// than emit broken SQL.
const BLOCK_TAG = "$reset$";
const SQL_TAG = "$reset_sql$";

/**
 * Build the Reset statement: one PL/pgSQL `DO` block, sent in one round trip, that
 * empties every table and rewinds every owned sequence.
 *
 * - `session_replication_role = replica` switches off foreign-key triggers for the
 *   block, so tables are emptied in any order without cascades.
 * - All the work is **one SQL statement**, run with a single `EXECUTE`: every table is
 *   emptied by its own data-modifying CTE (`WITH d0 AS (DELETE FROM …), …`), and the
 *   final `SELECT` calls `setval(…, start_value, false)` on every sequence. Nothing is
 *   probed first: a `DELETE` on an empty table costs about what an `EXISTS` on it does,
 *   and a `setval` costs less than asking `pg_sequences` whether it is needed, while
 *   every extra statement inside a `DO` block is parsed and planned again on each run.
 *   One statement is what makes the cost flat in the number of tables — see the
 *   amendment in docs/adr/0001.
 * - Both settings are transaction-local, so they end with the statement.
 *
 * Identifiers are quoted here, by {@link identifier}, so mixed-case, reserved-word, and
 * otherwise odd names are safe. Known limit: `setval` cannot reach values another
 * session has already cached, so a sequence declared with `CACHE` above 1 (never emitted
 * by Prisma) can hand a later test pre-Reset ids from a pooled connection. Pure:
 * unit-tested without a database.
 */
export function buildResetStatement(
  tables: readonly QualifiedName[],
  sequences: readonly OwnedSequence[],
): string {
  for (const { schema, name } of [...tables, ...sequences]) {
    for (const tag of [BLOCK_TAG, SQL_TAG]) {
      if (schema.includes(tag) || name.includes(tag)) {
        throw new Error(`cannot build the Reset: ${schema}.${name} contains ${tag}`);
      }
    }
  }
  for (const { schema, name, startValue } of sequences) {
    if (!/^-?\d+$/.test(startValue)) {
      throw new Error(`cannot build the Reset: ${schema}.${name} has start value ${startValue}`);
    }
  }

  const lines = [
    `DO ${BLOCK_TAG}`,
    "BEGIN",
    "  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);",
    `  PERFORM pg_catalog.set_config('lock_timeout', '${LOCK_TIMEOUT}', true);`,
  ];
  const deletes = tables.map(
    (table, index) =>
      `d${index} AS (DELETE FROM ${identifier(table.schema)}.${identifier(table.name)})`,
  );
  const rewinds = sequences.map(
    ({ schema, name, startValue }) =>
      `pg_catalog.setval(${literal(`${identifier(schema)}.${identifier(name)}`)}::regclass, ${startValue}, false)`,
  );
  if (deletes.length > 0 || rewinds.length > 0) {
    const sql =
      (deletes.length > 0 ? `WITH ${deletes.join(", ")} ` : "") +
      `SELECT ${rewinds.length > 0 ? rewinds.join(", ") : "1"}`;
    lines.push(`  EXECUTE ${SQL_TAG}${sql}${SQL_TAG};`);
  }
  lines.push("END", BLOCK_TAG);
  return lines.join("\n");
}

/** A quoted SQL identifier: only `"` needs doubling. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A SQL string literal. `standard_conforming_strings` is on, so only `'` needs doubling. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Guard, discover, and build the Reset for one Worker Database; resolves to the function
 * that runs it. Nothing is deleted before both guards pass: the URL must name a Worker
 * Database, and the client must actually be connected to that database — a client module
 * that reads some other variable than `DATABASE_URL` would otherwise have the Reset
 * empty whatever it points at. The first raw query connects a client that is not yet
 * connected, so a freshly built one works.
 *
 * Discovery runs once here and the statement is reused for every Reset after it: the
 * schema does not change mid-run.
 */
export async function prepareReset(
  db: ResetClient,
  databaseUrl: string,
  templateName: string,
): Promise<() => Promise<void>> {
  const expected = assertWorkerDatabase(databaseUrl, templateName);

  const [connected] = (await db.$queryRawUnsafe("SELECT current_database()::text AS name")) as {
    name: string;
  }[];
  if (connected?.name !== expected) {
    throw new Error(
      `the client passed to setupDatabase() is connected to ${connected?.name}, but ` +
        `DATABASE_URL names ${expected} — build the client from DATABASE_URL`,
    );
  }

  const relations = (await db.$queryRawUnsafe(DISCOVERY_QUERY)) as DiscoveredRelation[];
  const statement = buildResetStatement(
    relations.filter((relation) => relation.kind === "table"),
    relations
      .filter((relation) => relation.kind === "sequence")
      .map(({ schema, name, start_value }) => ({ schema, name, startValue: start_value ?? "1" })),
  );

  return async function reset(): Promise<void> {
    try {
      await db.$executeRawUnsafe(statement);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `the Reset could not empty ${expected}: ${message}\nA lock timeout here means a ` +
          "connection the test opened still holds a lock — await every query and close " +
          "every extra client before the test ends.",
        { cause },
      );
    }
  };
}
