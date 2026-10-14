import { describe, expect, test } from "vitest";

import {
  BASELINE_CANDIDATES_QUERY,
  HARNESS_SCHEMA_STATEMENT,
  nonEmptyTablesQuery,
  planBaseline,
  snapshotStatement,
  TABLES_CTE,
  type BaselineCandidate,
} from "./baseline.js";
import { DISCOVERY_QUERY } from "./reset.js";

// Pure builders, checked without a database. That the install actually snapshots a
// template, and that every Worker Database inherits it, is proven by
// tests/integration/baseline.test.ts.

const table = (schema: string, name: string, relkind: "r" | "p" = "r"): BaselineCandidate => ({
  kind: "table",
  schema,
  name,
  relkind,
  owner_schema: null,
  owner_name: null,
});
const sequence = (name: string, owner: string): BaselineCandidate => ({
  kind: "sequence",
  schema: "public",
  name,
  relkind: "S",
  owner_schema: "public",
  owner_name: owner,
});

describe("which tables count", () => {
  // One definition, shared: a drifted copy would snapshot a table the Reset does not
  // know, or reset one it should not.
  test("discovery and the install share the one table definition", () => {
    expect(DISCOVERY_QUERY).toContain(TABLES_CTE);
    expect(BASELINE_CANDIDATES_QUERY).toContain(TABLES_CTE);
  });

  test("leaves out the harness's own schema", () => {
    expect(TABLES_CTE).toContain(
      "n.nspname NOT IN ('pg_catalog', 'information_schema', 'prisma_test_helper')",
    );
  });
});

describe("HARNESS_SCHEMA_STATEMENT", () => {
  test("creates the schema, its catalog, the dirty table and the trigger function", () => {
    expect(HARNESS_SCHEMA_STATEMENT).toContain('CREATE SCHEMA "prisma_test_helper"');
    expect(HARNESS_SCHEMA_STATEMENT).toContain('CREATE TABLE "prisma_test_helper"."baseline"');
    expect(HARNESS_SCHEMA_STATEMENT).toContain('CREATE TABLE "prisma_test_helper"."sequence"');
    expect(HARNESS_SCHEMA_STATEMENT).toContain(
      'CREATE UNLOGGED TABLE "prisma_test_helper"."dirty" (ordinal int NOT NULL)',
    );
  });

  test("marks a table without an index another transaction would have to wait on", () => {
    expect(HARNESS_SCHEMA_STATEMENT).not.toMatch(/dirty"? \([^)]*(PRIMARY KEY|UNIQUE)/);
    expect(HARNESS_SCHEMA_STATEMENT).not.toContain("ON CONFLICT");
    expect(HARNESS_SCHEMA_STATEMENT).toContain("WHERE NOT EXISTS (SELECT 1 FROM");
  });

  test("runs the trigger function as its definer, on a pinned search_path", () => {
    expect(HARNESS_SCHEMA_STATEMENT).toContain(
      "SECURITY DEFINER SET search_path = pg_catalog, pg_temp",
    );
    expect(HARNESS_SCHEMA_STATEMENT).toContain(
      'REVOKE ALL ON FUNCTION "prisma_test_helper"."prisma_test_helper_mark_dirty"() FROM PUBLIC',
    );
    expect(HARNESS_SCHEMA_STATEMENT).not.toMatch(/GRANT /);
  });
});

describe("nonEmptyTablesQuery", () => {
  test("asks, per table, whether it holds a row, and answers with its position", () => {
    expect(nonEmptyTablesQuery([table("public", "Category"), table("odd", 'a "b"')])).toBe(
      'SELECT 0 AS index WHERE EXISTS (SELECT 1 FROM "public"."Category")\n' +
        "UNION ALL\n" +
        'SELECT 1 AS index WHERE EXISTS (SELECT 1 FROM "odd"."a ""b""")',
    );
  });

  test("is undefined when there is no table", () => {
    expect(nonEmptyTablesQuery([])).toBeUndefined();
  });
});

describe("planBaseline", () => {
  const candidates = [
    sequence("Author_id_seq", "Author"),
    sequence("Category_id_seq", "Category"),
    table("public", "Author"),
    table("public", "Category"),
    table("public", "Reading", "p"),
  ];

  test("keeps the non-empty tables, in order, and the sequences they own", () => {
    expect(planBaseline(candidates, [2, 1])).toEqual({
      tables: [
        { schema: "public", name: "Category", relkind: "r" },
        { schema: "public", name: "Reading", relkind: "p" },
      ],
      sequences: [{ schema: "public", name: "Category_id_seq" }],
    });
  });

  test("is empty when every table is", () => {
    expect(planBaseline(candidates, [])).toEqual({ tables: [], sequences: [] });
  });
});

describe("snapshotStatement", () => {
  const statement = snapshotStatement({
    tables: [
      { schema: "public", name: "Category", relkind: "r" },
      { schema: "public", name: "Reading", relkind: "p" },
    ],
    sequences: [{ schema: "public", name: "Category_id_seq" }],
  })!;

  test("copies each table by ordinal, so no long name can collide with another", () => {
    expect(statement).toContain(
      'CREATE TABLE "prisma_test_helper"."t1" AS SELECT * FROM "public"."Category"',
    );
    expect(statement).toContain(
      'CREATE TABLE "prisma_test_helper"."t2" AS SELECT * FROM "public"."Reading"',
    );
  });

  test("catalogs each table with the columns a restore writes: no dropped or generated ones", () => {
    expect(statement).toContain(
      'INSERT INTO "prisma_test_helper"."baseline" (ordinal, schema, name, relkind, columns) ' +
        "VALUES (1, 'public', 'Category', 'r', ARRAY(SELECT a.attname::text FROM " +
        'pg_catalog.pg_attribute a WHERE a.attrelid = \'"public"."Category"\'::regclass ' +
        "AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum))",
    );
  });

  test("tracks an ordinary table with a statement trigger, a partitioned one not at all", () => {
    expect(statement).toContain(
      'CREATE TRIGGER "prisma_test_helper_dirty" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ' +
        'ON "public"."Category" FOR EACH STATEMENT EXECUTE FUNCTION ' +
        '"prisma_test_helper"."prisma_test_helper_mark_dirty"(\'1\')',
    );
    expect(statement.match(/CREATE TRIGGER/g)).toHaveLength(1);
    // Default enablement only: an ALWAYS or REPLICA trigger would fire during the
    // Reset's `session_replication_role = replica` restore.
    expect(statement).not.toMatch(/ENABLE (ALWAYS|REPLICA)/);
  });

  test("records each owned sequence's position, not its start", () => {
    expect(statement).toContain(
      'INSERT INTO "prisma_test_helper"."sequence" (schema, name, last_value, is_called) ' +
        "SELECT 'public', 'Category_id_seq', last_value, is_called FROM \"public\".\"Category_id_seq\"",
    );
  });

  test("quotes names in identifiers and literals alike", () => {
    const odd = snapshotStatement({
      tables: [{ schema: "it's", name: 'a "b"', relkind: "r" }],
      sequences: [],
    })!;

    expect(odd).toContain(`SELECT * FROM "it's"."a ""b"""`);
    expect(odd).toContain(`VALUES (1, 'it''s', 'a "b"', 'r',`);
    expect(odd).toContain(`a.attrelid = '"it''s"."a ""b"""'::regclass`);
  });

  test("is undefined for an empty Baseline", () => {
    expect(snapshotStatement({ tables: [], sequences: [] })).toBeUndefined();
  });
});
