import { PrismaPg } from "@prisma/adapter-pg";
import { inject, onTestFinished } from "vitest";

import { PrismaClient } from "../generated/prisma/client.js";

/**
 * A client on this run's Template Database, disconnected when the calling test finishes.
 * Read-only use: the template never hosts a test's writes.
 */
export function templateClient(): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: inject("templateDatabaseUri") }),
  });
  onTestFinished(() => client.$disconnect());
  return client;
}
