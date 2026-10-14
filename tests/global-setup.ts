// The exact file the docs prescribe to consumers, pointed at the library source. No
// `image` or `databaseName`: the integration run proves those documented defaults
// end-to-end. The `seed` has the shape docs/api.md prescribes: it builds its own client
// from the Template Database URL and disconnects before it returns. It must not import
// `tests/db/client.ts`, which reads DATABASE_URL at import time and throws here, in the
// main process.
import { PrismaPg } from "@prisma/adapter-pg";

import { createGlobalSetup } from "../src/global-setup.js";
import { PrismaClient } from "./generated/prisma/client.js";

export default createGlobalSetup({
  seed: async (databaseUrl) => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    try {
      await db.tag.createMany({ data: [{ name: "typescript" }, { name: "postgres" }] });
    } finally {
      await db.$disconnect();
    }
  },
});
