import { describe, expect, test } from "vitest";

import { setupDatabase } from "../../src/index.js";
import { DISCOVERY_QUERY, prepareReset, type DiscoveredRelation } from "../../src/reset.js";
import { db } from "../db/client.js";

// The Baseline as a consumer relies on it: the rows the fixture's second migration
// inserts — three `Category` rows and two `Reading` rows, the latter a partitioned table
// Prisma does not model — are there at the start of every test, whatever the test
// before did to them. Tests in this file run in order and lean on it: each "after" test
// reads what the one before it left.

setupDatabase(db);

const CATEGORIES = [
  { id: 1, name: "news" },
  { id: 2, name: "science" },
  { id: 3, name: "sports" },
];
const READINGS = [
  { id: 1, at: "2025-06-01", value: 1, doubled: 2 },
  { id: 2, at: "2026-06-01", value: 2, doubled: 4 },
];

const categories = () => db.category.findMany({ orderBy: { id: "asc" } });
const readings = () =>
  db.$queryRawUnsafe<{ id: number; at: string; value: number; doubled: number }[]>(
    `SELECT id, at::text AS at, value, doubled FROM "Reading" ORDER BY id`,
  );
const dirtyMarks = async () => {
  const [row] = await db.$queryRawUnsafe<{ count: number }[]>(
    "SELECT count(*)::int AS count FROM prisma_test_helper.dirty",
  );
  return row!.count;
};

describe("rows a migration inserted", () => {
  test("are there in a file's first test", async () => {
    expect(await categories()).toEqual(CATEGORIES);
    expect(await readings()).toEqual(READINGS);
  });

  test("an insert gets the id after the snapshot, not the start value", async () => {
    const category = await db.category.create({ data: { name: "travel" } });

    expect(category.id).toBe(4);
  });

  test("…and the next test sees only the Baseline, and gets that same id again", async () => {
    expect(await categories()).toEqual(CATEGORIES);

    const category = await db.category.create({ data: { name: "food" } });
    expect(category.id).toBe(4);
  });

  test("an update", async () => {
    await db.category.update({ where: { id: 1 }, data: { name: "breaking news" } });
  });

  test("…is undone", async () => {
    expect(await categories()).toEqual(CATEGORIES);
  });

  test("a delete of every row", async () => {
    await db.category.deleteMany();
    expect(await db.category.count()).toBe(0);
  });

  test("…is undone", async () => {
    expect(await categories()).toEqual(CATEGORIES);
  });

  test("a TRUNCATE", async () => {
    await db.$executeRawUnsafe('TRUNCATE "Category" CASCADE');
  });

  test("…is undone", async () => {
    expect(await categories()).toEqual(CATEGORIES);
  });
});

describe("a Baseline table no test writes", () => {
  const versions = () =>
    db.$queryRawUnsafe<{ id: number; xmin: string }[]>(
      'SELECT id, xmin::text AS xmin FROM "Category" ORDER BY id',
    );
  let before: { id: number; xmin: string }[];

  test("is read", async () => {
    before = await versions();
    expect(before).toHaveLength(3);
  });

  test("…and is not rewritten by the Reset: its rows are the very same row versions", async () => {
    // A restore would have inserted new row versions, with a newer xmin.
    expect(await versions()).toEqual(before);
    expect(await dirtyMarks()).toBe(0);
  });
});

describe("a partitioned Baseline table", () => {
  test("a write aimed straight at its partitions", async () => {
    await db.$executeRawUnsafe(`DELETE FROM "Reading_2025"`);
    await db.$executeRawUnsafe(`UPDATE "Reading_2026" SET value = 20`);
    await db.$executeRawUnsafe(`INSERT INTO "Reading_2026" (at, value) VALUES ('2026-09-01', 3)`);

    expect(await readings()).toEqual([
      { id: 2, at: "2026-06-01", value: 20, doubled: 40 },
      { id: 3, at: "2026-09-01", value: 3, doubled: 6 },
    ]);
  });

  test("…is undone, generated column and identity included", async () => {
    expect(await readings()).toEqual(READINGS);

    const [inserted] = await db.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO "Reading" (at, value) VALUES ('2026-10-01', 5) RETURNING id`,
    );
    expect(inserted!.id).toBe(3);
  });
});

describe("tables that were empty after migrate", () => {
  test("a post filed under a Baseline category", async () => {
    const author = await db.author.create({ data: { name: "Ada" } });
    const post = await db.post.create({
      data: { title: "t", authorId: author.id, categoryId: 2 },
    });

    expect([author.id, post.id]).toEqual([1, 1]);
  });

  test("…are emptied, and their ids rewound to the start value", async () => {
    expect(await db.author.count()).toBe(0);
    expect(await db.post.count()).toBe(0);
    expect(await categories()).toEqual(CATEGORIES);

    const author = await db.author.create({ data: { name: "Grace" } });
    expect(author.id).toBe(1);
  });
});

describe("dirty marks", () => {
  test("a write that rolls back leaves no mark, and nothing to restore", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.category.update({ where: { id: 1 }, data: { name: "rolled back" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await dirtyMarks()).toBe(0);
    expect(await categories()).toEqual(CATEGORIES);
  });

  test("a committed write leaves one", async () => {
    await db.category.update({ where: { id: 1 }, data: { name: "marked" } });
    await db.category.update({ where: { id: 2 }, data: { name: "marked twice" } });

    expect(await dirtyMarks()).toBeGreaterThan(0);
  });

  test("…which the Reset clears with the restore", async () => {
    expect(await dirtyMarks()).toBe(0);
    expect(await categories()).toEqual(CATEGORIES);
  });
});

describe("a role with no privilege on the harness schema", () => {
  // Roles are cluster-wide and the container outlives a watch-mode rerun, so it is
  // created only when missing.
  const ROLE = "baseline_writer";

  test("writes a Baseline table", async () => {
    await db.$executeRawUnsafe(
      `DO $$ BEGIN CREATE ROLE ${ROLE}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    );
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "Category" TO ${ROLE}`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SEQUENCE "Category_id_seq" TO ${ROLE}`);
    const [privilege] = await db.$queryRawUnsafe<{ usage: boolean }[]>(
      `SELECT has_schema_privilege('${ROLE}', 'prisma_test_helper', 'USAGE') AS usage`,
    );
    expect(privilege!.usage).toBe(false);

    // The trigger function runs as its definer, so the restricted role's write still
    // marks the table.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${ROLE}`);
      await tx.$executeRawUnsafe(`INSERT INTO "Category" (name) VALUES ('restricted')`);
      await tx.$executeRawUnsafe(`DELETE FROM "Category" WHERE id = 3`);
    });
    expect(await db.category.count()).toBe(3);
    expect(await dirtyMarks()).toBeGreaterThan(0);
  });

  test("…and the next test sees the Baseline restored", async () => {
    expect(await categories()).toEqual(CATEGORIES);
  });
});

describe("the VACUUM between files", () => {
  test("vacuums every Baseline table, the restored ones' dead rows with them", async () => {
    // VACUUM reports to the shared statistics as it finishes; earlier files on this
    // Worker Database may have vacuumed too, so the count is compared, not read.
    const counts = async () =>
      Object.fromEntries(
        (
          await db.$queryRawUnsafe<{ relname: string; n: number }[]>(
            `SELECT relname::text, vacuum_count::int AS n FROM pg_stat_user_tables
             WHERE schemaname = 'public' AND relname IN ('Category', 'Reading_2025', 'Reading_2026')`,
          )
        ).map(({ relname, n }) => [relname, n]),
      );
    // Arrange: a restore, which leaves the old rows of `Category` dead.
    await db.category.update({ where: { id: 1 }, data: { name: "rewritten" } });
    const prepared = await prepareReset(db, process.env.DATABASE_URL!, "prisma_test");
    await prepared.reset();
    const before = await counts();

    // Act
    await prepared.vacuum();

    // Assert
    const after = await counts();
    for (const table of ["Category", "Reading_2025", "Reading_2026"]) {
      expect(after[table], table).toBe((before[table] ?? 0) + 1);
    }
  });
});

describe("the harness schema", () => {
  test("never appears among the discovered relations", async () => {
    const relations = await db.$queryRawUnsafe<DiscoveredRelation[]>(DISCOVERY_QUERY);

    expect(relations.map((relation) => relation.schema)).not.toContain("prisma_test_helper");
    expect(
      relations
        .filter((relation) => relation.ordinal !== null)
        .map((relation) => [relation.name, relation.ordinal, relation.columns]),
    ).toEqual([
      ["Category", 1, ["id", "name"]],
      ["Reading", 2, ["id", "at", "value"]],
      ["Tag", 3, ["id", "name"]],
    ]);
  });

  test("is never emptied by the Reset", async () => {
    const [counts] = await db.$queryRawUnsafe<Record<string, number>[]>(
      `SELECT (SELECT count(*)::int FROM prisma_test_helper.baseline) AS catalog,
              (SELECT count(*)::int FROM prisma_test_helper.sequence) AS sequences,
              (SELECT count(*)::int FROM prisma_test_helper.t1) AS category,
              (SELECT count(*)::int FROM prisma_test_helper.t2) AS reading,
              (SELECT count(*)::int FROM prisma_test_helper.t3) AS tag`,
    );

    expect(counts).toEqual({ catalog: 3, sequences: 3, category: 3, reading: 2, tag: 2 });
  });
});
