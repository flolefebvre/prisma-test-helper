// The fixture's `seed`, shared by both integration projects' global-setup files: the shape
// docs/api.md prescribes. It builds its own client from the Template Database URL and
// disconnects before it returns. It must not import `tests/db/client.ts`, which reads
// DATABASE_URL at import time and throws here, in the main process.
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export async function seed(databaseUrl: string): Promise<void> {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    await db.tag.createMany({ data: [{ name: "typescript" }, { name: "postgres" }] });
  } finally {
    await db.$disconnect();
  }
}
