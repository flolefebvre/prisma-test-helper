import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client.js";

// The fixture stand-in for a consumer app's own client module (`src/db/client.ts`) — the
// module their Client Seam mocks. It is deliberately shaped like a real one: it builds
// its adapter from `process.env.DATABASE_URL` *at import time*, which is what makes the
// setup file's ordering discipline load-bearing rather than decorative. If
// `tests/setup.ts` ever grew a static import of this module, the import would hoist above
// `setupWorkerDatabase()` and the throw below would fire — the mistake fails loudly here
// instead of silently pointing a suite at a dev database.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set — this module was imported before setupWorkerDatabase() ran",
  );
}

export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
