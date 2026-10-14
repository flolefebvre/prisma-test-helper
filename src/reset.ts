// The Reset: the pass that returns a Worker Database to its Baseline — every table
// empty but those the migrations left rows in, which it restores — once before a file's
// first test and once after every test. Tests commit for real, so this is what keeps
// one test's rows out of the next. It runs through the consumer's own Prisma client —
// structurally typed below, never imported — so the package needs no database driver
// and the statement lands on the connection the tests themselves use.
//
// Why DELETE and not TRUNCATE, why the DELETEs are gated on a storage probe, why a
// VACUUM runs between files, and the numbers behind all three: docs/adr/0001. How the
// Baseline is tracked and restored: docs/adr/0002-baseline-restore.md.

import {
  CATALOG,
  DIRTY as DIRTY_MARKS,
  literal,
  OWNED_SEQUENCES_CTE,
  quoted,
  SEQUENCE_CATALOG,
  snapshotCopy,
  TABLES_CTE,
  type QualifiedName,
} from "./baseline.js";

export type { QualifiedName } from "./baseline.js";

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
 * Every table the Reset empties or restores, and every sequence it rewinds — one row per
 * relation, `kind` telling them apart.
 *
 * Tables: those of the shared `TABLES_CTE` (`./baseline.js`) — ordinary and partitioned
 * (`relkind` `r`, `p`, carried in the row) in every schema but the system ones and the
 * harness's own `prisma_test_helper`, minus Prisma's own `_prisma_migrations`. Also left
 * out: partitions, because their partitioned parent already reaches them; temporary
 * tables, which belong to other sessions; and tables an extension owns (PostGIS's
 * `spatial_ref_sys`), which hold reference data the migrations never wrote. A table the
 * harness catalog lists is a **Baseline table** — it held rows after migrate — and comes
 * with its `ordinal` and the `columns` its restore writes; the Reset restores it from its
 * snapshot instead of emptying it. Every other table is emptied.
 *
 * Sequences: those owned by a column of a discovered table — `serial` columns
 * (`pg_depend` type `a`) and identity columns (type `i`) — each with the `start_value`
 * the Reset rewinds it to, carried as text so no driver turns an `int8` into a `bigint`
 * or a `number` on its own terms. One a Baseline table owns also carries its snapshot
 * position, `last_value` and `is_called`, which the Reset restores instead. A
 * standalone sequence no column owns is left alone: nothing ties it to a table the Reset
 * empties, and its value may be meant to outlive a test.
 */
export const DISCOVERY_QUERY = `
WITH ${TABLES_CTE},
${OWNED_SEQUENCES_CTE}
SELECT 'table' AS kind, t.schema, t.name, t.relkind, NULL::text AS start_value,
  b.ordinal, b.columns, NULL::text AS last_value, NULL::boolean AS is_called
FROM tables t LEFT JOIN ${CATALOG} b ON b.schema = t.schema AND b.name = t.name
UNION ALL
SELECT 'sequence', s.schema, s.name, 'S', s.start_value, NULL, NULL, p.last_value::text, p.is_called
FROM sequences s LEFT JOIN ${SEQUENCE_CATALOG} p ON p.schema = s.schema AND p.name = s.name
ORDER BY 1, 2, 3`;

/** One row of {@link DISCOVERY_QUERY}. */
export interface DiscoveredRelation extends QualifiedName {
  kind: "table" | "sequence";
  /** `pg_class.relkind`: `r` for an ordinary table, `p` a partitioned one, `S` a sequence. */
  relkind: "r" | "p" | "S";
  /** The sequence's `start_value`, as decimal text; `null` for a table. */
  start_value: string | null;
  /** A Baseline table's ordinal in the harness catalog; `null` for any other relation. */
  ordinal?: number | null;
  /** The columns a Baseline table's restore writes, in order; `null` otherwise. */
  columns?: string[] | null;
  /** A Baseline-owned sequence's snapshot `last_value`, as decimal text; `null` otherwise. */
  last_value?: string | null;
  /** A Baseline-owned sequence's snapshot `is_called`; `null` otherwise. */
  is_called?: boolean | null;
}

/** A sequence the Reset rewinds: where it is, and the value it goes back to. */
export interface OwnedSequence extends QualifiedName {
  /** `pg_sequences.start_value`, as decimal text. */
  startValue: string;
  /**
   * For a sequence a Baseline table owns: its position at snapshot time, which the Reset
   * restores with `setval(…, lastValue, isCalled)` instead of rewinding to `startValue`.
   */
  snapshot?: { lastValue: string; isCalled: boolean };
}

/** A table the Reset empties: where it is, and whether it is partitioned (`relkind` `p`). */
export interface ResetTable extends QualifiedName {
  relkind: "r" | "p";
}

/**
 * A Baseline table the Reset restores from its snapshot copy: its catalog `ordinal`, and
 * the `columns` the restore writes (no generated or dropped ones), unquoted.
 */
export interface BaselineTable extends ResetTable {
  ordinal: number;
  columns: readonly string[];
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
 * The pair of data-modifying CTEs that restores one Baseline table from its snapshot
 * copy: `r<ordinal>d` deletes the table's rows, and `r<ordinal>` inserts the copy's.
 * CTEs of one statement run in no fixed order, so the insert reads the delete's count in
 * an initplan — evaluated once, before its first row — which finishes the delete first:
 * no restored key ever meets a live old one. `OVERRIDING SYSTEM VALUE` writes the
 * snapshot's values into `GENERATED ALWAYS` identity columns; on a table with none it
 * is a no-op. Generated and dropped columns are not in `columns`.
 */
function restoreCtes(table: BaselineTable): string {
  const source = quoted(table);
  const columns = table.columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ");
  const list = columns === "" ? "" : ` (${columns})`;
  const name = `r${table.ordinal}`;
  return (
    `${name}d AS (DELETE FROM ${source} RETURNING 1), ` +
    `${name} AS (INSERT INTO ${source}${list} OVERRIDING SYSTEM VALUE ` +
    `SELECT ${columns} FROM ${snapshotCopy(table.ordinal)} WHERE (SELECT count(*) FROM ${name}d) >= 0)`
  );
}

/**
 * Build the Reset statement: one PL/pgSQL `DO` block, sent in one round trip, that
 * empties every table, restores the Baseline tables a test wrote to, and rewinds every
 * owned sequence.
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
 * - **Baseline tables** (`baseline`, read from the harness catalog) are never emptied
 *   and never probed: their heaps hold rows by design. A second query reads, and
 *   clears, the dirty marks their triggers left, and keeps the restore CTEs of the
 *   tables marked (see {@link restoreCtes}). `replica` silences those triggers, so a
 *   restore marks nothing dirty again. Partitioned Baseline tables have no trigger and
 *   are restored every time. Design and numbers: docs/adr/0002-baseline-restore.md.
 * - The rest is **one SQL statement**, run with a single `EXECUTE`: the kept `DELETE`s
 *   and restores, and a final `SELECT` that calls `setval(…, start_value, false)` on
 *   every sequence — or, for one a Baseline table owns, `setval(…, last_value,
 *   is_called)` from the snapshot. Sequences are always rewound: a failed insert
 *   advances one and leaves its table's file empty, and its dirty mark rolled back. One
 *   statement is planned once, which keeps the cost flat in the number of tables
 *   (amendment 1).
 * - With an empty Baseline the statement is byte for byte the one before Baselines
 *   existed.
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
  baseline: readonly BaselineTable[] = [],
): string {
  for (const { schema, name, startValue, snapshot } of sequences) {
    if (!/^-?\d+$/.test(startValue)) {
      throw new Error(`cannot build the Reset: ${schema}.${name} has start value ${startValue}`);
    }
    if (snapshot !== undefined && !/^-?\d+$/.test(snapshot.lastValue)) {
      throw new Error(
        `cannot build the Reset: ${schema}.${name} has snapshot value ${snapshot.lastValue}`,
      );
    }
  }
  for (const { schema, name, ordinal } of baseline) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      throw new Error(`cannot build the Reset: ${schema}.${name} has ordinal ${ordinal}`);
    }
  }
  const deletes = tables.map((relation, index) => ({
    relation,
    sql: `d${index} AS (DELETE FROM ${quoted(relation)})`,
  }));
  const restores = baseline.map((relation) => ({ relation, sql: restoreCtes(relation) }));
  const rewinds = sequences.map((relation) => ({
    relation,
    sql:
      relation.snapshot === undefined
        ? `pg_catalog.setval(${literal(quoted(relation))}::regclass, ${relation.startValue}, false)`
        : `pg_catalog.setval(${literal(quoted(relation))}::regclass, ` +
          `${relation.snapshot.lastValue}, ${relation.snapshot.isCalled})`,
  }));
  // Every fragment lands inside both dollar quotes, so none may contain either tag.
  for (const { relation, sql } of [...deletes, ...restores, ...rewinds]) {
    for (const tag of [BLOCK_TAG, SQL_TAG]) {
      if (sql.includes(tag)) {
        throw new Error(
          `cannot build the Reset: ${relation.schema}.${relation.name} contains ${tag}`,
        );
      }
    }
  }

  const probed = deletes.filter(({ relation }) => relation.relkind !== "p");
  // Partitioned Baseline tables have no trigger — a write aimed straight at a partition
  // never fires the parent's — so they are restored on every Reset, like the partitioned
  // tables that are emptied, which have no file to probe.
  const tracked = restores.filter(({ relation }) => relation.relkind !== "p");
  const always = [...deletes, ...restores]
    .filter(({ relation }) => relation.relkind === "p")
    .map(({ sql }) => sql);
  const select = `SELECT ${rewinds.length > 0 ? rewinds.map(({ sql }) => sql).join(", ") : "1"}`;

  // Each kept fragment is aggregated into a variable by one query, before the EXECUTE.
  const gathered: { variable: string; query: string }[] = [];
  if (probed.length > 0) {
    const items = dirtyItems(
      probed.map(({ relation }) => relation),
      probed.map(({ sql }) => sql),
    );
    gathered.push({
      variable: "deletes",
      query: `SELECT string_agg(t.item, ', ') INTO deletes ${items};`,
    });
  }
  if (tracked.length > 0) {
    // Reads and clears the dirty marks at once. The DO block is one transaction, so the
    // marks are gone only if the restores they select commit with them.
    const ordinals = tracked.map(({ relation }) => relation.ordinal).join(", ");
    const items = tracked.map(({ sql }) => literal(sql)).join(", ");
    gathered.push({
      variable: "restores",
      query:
        `WITH dirty AS (DELETE FROM ${DIRTY_MARKS} RETURNING ordinal) ` +
        `SELECT string_agg(t.item, ', ') INTO restores FROM unnest(ARRAY[${ordinals}]::int[], ` +
        `ARRAY[${items}]::text[]) AS t(ordinal, item) ` +
        "WHERE t.ordinal IN (SELECT ordinal FROM dirty);",
    });
  }
  const variables = gathered.map(({ variable }) => variable);

  const lines = [`DO ${BLOCK_TAG}`];
  if (variables.length > 0) lines.push(`DECLARE ${variables.map((v) => `${v} text;`).join(" ")}`);
  lines.push(
    "BEGIN",
    "  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);",
    `  PERFORM pg_catalog.set_config('lock_timeout', '${LOCK_TIMEOUT}', true);`,
  );
  for (const { query } of gathered) lines.push(`  ${query}`);
  if (variables.length > 0) {
    // A variable is NULL when nothing it covers is kept, and so is any concatenation
    // with it.
    let head: string;
    if (always.length > 0) {
      head = `'WITH ' || ${variables.map((v) => `coalesce(${v} || ', ', '')`).join(" || ")}`;
    } else if (variables.length === 1) {
      head = `coalesce('WITH ' || ${variables[0]} || ' ', '')`;
    } else {
      head = `coalesce('WITH ' || nullif(concat_ws(', ', ${variables.join(", ")}), '') || ' ', '')`;
    }
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
 * never probes them.
 *
 * Every Baseline table (`baseline`) is listed too, under the same guard, unprobed: its
 * heap is never empty. Each restore leaves the old rows dead, and without a `VACUUM`
 * the restore's `DELETE` scans an ever larger heap — measured in
 * docs/adr/0002-baseline-restore.md: at 20 workers, restoring 2,000 rows went from
 * 43 ms to 160 ms per Reset over 8 files, and stayed near 49 ms with this `VACUUM`.
 * `undefined` when there is no table to ask about. Pure: unit-tested without a database.
 */
export function buildVacuumProbe(
  tables: readonly ResetTable[],
  baseline: readonly ResetTable[] = [],
): string | undefined {
  const probed = tables.filter((table) => table.relkind !== "p");
  const queries: string[] = [];
  if (probed.length > 0) {
    queries.push(
      `SELECT t.item AS name ${dirtyItems(probed, probed.map(quoted))} AND ${NO_OTHER_OPEN_TRANSACTION}`,
    );
  }
  if (baseline.length > 0) {
    const names = baseline.map((table) => literal(quoted(table))).join(", ");
    queries.push(
      `SELECT b.name FROM unnest(ARRAY[${names}]::text[]) AS b(name) WHERE ${NO_OTHER_OPEN_TRANSACTION}`,
    );
  }
  return queries.length > 0 ? queries.join(" UNION ALL ") : undefined;
}

/** What {@link prepareReset} resolves to: the Reset, and the `VACUUM` between files. */
export interface PreparedReset {
  /** Run the Reset. Rejects, naming the database, when it could not empty it. */
  reset(): Promise<void>;
  /**
   * `VACUUM (SKIP_LOCKED)` the tables whose heap file is not 0 bytes, so the next file's
   * first Reset on a fresh backend can skip them unopened, and every Baseline table, so
   * the dead rows its restores left do not slow the next file's. Best effort: it sends nothing
   * when no table is dirty (a bare `VACUUM` would process the whole database) or another
   * session has a transaction open, and it never rejects — the Reset is correct without
   * it, only slower.
   */
  vacuum(): Promise<void>;
}

/** What discovery produces for one Worker Database: the two statements built from it. */
interface Discovered {
  statement: string;
  vacuumProbe: string | undefined;
}

/** Build the Reset statement and the vacuum probe from the rows of {@link DISCOVERY_QUERY}. */
function discover(relations: readonly DiscoveredRelation[]): Discovered {
  const tables: ResetTable[] = [];
  const baseline: BaselineTable[] = [];
  for (const { kind, schema, name, relkind, ordinal, columns } of relations) {
    if (kind !== "table") continue;
    const table: ResetTable = { schema, name, relkind: relkind === "p" ? "p" : "r" };
    if (ordinal === null || ordinal === undefined) tables.push(table);
    else baseline.push({ ...table, ordinal: Number(ordinal), columns: columns ?? [] });
  }
  const sequences = relations
    .filter((relation) => relation.kind === "sequence")
    .map(({ schema, name, start_value, last_value, is_called }): OwnedSequence => {
      const sequence = { schema, name, startValue: start_value ?? "1" };
      return last_value === null || last_value === undefined
        ? sequence
        : { ...sequence, snapshot: { lastValue: last_value, isCalled: is_called === true } };
    });
  const statement = buildResetStatement(tables, sequences, baseline);
  // Baseline tables are never probed — their heaps are never empty — but always
  // vacuumed, as restores leave their old rows dead.
  const vacuumProbe = buildVacuumProbe(tables, baseline);
  return { statement, vacuumProbe };
}

// Discovery's products, per Worker Database URL, for as long as this module lives: one
// test file under `isolate: true`, every file a worker runs under `isolate: false`. Only
// strings built from the discovery rows are kept — never a client, never a closure — so
// each file's Reset still runs through the client that file passed. The schema is
// migrated once per run, before any worker starts, so it does not change under the
// cache; DDL a test runs itself is not seen by later files on the worker (a documented
// limit of `isolate: false`).
const discoveries = new Map<string, Discovered>();

/**
 * Forget every cached discovery, so the next {@link prepareReset} discovers again.
 * Internal: for tests that change the schema mid-run, and for unit tests; not on the
 * package root.
 */
export function clearResetCache(): void {
  discoveries.clear();
}

/**
 * Guard, discover, and build the Reset for one Worker Database; resolves to the
 * functions that run it and the `VACUUM` between files. Nothing is deleted before both
 * guards pass: the URL must name a Worker Database, and the client must actually be
 * connected to that database — a client module that reads some other variable than
 * `DATABASE_URL` would otherwise have the Reset empty whatever it points at. The first
 * raw query connects a client that is not yet connected, so a freshly built one works.
 *
 * Both guards run on every call. Discovery runs once per Worker Database URL for as long
 * as this module lives — once per file under `isolate: true`, once per worker under
 * `isolate: false` — and both statements are reused after it: the schema does not change
 * mid-run. A discovery that fails is not kept, so the next call tries again.
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

  let cached = discoveries.get(databaseUrl);
  if (cached === undefined) {
    cached = discover((await db.$queryRawUnsafe(DISCOVERY_QUERY)) as DiscoveredRelation[]);
    discoveries.set(databaseUrl, cached);
  }
  const { statement, vacuumProbe } = cached;

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
