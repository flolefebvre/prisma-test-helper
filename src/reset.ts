// The Reset: the pass that returns a Worker Database to empty, once before a file's
// first test and once after every test. Tests commit for real, so this is what keeps
// one test's rows out of the next. It runs through the consumer's own Prisma client —
// structurally typed below, never imported — so the package needs no database driver
// and the statement lands on the connection the tests themselves use.
//
// Why DELETE and not TRUNCATE, why the DELETEs are gated on a storage probe, why a
// VACUUM runs between files, and the numbers behind all three: docs/adr/0001.

/**
 * The slice of a Prisma client the Reset drives: one raw read (the guard's check, the
 * catalog discovery, the vacuum probe) and one raw write (the reset statement, the
 * `VACUUM` between files). Declared with method syntax so the check is bivariant — a
 * generated `PrismaClient`, whose raw methods are generic and return a `PrismaPromise`,
 * is assignable.
 */
export interface ResetClient {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/** A schema-qualified relation name, unquoted — the Reset builder quotes it. */
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
 * Tables: ordinary and partitioned (`relkind` `r`, `p`, carried in the row) in every
 * schema but the system ones, minus Prisma's own `_prisma_migrations`. Also left out:
 * partitions, because a DELETE on their partitioned parent already reaches them;
 * temporary tables, which belong to other sessions; and tables an extension owns
 * (PostGIS's `spatial_ref_sys`), which hold reference data the migrations never wrote.
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
  SELECT c.oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind
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
SELECT 'table' AS kind, schema, name, relkind, NULL::text AS start_value FROM tables
UNION ALL
SELECT 'sequence', sn.nspname::text, s.relname::text, s.relkind::text, q.seqstart::text
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
  /** `pg_class.relkind`: `r` for an ordinary table, `p` a partitioned one, `S` a sequence. */
  relkind: "r" | "p" | "S";
  /** The sequence's `start_value`, as decimal text; `null` for a table. */
  start_value: string | null;
}

/** A sequence the Reset rewinds: where it is, and the value it goes back to. */
export interface OwnedSequence extends QualifiedName {
  /** `pg_sequences.start_value`, as decimal text. */
  startValue: string;
}

/** A table the Reset empties: where it is, and whether it is partitioned (`relkind` `p`). */
export interface ResetTable extends QualifiedName {
  relkind: "r" | "p";
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

// The storage probe, over `t.rel`: true unless the table's heap file is 0 bytes.
// `pg_stat_file` reads the size with one stat() and never opens the relation, so a fresh
// backend builds no relcache entry for a table it then leaves alone — building those, to
// plan a DELETE on every table, is what made the first Reset on a backend cost ~85 ms
// instead of ~5. A name `to_regclass` no longer resolves, a missing file, or any other
// NULL counts as dirty: the probe may over-delete, never skip. Shared by the Reset and
// the vacuum query.
const DIRTY =
  "coalesce((pg_catalog.pg_stat_file(pg_catalog.pg_relation_filepath(t.rel), true)).size, 1) > 0";

/**
 * `FROM … WHERE …` keeping, as `t.item`, the item paired with each dirty table. The
 * candidate array is filtered directly, never joined to `pg_class`: a join lets the
 * planner run the probe on every relation in the database. Tables are resolved by name,
 * with `to_regclass`, each time it runs — never by a path or an OID cached at discovery:
 * `TRUNCATE` and `VACUUM FULL` give a table a new file, and a dropped table's OID can be
 * reused by another relation whose file is empty.
 */
function dirtyItems(tables: readonly QualifiedName[], items: readonly string[]): string {
  const relations = tables.map((table) => `pg_catalog.to_regclass(${literal(quoted(table))})`);
  return (
    `FROM unnest(ARRAY[${relations.join(", ")}], ARRAY[${items.map(literal).join(", ")}]::text[]) ` +
    `AS t(rel, item) WHERE ${DIRTY}`
  );
}

/**
 * Build the Reset statement: one PL/pgSQL `DO` block, sent in one round trip, that
 * empties every table and rewinds every owned sequence.
 *
 * - `session_replication_role = replica` switches off foreign-key triggers for the
 *   block, so tables are emptied in any order without cascades.
 * - Tables are **probed first**: one query over the candidate list keeps the
 *   data-modifying CTEs (`d0 AS (DELETE FROM …)`) of the tables whose heap file is not
 *   0 bytes. A table that was never written since its last `VACUUM` has an empty file, so
 *   it is skipped without being opened. On a fresh backend that is most of the Reset's
 *   cost; on a warm one the probe saves almost nothing and adds its own — the trade-off
 *   is measured in amendment 2 of docs/adr/0001. Partitioned parents have no file of
 *   their own and their partitions are not candidates, so their `DELETE` is never
 *   probed.
 * - The rest is **one SQL statement**, run with a single `EXECUTE`: the kept `DELETE`s
 *   and a final `SELECT` that calls `setval(…, start_value, false)` on every sequence.
 *   Sequences are always rewound: a failed insert advances one and leaves its table's
 *   file empty. One statement is planned once, which keeps the cost flat in the number
 *   of tables (amendment 1).
 * - Both settings are transaction-local, so they end with the statement.
 *
 * Identifiers are quoted here, by {@link quoted}, so mixed-case, reserved-word, and
 * otherwise odd names are safe; the probe's fragments travel as string literals. Known
 * limit: `setval` cannot reach values another session has already cached, so a sequence
 * declared with `CACHE` above 1 (never emitted by Prisma) can hand a later test pre-Reset
 * ids from a pooled connection. Pure: unit-tested without a database.
 */
export function buildResetStatement(
  tables: readonly ResetTable[],
  sequences: readonly OwnedSequence[],
): string {
  for (const { schema, name, startValue } of sequences) {
    if (!/^-?\d+$/.test(startValue)) {
      throw new Error(`cannot build the Reset: ${schema}.${name} has start value ${startValue}`);
    }
  }
  const deletes = tables.map((relation, index) => ({
    relation,
    sql: `d${index} AS (DELETE FROM ${quoted(relation)})`,
  }));
  const rewinds = sequences.map((relation) => ({
    relation,
    sql: `pg_catalog.setval(${literal(quoted(relation))}::regclass, ${relation.startValue}, false)`,
  }));
  // Every fragment lands inside both dollar quotes, so none may contain either tag.
  for (const { relation, sql } of [...deletes, ...rewinds]) {
    for (const tag of [BLOCK_TAG, SQL_TAG]) {
      if (sql.includes(tag)) {
        throw new Error(
          `cannot build the Reset: ${relation.schema}.${relation.name} contains ${tag}`,
        );
      }
    }
  }

  const probed = deletes.filter(({ relation }) => relation.relkind !== "p");
  const always = deletes.filter(({ relation }) => relation.relkind === "p").map(({ sql }) => sql);
  const select = `SELECT ${rewinds.length > 0 ? rewinds.map(({ sql }) => sql).join(", ") : "1"}`;

  const lines = [`DO ${BLOCK_TAG}`];
  if (probed.length > 0) lines.push("DECLARE deletes text;");
  lines.push(
    "BEGIN",
    "  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);",
    `  PERFORM pg_catalog.set_config('lock_timeout', '${LOCK_TIMEOUT}', true);`,
  );
  if (probed.length > 0) {
    const items = dirtyItems(
      probed.map(({ relation }) => relation),
      probed.map(({ sql }) => sql),
    );
    lines.push(`  SELECT string_agg(t.item, ', ') INTO deletes ${items};`);
    // `deletes` is NULL when nothing is dirty, and so is any concatenation with it.
    const head =
      always.length > 0
        ? "'WITH ' || coalesce(deletes || ', ', '')"
        : "coalesce('WITH ' || deletes || ' ', '')";
    const tail = always.length > 0 ? `${always.join(", ")} ${select}` : select;
    lines.push(`  EXECUTE ${head} || ${SQL_TAG}${tail}${SQL_TAG};`);
  } else if (always.length > 0 || rewinds.length > 0) {
    const sql = (always.length > 0 ? `WITH ${always.join(", ")} ` : "") + select;
    lines.push(`  EXECUTE ${SQL_TAG}${sql}${SQL_TAG};`);
  }
  lines.push("END", BLOCK_TAG);
  return lines.join("\n");
}

// No other client session of this database is inside a transaction. One that is — a
// connection the file leaked — may hold a lock on a table, and VACUUM's truncation of
// it would then retry for about 5 s before giving up (measured in amendment 2).
const NO_OTHER_OPEN_TRANSACTION =
  "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a " +
  "WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid() " +
  "AND a.backend_type = 'client backend' AND a.xact_start IS NOT NULL)";

/**
 * Build the query behind the `VACUUM` between files: one row per table whose heap file
 * is not 0 bytes, its quoted name in `name` — or no rows at all while another session of
 * the database has a transaction open. Partitioned parents are left out, as the Reset
 * never probes them. `undefined` when no table is ever probed, so there is nothing to
 * ask. Pure: unit-tested without a database.
 */
export function buildVacuumProbe(tables: readonly ResetTable[]): string | undefined {
  const probed = tables.filter((table) => table.relkind !== "p");
  if (probed.length === 0) return undefined;
  return `SELECT t.item AS name ${dirtyItems(probed, probed.map(quoted))} AND ${NO_OTHER_OPEN_TRANSACTION}`;
}

/** A schema-qualified, quoted SQL identifier: only `"` needs doubling. */
function quoted({ schema, name }: QualifiedName): string {
  return [schema, name].map((part) => `"${part.replaceAll('"', '""')}"`).join(".");
}

/** A SQL string literal. `standard_conforming_strings` is on, so only `'` needs doubling. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** What {@link prepareReset} resolves to: the Reset, and the `VACUUM` between files. */
export interface PreparedReset {
  /** Run the Reset. Rejects, naming the database, when it could not empty it. */
  reset(): Promise<void>;
  /**
   * `VACUUM (SKIP_LOCKED)` the tables whose heap file is not 0 bytes, so the next file's
   * first Reset on a fresh backend can skip them unopened. Best effort: it sends nothing
   * when no table is dirty (a bare `VACUUM` would process the whole database) or another
   * session has a transaction open, and it never rejects — the Reset is correct without
   * it, only slower.
   */
  vacuum(): Promise<void>;
}

/**
 * Guard, discover, and build the Reset for one Worker Database; resolves to the
 * functions that run it and the `VACUUM` between files. Nothing is deleted before both
 * guards pass: the URL must name a Worker Database, and the client must actually be
 * connected to that database — a client module that reads some other variable than
 * `DATABASE_URL` would otherwise have the Reset empty whatever it points at. The first
 * raw query connects a client that is not yet connected, so a freshly built one works.
 *
 * Discovery runs once here and both statements are reused after it: the schema does not
 * change mid-run.
 */
export async function prepareReset(
  db: ResetClient,
  databaseUrl: string,
  templateName: string,
): Promise<PreparedReset> {
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
  const tables = relations
    .filter((relation) => relation.kind === "table")
    .map(({ schema, name, relkind }): ResetTable => ({
      schema,
      name,
      relkind: relkind === "p" ? "p" : "r",
    }));
  const statement = buildResetStatement(
    tables,
    relations
      .filter((relation) => relation.kind === "sequence")
      .map(({ schema, name, start_value }) => ({ schema, name, startValue: start_value ?? "1" })),
  );
  const vacuumProbe = buildVacuumProbe(tables);

  return {
    async reset() {
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
    },

    async vacuum() {
      if (vacuumProbe === undefined) return;
      try {
        const dirty = (await db.$queryRawUnsafe(vacuumProbe)) as { name: string }[];
        if (dirty.length === 0) return;
        // The names are the probe's own pre-quoted items, sent back unchanged.
        await db.$executeRawUnsafe(
          `VACUUM (SKIP_LOCKED) ${dirty.map(({ name }) => name).join(", ")}`,
        );
      } catch {
        // Best effort: a failed VACUUM leaves heaps nonzero, which only makes the next
        // file's first Reset slower. It must not fail this file.
      }
    },
  };
}
