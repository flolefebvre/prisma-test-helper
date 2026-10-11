import { beforeAll, describe, expect, test } from "vitest";

import { setupDatabase } from "../../src/index.js";
import { db } from "../db/client.js";

// The Reset as a consumer relies on it: real commits inside a test, an empty Worker
// Database and rewound sequences at the start of the next. Tests in this file run in
// order and lean on it — each "after" test reads what the one before it left.

setupDatabase(db);

describe("rows and sequences", () => {
  test("ids start at 1 in a file's first test", async () => {
    const author = await db.author.create({ data: { name: "first" } });
    await db.author.create({ data: { name: "second" } });

    expect(author.id).toBe(1);
  });

  test("after a test, rows are gone and ids start at 1 again", async () => {
    expect(await db.author.count()).toBe(0);

    const author = await db.author.create({
      data: { name: "again", posts: { create: [{ title: "t" }] } },
      include: { posts: true },
    });

    expect(author.id).toBe(1);
    expect(author.posts[0]?.id).toBe(1);
  });

  test("a failed insert advances its sequence without leaving a row", async () => {
    // The orphan post violates `Post.authorId`'s foreign key: nextval ran, no row exists.
    await expect(db.post.create({ data: { title: "orphan", authorId: 424242 } })).rejects.toThrow();
    expect(await db.post.count()).toBe(0);
  });

  test("…and the sequence is rewound all the same", async () => {
    const author = await db.author.create({ data: { name: "a" } });
    const post = await db.post.create({ data: { title: "p", authorId: author.id } });

    expect(post.id).toBe(1);
  });
});

describe("beforeAll fixtures", () => {
  // Registered after `setupDatabase(db)`, so it runs after the file's opening Reset and
  // its rows commit — but the first test's Reset clears them like any other.
  beforeAll(async () => {
    await db.author.create({ data: { name: "fixture" } });
  });

  test("are visible to the first test after them", async () => {
    expect(await db.author.count({ where: { name: "fixture" } })).toBe(1);
  });

  test("are gone after that test's Reset", async () => {
    expect(await db.author.count()).toBe(0);
  });
});

describe("$transaction runs natively", () => {
  test("an interactive transaction commits", async () => {
    await db.$transaction(async (tx) => {
      await tx.author.create({ data: { name: "tx" } });
    });

    expect(await db.author.count({ where: { name: "tx" } })).toBe(1);
  });

  test("a throwing interactive transaction rolls back its own writes only", async () => {
    await db.author.create({ data: { name: "outside" } });

    await expect(
      db.$transaction(async (tx) => {
        await tx.author.create({ data: { name: "inside" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await db.author.count({ where: { name: "inside" } })).toBe(0);
    expect(await db.author.count({ where: { name: "outside" } })).toBe(1);
  });

  test("a transaction opened inside another commits on its own connection", async () => {
    await db.$transaction(async (outer) => {
      await outer.author.create({ data: { name: "outer" } });
      await db.$transaction(async (inner) => {
        await inner.author.create({ data: { name: "inner" } });
      });
    });

    expect(await db.author.count({ where: { name: { in: ["outer", "inner"] } } })).toBe(2);
  });

  test("a batch is atomic", async () => {
    const [a, b] = await db.$transaction([
      db.author.create({ data: { name: "batch-a" } }),
      db.author.create({ data: { name: "batch-b" } }),
    ]);
    expect([a.name, b.name]).toEqual(["batch-a", "batch-b"]);

    await expect(
      db.$transaction([
        db.author.create({ data: { name: "batch-undone" } }),
        db.post.create({ data: { title: "orphan", authorId: 424242 } }),
      ]),
    ).rejects.toThrow();
    expect(await db.author.count({ where: { name: "batch-undone" } })).toBe(0);
  });

  test("concurrent transactions all land", async () => {
    await Promise.all(
      ["c1", "c2", "c3", "c4"].map((name) =>
        db.$transaction(async (tx) => {
          await tx.author.create({ data: { name } });
        }),
      ),
    );

    expect(await db.author.count()).toBe(4);
  });

  test("none of it outlives its test", async () => {
    expect(await db.author.count()).toBe(0);
    expect(await db.post.count()).toBe(0);
  });
});
