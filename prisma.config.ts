import { defineConfig } from "prisma/config";

// Prisma 7 reads the datasource URL from this config, not the schema. The harness's
// `migrate deploy` child process receives DATABASE_URL pointing at the container; the
// placeholder keeps database-free commands (`prisma generate`) loading this config.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://unset:unset@localhost:5432/unset",
  },
});
