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
 * (`pg_depend` type `a`) and identity columns (type `i`). A standalone sequence no column
 * owns is left alone: nothing ties it to a table the Reset empties, and its value may be
 * meant to outlive a test.
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
SELECT 'table' AS kind, schema, name FROM tables
UNION ALL
SELECT 'sequence', sn.nspname::text, s.relname::text
FROM pg_catalog.pg_class s
JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
JOIN pg_catalog.pg_depend d
  ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = s.oid
  AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')
JOIN tables t ON t.oid = d.refobjid
WHERE s.relkind = 'S'
ORDER BY 1, 2, 3`;

/** One row of {@link DISCOVERY_QUERY}. */
export interface DiscoveredRelation extends QualifiedName {
  kind: "table" | "sequence";
}

// How long the Reset waits on a lock before failing. A test that leaves a lock behind —
// an interactive transaction it never awaited, a second client it never closed — would
// otherwise hang the suite; a few seconds is far above any honest wait.
const LOCK_TIMEOUT = "5s";

// The DO block's dollar-quote tag. An identifier containing it would end the block early;
// the builder refuses one rather than emit broken SQL.
const TAG = "$reset$";

/**
 * Build the Reset statement: one PL/pgSQL `DO` block, sent in one round trip, that
 * empties every table holding rows and rewinds every sequence that moved.
 *
 * - `session_replication_role = replica` switches off foreign-key triggers for the
 *   block, so tables are emptied in any order without cascades.
 * - Each table is probed with `EXISTS` before its DELETE: on an empty table the probe is
 *   nearly free, so the cost tracks what the test wrote, not the size of the schema.
 * - Sequences are rewound to their own `start_value` with `setval(…, false)` — 1 for a
 *   Prisma autoincrement — and only when `pg_sequences.last_value` is set, i.e. when
 *   `nextval` ran since the last Reset. That catches a sequence a failed insert advanced
 *   without leaving a row, which a table probe alone would miss. One probe query covers
 *   every sequence. Known limit: `setval` cannot reach values another session has
 *   already cached, so a sequence declared with `CACHE` above 1 (never emitted by Prisma)
 *   can hand a later test pre-Reset ids from a pooled connection.
 * - Both settings are transaction-local, so they end with the statement.
 *
 * Identifiers travel as string literals and are quoted server-side by `format('%I')`, so
 * mixed-case, reserved-word, and otherwise odd names are safe. Pure: unit-tested without
 * a database.
 */
export function buildResetStatement(
  tables: readonly QualifiedName[],
  sequences: readonly QualifiedName[],
): string {
  for (const { schema, name } of [...tables, ...sequences]) {
    if (schema.includes(TAG) || name.includes(TAG)) {
      throw new Error(`cannot build the Reset: ${schema}.${name} contains ${TAG}`);
    }
  }

  const lines = [
    `DO ${TAG}`,
    "DECLARE",
    "  nonempty boolean;",
    "  seq record;",
    "BEGIN",
    "  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);",
    `  PERFORM pg_catalog.set_config('lock_timeout', '${LOCK_TIMEOUT}', true);`,
  ];
  for (const table of tables) {
    const target = `${literal(table.schema)}, ${literal(table.name)}`;
    lines.push(
      `  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', ${target}) INTO nonempty;`,
      `  IF nonempty THEN EXECUTE format('DELETE FROM %I.%I', ${target}); END IF;`,
    );
  }
  if (sequences.length > 0) {
    const owned = sequences
      .map((sequence) => `(${literal(sequence.schema)}, ${literal(sequence.name)})`)
      .join(", ");
    lines.push(
      "  FOR seq IN",
      "    SELECT schemaname, sequencename, start_value FROM pg_catalog.pg_sequences",
      `    WHERE last_value IS NOT NULL AND (schemaname, sequencename) IN (${owned})`,
      "  LOOP",
      "    PERFORM pg_catalog.setval(",
      "      format('%I.%I', seq.schemaname, seq.sequencename)::regclass, seq.start_value, false);",
      "  END LOOP;",
    );
  }
  lines.push("END", TAG);
  return lines.join("\n");
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
    relations.filter((relation) => relation.kind === "sequence"),
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
