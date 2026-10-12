import { PrismaPg } from "@prisma/adapter-pg";
import { beforeAll, expect, test } from "vitest";

import { setupDatabase } from "../../src/index.js";
import { prepareReset, type PreparedReset } from "../../src/reset.js";
import { db } from "../db/client.js";
import { PrismaClient } from "../generated/prisma/client.js";

// The storage probe and the VACUUM between files, against real heaps. The Reset deletes
// only from tables whose heap file is not 0 bytes; a DELETE leaves the file as it was,
// and only a VACUUM truncates it back to 0. Each test drives `prepareReset` itself, so it
// can look at the heaps between the Reset and the VACUUM that `setupDatabase` would run
// only after the file.

setupDatabase(db);

const url = () => process.env.DATABASE_URL!;

/** A second client, on connections of its own: fresh backends the app's client never used. */
const freshClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url() }) });

let prepared: PreparedReset;

beforeAll(async () => {
  prepared = await prepareReset(db, url(), "prisma_test");
});

/** The heap size, in bytes, of each fixture table. */
async function heaps() {
  const [sizes] = await db.$queryRawUnsafe<{ author: number; post: number }[]>(
    `SELECT pg_relation_size('"Author"')::int AS author, pg_relation_size('"Post"')::int AS post`,
  );
  return sizes!;
}

test("a Reset from a fresh backend still empties a table written earlier", async () => {
  // Arrange: rows committed through the app's client.
  await db.author.create({ data: { name: "written", posts: { create: [{ title: "t" }] } } });
  const fresh = freshClient();

  try {
    // Act: the Reset, probing from a backend that has opened neither table.
    const { reset } = await prepareReset(fresh, url(), "prisma_test");
    await reset();
  } finally {
    await fresh.$disconnect();
  }

  // Assert
  expect(await db.author.count()).toBe(0);
  expect(await db.post.count()).toBe(0);
});

test("the VACUUM returns the heaps a file wrote to 0 bytes", async () => {
  // Arrange: rows written and deleted — the heap files keep their pages.
  await db.author.create({ data: { name: "written", posts: { create: [{ title: "t" }] } } });
  await prepared.reset();
  const before = await heaps();
  expect(before.author).toBeGreaterThan(0);
  expect(before.post).toBeGreaterThan(0);

  // Act: through the client's raw execute, which runs it outside a transaction block.
  await prepared.vacuum();

  // Assert
  expect(await heaps()).toEqual({ author: 0, post: 0 });
});

test("the VACUUM stands down while another session has a transaction open", async () => {
  // Arrange: dirty heaps, and a second client holding a transaction open on them — the
  // shape of a connection a test leaked. VACUUM's truncation would wait on its lock.
  await db.author.create({ data: { name: "written", posts: { create: [{ title: "t" }] } } });
  await prepared.reset();
  const other = freshClient();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let opened!: () => void;
  const open = new Promise<void>((resolve) => (opened = resolve));
  const transaction = other.$transaction(async (tx) => {
    await tx.author.count();
    opened();
    await held;
  });

  try {
    await open;

    // Act
    const started = performance.now();
    await prepared.vacuum();
    const elapsed = performance.now() - started;

    // Assert: nothing was vacuumed — not even `Post`, which the transaction never
    // touched — and nothing waited out the truncation's ~5 s retry on `Author`.
    const after = await heaps();
    expect(after.author).toBeGreaterThan(0);
    expect(after.post).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  } finally {
    release();
    await transaction;
    await other.$disconnect();
  }
});
