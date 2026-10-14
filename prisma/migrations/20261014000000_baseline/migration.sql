-- The fixture's Baseline: rows this migration inserts, which every test starts from.

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "categoryId" INTEGER;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Lookup rows
INSERT INTO "Category" ("name") VALUES ('news'), ('science'), ('sports');

-- A partitioned Baseline table, outside the Prisma schema: an always-generated identity,
-- a stored generated column and a dropped column, so the restore's column list has
-- something to leave out and a value it must override.
CREATE TABLE "Reading" (
    "id" INTEGER GENERATED ALWAYS AS IDENTITY,
    "at" DATE NOT NULL,
    "retired" INTEGER,
    "value" INTEGER NOT NULL,
    "doubled" INTEGER GENERATED ALWAYS AS ("value" * 2) STORED
) PARTITION BY RANGE ("at");
CREATE TABLE "Reading_2025" PARTITION OF "Reading" FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE "Reading_2026" PARTITION OF "Reading" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
ALTER TABLE "Reading" DROP COLUMN "retired";

INSERT INTO "Reading" ("at", "value") VALUES ('2025-06-01', 1), ('2026-06-01', 2);
