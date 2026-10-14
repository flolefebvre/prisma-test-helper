// The Baseline: the rows `prisma migrate deploy` leaves in the Template Database, which
// every test starts from. This module is the shared SQL vocabulary of that feature, and
// of "which tables count" in general — pure strings and builders, no I/O, no driver:
//
// - the one definition of the tables and owned sequences the harness manages, as CTE
//   fragments both the Reset's discovery (`src/reset.ts`) and the Baseline install use;
// - the harness schema, `prisma_test_helper`, and the shape of the catalog in it that
//   workers read through the consumer's client;
// - the install builders global setup sends over its `pg` admin connection, connected
//   to the template, after migrate and before the Worker Databases are cloned.
//
// The design, the rejected alternatives and the numbers: docs/adr/0002-baseline-restore.md.

/** The schema the harness owns in the Template Database, and so in every Worker Database. */
export const HARNESS_SCHEMA = "prisma_test_helper";

/** A schema-qualified relation name, unquoted — the builders quote it. */
export interface QualifiedName {
  schema: string;
  name: string;
}

/** A schema-qualified, quoted SQL identifier: only `"` needs doubling. */
export function quoted({ schema, name }: QualifiedName): string {
  return [schema, name].map((part) => `"${part.replaceAll('"', '""')}"`).join(".");
}

/** A SQL string literal. `standard_conforming_strings` is on, so only `'` needs doubling. */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A relation of the harness schema, quoted. */
const harness = (name: string) => quoted({ schema: HARNESS_SCHEMA, name });

/**
 * The catalog: one row per Baseline table. `ordinal` names its snapshot copy
 * (`prisma_test_helper.t<ordinal>`) and is the argument its tracking trigger records;
 * `columns` lists, in order, the columns the restore writes — every column but dropped
 * and generated ones.
 */
export const CATALOG = harness("baseline");
/** Snapshot positions of the sequences Baseline tables own: `last_value`, `is_called`. */
export const SEQUENCE_CATALOG = harness("sequence");
/** The ordinals of the Baseline tables written since the last Reset. */
export const DIRTY = harness("dirty");
/** The snapshot copy of the Baseline table with this ordinal. */
export const snapshotCopy = (ordinal: number) => harness(`t${ordinal}`);

// Named after the harness: it is created on the consumer's own tables, so its name must
// not collide with one of theirs.
const TRIGGER = '"prisma_test_helper_dirty"';
const MARK_DIRTY = harness("prisma_test_helper_mark_dirty");

/**
 * The tables the harness manages, as the CTE `tables (oid, schema, name, relkind)` — the
 * one definition of "which tables count", shared by the Reset's discovery and the
 * Baseline install so the two can never disagree.
 *
 * Ordinary and partitioned tables (`relkind` `r`, `p`) in every schema but the system
 * ones and the harness's own, minus Prisma's `_prisma_migrations`. Also left out:
 * partitions, because their partitioned parent reaches them; temporary tables, which
 * belong to other sessions; and tables an extension owns (PostGIS's `spatial_ref_sys`),
 * which hold reference data the migrations never wrote.
 */
export const TABLES_CTE = `tables AS (
  SELECT c.oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', '${HARNESS_SCHEMA}')
    AND n.nspname NOT LIKE 'pg\\_toast%'
    AND c.relname <> '_prisma_migrations'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend e
      WHERE e.classid = 'pg_catalog.pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e'
    )
)`;

/**
 * The sequences owned by a column of one of {@link TABLES_CTE}'s tables — `serial`
 * columns (`pg_depend` type `a`) and identity columns (type `i`) — as the CTE
 * `sequences (oid, schema, name, start_value, table_oid)`. Needs `tables` before it.
 * `start_value` is text, so no driver turns an `int8` into a `bigint` or a `number` on
 * its own terms.
 */
export const OWNED_SEQUENCES_CTE = `sequences AS (
  SELECT s.oid, sn.nspname::text AS schema, s.relname::text AS name,
    q.seqstart::text AS start_value, t.oid AS table_oid
  FROM pg_catalog.pg_class s
  JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
  JOIN pg_catalog.pg_sequence q ON q.seqrelid = s.oid
  JOIN pg_catalog.pg_depend d
    ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = s.oid
    AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')
  JOIN tables t ON t.oid = d.refobjid
  WHERE s.relkind = 'S'
)`;

/**
 * Create the harness schema in the Template Database: the catalog, the sequence
 * positions, the dirty table and the tracking trigger function. Always installed, even
 * when the Baseline is empty, so every Worker Database has a catalog for discovery to
 * read. Several statements, so one implicit transaction: all of it or none.
 */
export const HARNESS_SCHEMA_STATEMENT = [
  `CREATE SCHEMA "${HARNESS_SCHEMA}"`,
  `CREATE TABLE ${CATALOG} (ordinal int PRIMARY KEY, schema text NOT NULL, name text NOT NULL, ` +
    "relkind text NOT NULL, columns text[] NOT NULL)",
  `CREATE TABLE ${SEQUENCE_CATALOG} (schema text NOT NULL, name text NOT NULL, ` +
    "last_value bigint NOT NULL, is_called boolean NOT NULL, PRIMARY KEY (schema, name))",
  // No unique index: under one, a second transaction marking the same table would wait
  // on the first's uncommitted mark — a lock the app never takes in production.
  // Duplicate marks are harmless. Unlogged: it only ever holds marks between two Resets.
  `CREATE UNLOGGED TABLE ${DIRTY} (ordinal int NOT NULL)`,
  // SECURITY DEFINER, owned by the installing superuser: a test writing a Baseline table
  // as a restricted role needs no privilege on the harness schema, which stays private.
  // The pinned search_path and the qualified names keep a definer function safe.
  `CREATE FUNCTION ${MARK_DIRTY}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER ` +
    "SET search_path = pg_catalog, pg_temp AS $mark$\nBEGIN\n" +
    `  INSERT INTO ${DIRTY} (ordinal) SELECT TG_ARGV[0]::int\n` +
    `  WHERE NOT EXISTS (SELECT 1 FROM ${DIRTY} WHERE ordinal = TG_ARGV[0]::int);\n` +
    "  RETURN NULL;\nEND\n$mark$",
  `REVOKE ALL ON FUNCTION ${MARK_DIRTY}() FROM PUBLIC`,
].join(";\n");

/**
 * The install's view of the managed relations: every table of {@link TABLES_CTE}, and
 * every owned sequence with the table that owns it. Read on the template, after the
 * harness schema exists and before anything is snapshotted.
 */
export const BASELINE_CANDIDATES_QUERY = `
WITH ${TABLES_CTE},
${OWNED_SEQUENCES_CTE}
SELECT 'table' AS kind, schema, name, relkind, NULL::text AS owner_schema, NULL::text AS owner_name
FROM tables
UNION ALL
SELECT 'sequence', s.schema, s.name, 'S', t.schema, t.name
FROM sequences s JOIN tables t ON t.oid = s.table_oid
ORDER BY 1, 2, 3`;

/** One row of {@link BASELINE_CANDIDATES_QUERY}. A type, not an interface, so it is a row. */
export type BaselineCandidate = {
  kind: "table" | "sequence";
  schema: string;
  name: string;
  relkind: "r" | "p" | "S";
  /** The owning table of a sequence; `null` for a table. */
  owner_schema: string | null;
  owner_name: string | null;
};

/**
 * The query that tells which of `tables` hold rows: one row, `{ index }`, per non-empty
 * table, its position in `tables`. `undefined` when there is no table to ask about.
 */
export function nonEmptyTablesQuery(tables: readonly QualifiedName[]): string | undefined {
  if (tables.length === 0) return undefined;
  return tables
    .map((table, index) => `SELECT ${index} AS index WHERE EXISTS (SELECT 1 FROM ${quoted(table)})`)
    .join("\nUNION ALL\n");
}

/** A Baseline table as the install sees it. */
export interface BaselineSource extends QualifiedName {
  relkind: "r" | "p";
}

/** What the install snapshots: the Baseline tables, and the sequences they own. */
export interface BaselinePlan {
  tables: BaselineSource[];
  sequences: QualifiedName[];
}

/**
 * Pick the Baseline from the candidates and the indexes {@link nonEmptyTablesQuery}
 * reported, among the candidates' tables: those tables, in candidate order, and the
 * sequences they own.
 */
export function planBaseline(
  candidates: readonly BaselineCandidate[],
  nonEmpty: readonly number[],
): BaselinePlan {
  const candidateTables = candidates.filter((candidate) => candidate.kind === "table");
  const picked = new Set(nonEmpty);
  const tables = candidateTables
    .filter((_, index) => picked.has(index))
    .map(
      ({ schema, name, relkind }) =>
        ({ schema, name, relkind: relkind === "p" ? "p" : "r" }) as const,
    );
  const owners = new Set(tables.map((table) => quoted(table)));
  const sequences = candidates
    .filter(
      (candidate) =>
        candidate.kind === "sequence" &&
        candidate.owner_schema !== null &&
        candidate.owner_name !== null &&
        owners.has(quoted({ schema: candidate.owner_schema, name: candidate.owner_name })),
    )
    .map(({ schema, name }) => ({ schema, name }));
  return { tables, sequences };
}

/**
 * The statement that snapshots the Baseline into the harness schema, or `undefined` for
 * an empty Baseline. Several statements in one string, so one implicit transaction.
 * For the table at position `i`, ordinal `i + 1`:
 *
 * - a copy, `prisma_test_helper.t<ordinal>`: `CREATE TABLE … AS`, so it carries no
 *   constraint, index or trigger. Named by ordinal because Postgres truncates
 *   identifiers at 63 bytes, and names built from the source would collide;
 * - its catalog row, with the restore's column list read from `pg_attribute` —
 *   dropped and generated columns left out;
 * - for an ordinary table, the statement-level trigger that marks it dirty. Created with
 *   default enablement, so the Reset's `session_replication_role = replica` silences it
 *   and a restore does not mark its table dirty again. A partitioned table gets none:
 *   a statement aimed straight at a partition never fires the parent's statement
 *   trigger, so partitioned Baseline tables are restored on every Reset instead.
 *
 * Then each owned sequence's `last_value` and `is_called`, which the Reset restores with
 * `setval` instead of rewinding to the start value.
 */
export function snapshotStatement(plan: BaselinePlan): string | undefined {
  if (plan.tables.length === 0) return undefined;
  const statements = plan.tables.flatMap((table, index) => {
    const ordinal = index + 1;
    const source = quoted(table);
    const columns =
      "ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a " +
      `WHERE a.attrelid = ${literal(source)}::regclass AND a.attnum > 0 ` +
      "AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum)";
    return [
      `CREATE TABLE ${snapshotCopy(ordinal)} AS SELECT * FROM ${source}`,
      `INSERT INTO ${CATALOG} (ordinal, schema, name, relkind, columns) VALUES (${ordinal}, ` +
        `${literal(table.schema)}, ${literal(table.name)}, ${literal(table.relkind)}, ${columns})`,
      ...(table.relkind === "r"
        ? [
            `CREATE TRIGGER ${TRIGGER} AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${source} ` +
              `FOR EACH STATEMENT EXECUTE FUNCTION ${MARK_DIRTY}('${ordinal}')`,
          ]
        : []),
    ];
  });
  for (const sequence of plan.sequences) {
    statements.push(
      `INSERT INTO ${SEQUENCE_CATALOG} (schema, name, last_value, is_called) SELECT ` +
        `${literal(sequence.schema)}, ${literal(sequence.name)}, last_value, is_called ` +
        `FROM ${quoted(sequence)}`,
    );
  }
  return statements.join(";\n");
}
