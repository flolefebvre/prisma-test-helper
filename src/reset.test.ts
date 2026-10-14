import { describe, expect, test } from "vitest";

import {
  assertWorkerDatabase,
  buildResetStatement,
  buildVacuumProbe,
  prepareReset,
  type BaselineTable,
  type DiscoveredRelation,
  type ResetClient,
  type ResetTable,
} from "./reset.js";

// Everything here runs without a database: the guard and the builders are pure, and
// `prepareReset` is driven through a stub client that answers its raw reads. That the
// statements actually empty and vacuum a real database is proven by
// tests/integration/reset.test.ts and tests/integration/vacuum.test.ts.

const WORKER_URL = "postgresql://u:p@localhost:5432/prisma_test_1";

// The storage probe both builders share: a NULL size counts as dirty.
const PROBE =
  "coalesce((pg_catalog.pg_stat_file(pg_catalog.pg_relation_filepath(t.rel), true)).size, 1) > 0";

// Worker Databases are named `<templateName>_<pool id>`, so the guard admits exactly
// that shape: every near-miss below is refused, including the Template Database itself
// and — the case the guard exists for — the dev database.
describe("assertWorkerDatabase", () => {
  test.each([
    ["prisma_test_1", "prisma_test"],
    ["prisma_test_12", "prisma_test"],
    ["myapp_test_3", "myapp_test"],
  ])("admits %s for template %s and returns its name", (name, template) => {
    expect(assertWorkerDatabase(`postgresql://u:p@localhost:5432/${name}`, template)).toBe(name);
  });

  test.each([
    ["prisma_test", "prisma_test", "the Template Database itself"],
    ["prisma_test_", "prisma_test", "an underscore with no pool id"],
    ["prisma_test_1x", "prisma_test", "a pool id that is not digits only"],
    ["prisma_testx", "prisma_test", "a longer name sharing the prefix"],
    ["myapp", "myapp_test", "the dev database"],
    ["prisma_test_1", "myapp_test", "another template's Worker Database"],
    ["myxapp_1", "my.app", "a `.` in the template name read as a regex wildcard"],
  ])("refuses %s for template %s — %s", (name, template) => {
    expect(() => assertWorkerDatabase(`postgresql://u:p@localhost:5432/${name}`, template)).toThrow(
      `refusing to reset ${name} — only Worker Databases (${template}_<pool id>) may be reset`,
    );
  });

  test("refuses a URL with no path — the database name is empty", () => {
    expect(() => assertWorkerDatabase("postgresql://u:p@localhost:5432", "prisma_test")).toThrow(
      "refusing to reset  —",
    );
  });

  test("throws on a string that is not a URL", () => {
    expect(() => assertWorkerDatabase("", "prisma_test")).toThrow(/Invalid URL/);
    expect(() => assertWorkerDatabase("not a url", "prisma_test")).toThrow(/Invalid URL/);
  });
});

const author: ResetTable = { schema: "public", name: "Author", relkind: "r" };
const order: ResetTable = { schema: "billing", name: "order", relkind: "r" };
const measurement: ResetTable = { schema: "public", name: "measurement", relkind: "p" };
const authorSeq = { schema: "public", name: "Author_id_seq", startValue: "1" };

describe("buildResetStatement", () => {
  test("is one DO block that relaxes FK triggers and bounds lock waits, both locally", () => {
    const statement = buildResetStatement([author], [authorSeq]);

    expect(statement.startsWith("DO $reset$\n")).toBe(true);
    expect(statement.endsWith("\nEND\n$reset$")).toBe(true);
    expect(statement).toContain(
      "PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);",
    );
    expect(statement).toContain("PERFORM pg_catalog.set_config('lock_timeout', '5s', true);");
  });

  test("keeps the DELETE of each table whose heap file is not empty, resolved by name", () => {
    const statement = buildResetStatement([author, order], []);

    // One probe over the candidate array itself — no join to pg_class, which would stat
    // every relation in the database — pairing each table with its pre-quoted CTE.
    expect(statement).toContain(
      "  SELECT string_agg(t.item, ', ') INTO deletes FROM unnest(ARRAY[" +
        'pg_catalog.to_regclass(\'"public"."Author"\'), ' +
        'pg_catalog.to_regclass(\'"billing"."order"\')], ARRAY[' +
        '\'d0 AS (DELETE FROM "public"."Author")\', ' +
        '\'d1 AS (DELETE FROM "billing"."order")\']::text[]) ' +
        `AS t(rel, item) WHERE ${PROBE};`,
    );
    expect(statement).toContain("DECLARE deletes text;");
    expect(statement).not.toContain("pg_class");
  });

  test("rewinds every sequence in the one EXECUTE, unprobed, whatever the tables hold", () => {
    const statement = buildResetStatement(
      [author, order],
      [authorSeq, { schema: "billing", name: "order_id_seq", startValue: "1000" }],
    );

    // `deletes` is NULL when no table is dirty, so the WITH clause drops out entirely.
    expect(statement).toContain(
      "  EXECUTE coalesce('WITH ' || deletes || ' ', '') || $reset_sql$" +
        'SELECT pg_catalog.setval(\'"public"."Author_id_seq"\'::regclass, 1, false), ' +
        'pg_catalog.setval(\'"billing"."order_id_seq"\'::regclass, 1000, false)' +
        "$reset_sql$;",
    );
    expect(statement.match(/EXECUTE /g)).toHaveLength(1);
  });

  test("always empties a partitioned parent, which has no file to probe", () => {
    const statement = buildResetStatement([author, measurement], []);

    expect(statement).toContain(
      "  EXECUTE 'WITH ' || coalesce(deletes || ', ', '') || $reset_sql$" +
        'd1 AS (DELETE FROM "public"."measurement") SELECT 1$reset_sql$;',
    );
    expect(statement).not.toContain('to_regclass(\'"public"."measurement"\')');
  });

  test("with only partitioned parents, probes nothing and empties them outright", () => {
    const statement = buildResetStatement([measurement], [authorSeq]);

    expect(statement).toContain(
      '  EXECUTE $reset_sql$WITH d0 AS (DELETE FROM "public"."measurement") ' +
        'SELECT pg_catalog.setval(\'"public"."Author_id_seq"\'::regclass, 1, false)$reset_sql$;',
    );
    expect(statement).not.toContain("DECLARE");
    expect(statement).not.toContain("pg_stat_file");
  });

  test("quotes identifiers, doubling embedded quotes in both the name and its literals", () => {
    const statement = buildResetStatement(
      [{ schema: "public", name: 'it\'s "odd"', relkind: "r" }],
      [],
    );

    expect(statement).toContain('pg_catalog.to_regclass(\'"public"."it\'\'s ""odd"""\')');
    expect(statement).toContain('\'d0 AS (DELETE FROM "public"."it\'\'s ""odd""")\'');
  });

  test("a sequence with no table still gets its rewind, unprobed", () => {
    const statement = buildResetStatement([], [authorSeq]);

    expect(statement).toContain("  EXECUTE $reset_sql$SELECT pg_catalog.setval(");
    expect(statement).not.toContain("DECLARE");
  });

  test("a table with no sequence still runs its EXECUTE, selecting 1", () => {
    expect(buildResetStatement([author], [])).toContain(
      "  EXECUTE coalesce('WITH ' || deletes || ' ', '') || $reset_sql$SELECT 1$reset_sql$;",
    );
  });

  test("stays a valid block for an empty schema, executing nothing", () => {
    expect(buildResetStatement([], [])).toMatch(/^DO \$reset\$\nBEGIN\n(.*\n){2}END\n\$reset\$$/);
    expect(buildResetStatement([], [])).not.toContain("EXECUTE");
  });

  test.each([
    ["a probed table", [{ schema: "public", name: "a$reset$b", relkind: "r" }], [], "$reset$"],
    [
      "a partitioned parent",
      [{ schema: "x$reset_sql$", name: "m", relkind: "p" }],
      [],
      "$reset_sql$",
    ],
    [
      "a sequence",
      [],
      [{ schema: "public", name: "a$reset_sql$b", startValue: "1" }],
      "$reset_sql$",
    ],
  ] as const)(
    "refuses %s whose fragment would contain a dollar-quote tag",
    (_, tables, sequences, tag) => {
      expect(() => buildResetStatement(tables, sequences)).toThrow(`contains ${tag}`);
    },
  );

  test("refuses a start value that is not an integer, so nothing but a number is inlined", () => {
    expect(() =>
      buildResetStatement([], [{ ...authorSeq, startValue: "1; DROP TABLE x" }]),
    ).toThrow("has start value 1; DROP TABLE x");
  });
});

// The statements `buildResetStatement` emitted before Baselines existed (origin/release
// at a113c12), captured from that build, one per shape of the EXECUTE. A project whose
// migrations insert no rows must get exactly these: that is what "no change in
// behaviour" means.
describe("with an empty Baseline", () => {
  const SET =
    "BEGIN\n  PERFORM pg_catalog.set_config('session_replication_role', 'replica', true);\n" +
    "  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);\n";
  const PROBE_DELETES =
    "  SELECT string_agg(t.item, ', ') INTO deletes FROM unnest(ARRAY[" +
    'pg_catalog.to_regclass(\'"public"."Author"\'), pg_catalog.to_regclass(\'"billing"."order"\')], ' +
    'ARRAY[\'d0 AS (DELETE FROM "public"."Author")\', \'d1 AS (DELETE FROM "billing"."order")\']::text[]) ' +
    `AS t(rel, item) WHERE ${PROBE};\n`;
  const SETVALS =
    'SELECT pg_catalog.setval(\'"public"."Author_id_seq"\'::regclass, 1, false), ' +
    'pg_catalog.setval(\'"billing"."order_id_seq"\'::regclass, 1000, false)';
  const sequences = [authorSeq, { schema: "billing", name: "order_id_seq", startValue: "1000" }];

  test.each([
    [
      "probed and partitioned tables",
      [author, order, { ...measurement }],
      "DO $reset$\nDECLARE deletes text;\n" +
        SET +
        PROBE_DELETES +
        "  EXECUTE 'WITH ' || coalesce(deletes || ', ', '') || $reset_sql$" +
        `d2 AS (DELETE FROM "public"."measurement") ${SETVALS}$reset_sql$;\nEND\n$reset$`,
    ],
    [
      "probed tables only",
      [author, order],
      "DO $reset$\nDECLARE deletes text;\n" +
        SET +
        PROBE_DELETES +
        `  EXECUTE coalesce('WITH ' || deletes || ' ', '') || $reset_sql$${SETVALS}$reset_sql$;\nEND\n$reset$`,
    ],
    [
      "partitioned tables only",
      [measurement],
      "DO $reset$\n" +
        SET +
        `  EXECUTE $reset_sql$WITH d0 AS (DELETE FROM "public"."measurement") ${SETVALS}$reset_sql$;\n` +
        "END\n$reset$",
    ],
    [
      "sequences only",
      [],
      "DO $reset$\n" + SET + `  EXECUTE $reset_sql$${SETVALS}$reset_sql$;\nEND\n$reset$`,
    ],
  ] as const)("is byte-identical to the statement before Baselines — %s", (_, tables, before) => {
    expect(buildResetStatement(tables, sequences)).toBe(before);
    expect(buildResetStatement(tables, sequences, [])).toBe(before);
  });
});

describe("buildResetStatement with a Baseline", () => {
  const category: BaselineTable = {
    schema: "public",
    name: "Category",
    relkind: "r",
    ordinal: 1,
    columns: ["id", "name"],
  };
  const reading: BaselineTable = {
    schema: "public",
    name: "Reading",
    relkind: "p",
    ordinal: 2,
    columns: ["id", "at", "value"],
  };
  const RESTORE_CATEGORY =
    'r1d AS (DELETE FROM "public"."Category" RETURNING 1), ' +
    'r1 AS (INSERT INTO "public"."Category" ("id", "name") OVERRIDING SYSTEM VALUE ' +
    'SELECT "id", "name" FROM "prisma_test_helper"."t1" WHERE (SELECT count(*) FROM r1d) >= 0)';
  const RESTORE_READING =
    'r2d AS (DELETE FROM "public"."Reading" RETURNING 1), ' +
    'r2 AS (INSERT INTO "public"."Reading" ("id", "at", "value") OVERRIDING SYSTEM VALUE ' +
    'SELECT "id", "at", "value" FROM "prisma_test_helper"."t2" WHERE (SELECT count(*) FROM r2d) >= 0)';

  test("restores a tracked table only when its dirty mark is set, clearing the marks", () => {
    const statement = buildResetStatement([], [], [category]);

    expect(statement).toContain("DECLARE restores text;");
    expect(statement).toContain(
      '  WITH dirty AS (DELETE FROM "prisma_test_helper"."dirty" RETURNING ordinal) ' +
        "SELECT string_agg(t.item, ', ') INTO restores FROM unnest(ARRAY[1]::int[], " +
        `ARRAY[${`'${RESTORE_CATEGORY.replaceAll("'", "''")}'`}]::text[]) AS t(ordinal, item) ` +
        "WHERE t.ordinal IN (SELECT ordinal FROM dirty);",
    );
    expect(statement).toContain(
      "  EXECUTE coalesce('WITH ' || restores || ' ', '') || $reset_sql$SELECT 1$reset_sql$;",
    );
  });

  test("never probes, nor empties outright, a Baseline table", () => {
    const statement = buildResetStatement([author], [], [category]);

    expect(statement).not.toContain('to_regclass(\'"public"."Category"\')');
    expect(statement).not.toContain('d1 AS (DELETE FROM "public"."Category")');
  });

  test("restores a partitioned Baseline table on every Reset, with no dirty mark to read", () => {
    const statement = buildResetStatement([], [], [reading]);

    expect(statement).toContain(
      `  EXECUTE $reset_sql$WITH ${RESTORE_READING} SELECT 1$reset_sql$;`,
    );
    expect(statement).not.toContain("dirty");
    expect(statement).not.toContain("DECLARE");
  });

  test("joins the probed deletes, the tracked restores and the unconditional ones in one EXECUTE", () => {
    const statement = buildResetStatement([author, measurement], [], [category, reading]);

    expect(statement).toContain("DECLARE deletes text; restores text;");
    expect(statement).toContain(
      "  EXECUTE 'WITH ' || coalesce(deletes || ', ', '') || coalesce(restores || ', ', '') || " +
        `$reset_sql$d1 AS (DELETE FROM "public"."measurement"), ${RESTORE_READING} SELECT 1$reset_sql$;`,
    );
    expect(statement.match(/EXECUTE /g)).toHaveLength(1);
  });

  test("drops the WITH clause when neither a delete nor a restore is kept", () => {
    expect(buildResetStatement([author], [], [category])).toContain(
      "  EXECUTE coalesce('WITH ' || nullif(concat_ws(', ', deletes, restores), '') || ' ', '') || " +
        "$reset_sql$SELECT 1$reset_sql$;",
    );
  });

  test("restores a Baseline-owned sequence to its snapshot position, others to their start", () => {
    const statement = buildResetStatement(
      [author],
      [
        authorSeq,
        {
          schema: "public",
          name: "Category_id_seq",
          startValue: "1",
          snapshot: { lastValue: "3", isCalled: true },
        },
      ],
      [category],
    );

    expect(statement).toContain(
      'SELECT pg_catalog.setval(\'"public"."Author_id_seq"\'::regclass, 1, false), ' +
        'pg_catalog.setval(\'"public"."Category_id_seq"\'::regclass, 3, true)$reset_sql$',
    );
  });

  test("quotes column names, doubling embedded quotes", () => {
    const statement = buildResetStatement([], [], [{ ...reading, columns: ['it "odd"'] }]);

    expect(statement).toContain('INSERT INTO "public"."Reading" ("it ""odd""")');
  });

  test("refuses a column that would close a dollar quote", () => {
    expect(() => buildResetStatement([], [], [{ ...category, columns: ["a$reset_sql$"] }])).toThrow(
      "cannot build the Reset: public.Category contains $reset_sql$",
    );
  });

  test("refuses a snapshot value or an ordinal that is not an integer", () => {
    expect(() =>
      buildResetStatement(
        [],
        [{ ...authorSeq, snapshot: { lastValue: "1; DROP TABLE x", isCalled: true } }],
      ),
    ).toThrow("has snapshot value 1; DROP TABLE x");
    expect(() => buildResetStatement([], [], [{ ...category, ordinal: 1.5 }])).toThrow(
      "has ordinal 1.5",
    );
  });
});

describe("buildVacuumProbe", () => {
  test("lists the quoted name of each ordinary table whose heap file is not empty", () => {
    const probe = buildVacuumProbe([author, measurement, order]);

    expect(probe).toContain(
      "SELECT t.item AS name FROM unnest(ARRAY[" +
        'pg_catalog.to_regclass(\'"public"."Author"\'), ' +
        'pg_catalog.to_regclass(\'"billing"."order"\')], ARRAY[' +
        '\'"public"."Author"\', \'"billing"."order"\']::text[]) ' +
        `AS t(rel, item) WHERE ${PROBE} AND `,
    );
  });

  test("shares its probe with the Reset", () => {
    expect(buildResetStatement([author], [])).toContain(PROBE);
    expect(buildVacuumProbe([author])).toContain(PROBE);
  });

  test("returns nothing while another client session of this database has a transaction open", () => {
    const probe = buildVacuumProbe([author]);

    expect(probe).toContain(
      "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a " +
        "WHERE a.datname = pg_catalog.current_database() " +
        "AND a.pid <> pg_catalog.pg_backend_pid() " +
        "AND a.backend_type = 'client backend' AND a.xact_start IS NOT NULL)",
    );
  });

  test("is undefined when no table is ever probed", () => {
    expect(buildVacuumProbe([])).toBeUndefined();
    expect(buildVacuumProbe([measurement])).toBeUndefined();
    expect(buildVacuumProbe([measurement], [])).toBeUndefined();
  });

  test("lists every Baseline table, unprobed, under the same guard", () => {
    const category = { schema: "public", name: "Category", relkind: "r" } as const;
    const reading = { schema: "public", name: "Reading", relkind: "p" } as const;

    const probe = buildVacuumProbe([author], [category, reading])!;

    expect(probe).toContain(
      `${buildVacuumProbe([author])} UNION ALL SELECT b.name FROM unnest(ARRAY[` +
        '\'"public"."Category"\', \'"public"."Reading"\']::text[]) AS b(name) WHERE NOT EXISTS (',
    );
    expect(probe.match(/pg_stat_activity/g)).toHaveLength(2);
    expect(buildVacuumProbe([], [category])).toMatch(/^SELECT b\.name FROM unnest/);
  });
});

describe("prepareReset", () => {
  /**
   * A client whose raw reads answer like Postgres would — the guard's check, discovery,
   * and the vacuum probe, which reports `dirty` — recording every raw query and write.
   */
  function stubClient(
    currentDatabase: string,
    relations: DiscoveredRelation[] = [],
    dirty: { name: string }[] = [],
  ) {
    const queries: string[] = [];
    const executed: string[] = [];
    const client: ResetClient = {
      $queryRawUnsafe: async (query: string) => {
        queries.push(query);
        if (query.includes("current_database()::text")) return [{ name: currentDatabase }];
        if (query.includes("t.item AS name")) return dirty;
        return relations;
      },
      $executeRawUnsafe: async (query: string) => {
        executed.push(query);
        return 0;
      },
    };
    return { client, queries, executed };
  }

  const discovered: DiscoveredRelation[] = [
    { kind: "table", schema: "public", name: "Author", relkind: "r", start_value: null },
    { kind: "table", schema: "public", name: "measurement", relkind: "p", start_value: null },
    { kind: "sequence", schema: "public", name: "Author_id_seq", relkind: "S", start_value: "7" },
  ];

  test("refuses a non-worker URL before sending a single query", async () => {
    const { client, queries } = stubClient("prisma_test");

    await expect(
      prepareReset(client, "postgresql://u:p@localhost:5432/prisma_test", "prisma_test"),
    ).rejects.toThrow("refusing to reset prisma_test");
    expect(queries).toEqual([]);
  });

  test("refuses a client connected elsewhere than DATABASE_URL names, before discovery", async () => {
    const { client, queries } = stubClient("myapp");

    await expect(prepareReset(client, WORKER_URL, "prisma_test")).rejects.toThrow(
      "the client passed to setupDatabase() is connected to myapp, but DATABASE_URL names prisma_test_1",
    );
    expect(queries).toHaveLength(1);
  });

  test("builds the statement from discovery once and sends it per Reset", async () => {
    const { client, queries, executed } = stubClient("prisma_test_1", discovered);

    const { reset } = await prepareReset(client, WORKER_URL, "prisma_test");
    await reset();
    await reset();

    expect(queries).toHaveLength(2);
    expect(executed).toEqual([
      buildResetStatement(
        [author, measurement],
        [{ schema: "public", name: "Author_id_seq", startValue: "7" }],
      ),
      executed[0],
    ]);
  });

  test("a failed Reset names itself and the lock it most likely hit", async () => {
    const { client } = stubClient("prisma_test_1");
    client.$executeRawUnsafe = async () => {
      throw new Error("canceling statement due to lock timeout");
    };

    const { reset } = await prepareReset(client, WORKER_URL, "prisma_test");

    await expect(reset()).rejects.toThrow(
      /^the Reset could not empty prisma_test_1: canceling statement due to lock timeout\n/,
    );
  });

  describe("with a Baseline", () => {
    const withBaseline: DiscoveredRelation[] = [
      ...discovered,
      {
        kind: "table",
        schema: "public",
        name: "Category",
        relkind: "r",
        start_value: null,
        ordinal: 1,
        columns: ["id", "name"],
      },
      {
        kind: "sequence",
        schema: "public",
        name: "Category_id_seq",
        relkind: "S",
        start_value: "1",
        last_value: "3",
        is_called: true,
      },
    ];
    const category: BaselineTable = {
      schema: "public",
      name: "Category",
      relkind: "r",
      ordinal: 1,
      columns: ["id", "name"],
    };

    test("restores the catalog's tables and empties the rest", async () => {
      const { client, executed } = stubClient("prisma_test_1", withBaseline);

      const { reset } = await prepareReset(client, WORKER_URL, "prisma_test");
      await reset();

      expect(executed).toEqual([
        buildResetStatement(
          [author, measurement],
          [
            { schema: "public", name: "Author_id_seq", startValue: "7" },
            {
              schema: "public",
              name: "Category_id_seq",
              startValue: "1",
              snapshot: { lastValue: "3", isCalled: true },
            },
          ],
          [category],
        ),
      ]);
    });

    test("never probes a Baseline table's heap, but always vacuums it", async () => {
      const { client, queries } = stubClient("prisma_test_1", withBaseline);

      const { vacuum } = await prepareReset(client, WORKER_URL, "prisma_test");
      await vacuum();

      expect(queries.at(-1)).toBe(buildVacuumProbe([author, measurement], [category]));
    });
  });

  describe("vacuum", () => {
    test("vacuums exactly the tables the probe reports, with SKIP_LOCKED", async () => {
      const { client, queries, executed } = stubClient("prisma_test_1", discovered, [
        { name: '"public"."Author"' },
        { name: '"billing"."order"' },
      ]);

      const { vacuum } = await prepareReset(client, WORKER_URL, "prisma_test");
      await vacuum();

      expect(queries.at(-1)).toBe(buildVacuumProbe([author, measurement]));
      expect(executed).toEqual(['VACUUM (SKIP_LOCKED) "public"."Author", "billing"."order"']);
    });

    test("sends no VACUUM when no table is dirty — a bare one would vacuum the database", async () => {
      const { client, queries, executed } = stubClient("prisma_test_1", discovered, []);

      const { vacuum } = await prepareReset(client, WORKER_URL, "prisma_test");
      await vacuum();

      expect(queries).toHaveLength(3);
      expect(executed).toEqual([]);
    });

    test("asks nothing when no table is ever probed", async () => {
      const { client, queries, executed } = stubClient("prisma_test_1", [discovered[1]!]);

      const { vacuum } = await prepareReset(client, WORKER_URL, "prisma_test");
      await vacuum();

      expect(queries).toHaveLength(2);
      expect(executed).toEqual([]);
    });

    test("resolves when the probe fails", async () => {
      const { client } = stubClient("prisma_test_1", discovered);
      const { vacuum } = await prepareReset(client, WORKER_URL, "prisma_test");
      client.$queryRawUnsafe = async () => {
        throw new Error("permission denied for function pg_stat_file");
      };

      await expect(vacuum()).resolves.toBeUndefined();
    });

    test("resolves when the VACUUM fails", async () => {
      const { client } = stubClient("prisma_test_1", discovered, [{ name: '"public"."Author"' }]);
      client.$executeRawUnsafe = async () => {
        throw new Error("VACUUM cannot run inside a transaction block");
      };
      const { vacuum } = await prepareReset(client, WORKER_URL, "prisma_test");

      await expect(vacuum()).resolves.toBeUndefined();
    });
  });
});
