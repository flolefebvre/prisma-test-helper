---
name: prisma-test-helper-setup
description: Wire the @flefebvre/prisma-test-helper test harness into a Prisma + Vitest project — install the package and scaffold its five wiring files. Use when the user wants an isolated, rolled-back Postgres database for their tests, asks to install or set up prisma-test-helper, or wants to replace database truncation and cleanup code in their test suite with per-test transactions.
---

# prisma-test-helper-setup

Wire `@flefebvre/prisma-test-helper` into this project: one throwaway Postgres container per run, migrations applied once to a **Template Database**, one **Worker Database** cloned per Vitest worker slot, every test in a **Test Transaction** that is rolled back.

This skill is the one-time installer. Once the smoke test passes, remove it and keep `prisma-test-helper` — the day-to-day usage skill — installed.

> The npm scope is **`flefebvre`**, the GitHub org is `flolefebvre`. The package is `@flefebvre/prisma-test-helper`. `@flolefebvre/prisma-test-helper` does not exist.

Work the steps in order. Each one lands before the next starts.

## 1. Preflight

Read `package.json` and confirm every requirement, reporting any that fail before touching a file:

- `"type": "module"` — the harness is ESM-only.
- `prisma` and `@prisma/client` at **^7**, `vitest` at **^4**. On older majors, stop and tell the user which to upgrade; do not attempt the wiring.
- Node >= 20 (`engines`, `.nvmrc`, or `node -v`).
- Committed migrations under the schema's migrations directory — `prisma migrate deploy` is what the harness runs, so a project with no migration files has nothing to apply.
- Docker reachable: `docker info`. If it is not, the wiring can still be scaffolded, but say plainly that step 8's verification cannot run until Docker is started.

**Done when:** every requirement is confirmed, or the blocking ones are reported and the run has stopped.

## 2. Install the package

Detect the package manager from the lockfile in the project root — `pnpm-lock.yaml` → pnpm, `package-lock.json` → npm, `yarn.lock` → yarn, `bun.lockb`/`bun.lock` → bun — and fall back to the `packageManager` field, then npm.

```sh
pnpm add -D @flefebvre/prisma-test-helper   # npm i -D / yarn add -D / bun add -d
```

**Done when:** `@flefebvre/prisma-test-helper` is in `devDependencies` and the install exited clean.

## 3. Locate the Prisma client module

The harness assumes the app reaches the database through **one module it can intercept**. Find it: search for `new PrismaClient(` across the project's source. Record two things — the **module path** and the **export name** (commonly `db` or `prisma`) — and note whether the module exports anything besides the client; step 6 depends on it.

- **Exactly one match** → that is the module. Use it as-is; do not rewrite it.
- **Several matches** → ask the user which one the app's code imports, rather than guessing.
- **No match** → the project has no client module. Create one at `src/db/client.ts`, adjusting the generated-client import to match the schema's `generator client { output = … }`:

  ```ts
  // src/db/client.ts
  import { PrismaPg } from "@prisma/adapter-pg";

  import { PrismaClient } from "../generated/prisma/client.js";

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ```

  This needs `@prisma/adapter-pg` as a dependency — install it if it is missing.

Throwing when `DATABASE_URL` is unset is worth keeping in an existing module too, and worth adding if the user agrees. It is the tripwire for step 6's ordering rule: if the setup file ever imports the app statically, this throw fires loudly instead of silently pointing the suite at the dev database.

**Done when:** the module path and export name are known, and the file exists.

## 4. `prisma.config.ts`

Prisma 7 reads the datasource URL here, not from the schema, and `prisma migrate deploy` **fails without it** — this is the first wall a mis-wired project hits. The harness runs the project's own `migrate deploy` with `DATABASE_URL` pointed at the throwaway container, so read it from the environment. The placeholder keeps database-free commands (`prisma generate`) working.

```ts
// prisma.config.ts
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://unset:unset@localhost:5432/unset",
  },
});
```

**A config already exists** → merge into it: keep its `schema`, `migrations`, and everything else, and add or correct only `datasource.url` so it reads `process.env.DATABASE_URL` with a placeholder fallback. A hardcoded URL there would send the harness's migrations at that database.

**Done when:** `prisma.config.ts` resolves `datasource.url` from `process.env.DATABASE_URL`, and its `schema`/`migrations` paths match the project's real layout.

## 5. `tests/global-setup.ts`

Use the project's existing test directory if it has one (`test/`, `tests/`, `src/test/`) and keep that name consistent through steps 6 and 7.

```ts
// tests/global-setup.ts
import { createGlobalSetup } from "@flefebvre/prisma-test-helper/global-setup";

export default createGlobalSetup();
```

**Pin the Postgres image to production's major.** Read `docker-compose.yml` (also `compose.yml`, `docker-compose.yaml`) and look for a Postgres service's `image:`. Found one → pass it through, so tests never run against a different Postgres than the project deploys on:

```ts
export default createGlobalSetup({ image: "postgres:16-alpine" });
```

No compose file, or no Postgres service in it → leave the call bare and tell the user it defaults to `postgres:17-alpine`, and that they should pass `image` if production runs another major.

This file must be inside `tsconfig.json`'s `include`. It carries the module augmentation that types `inject("templateDatabaseUri")`; outside the TS program, that call will not typecheck.

**Done when:** the file exists, exports the setup as `default`, pins the image when a compose file named one, and is inside the TS program.

## 6. `tests/setup.ts` — the Client Seam

Fill in the module path and export name from step 3.

```ts
// tests/setup.ts
import { vi } from "vitest";

import { installTestTransaction } from "@flefebvre/prisma-test-helper";
import { setupWorkerDatabase } from "@flefebvre/prisma-test-helper/setup";

const { databaseUrl, databaseName } = setupWorkerDatabase();

vi.mock("../src/db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client.js")>();
  return { db: installTestTransaction(actual.db, databaseUrl, databaseName) };
});
```

The mock path must match the specifier the app's own code imports, and the returned key must be the real export name.

**The client module exports more than the client** — types, a re-exported `Prisma` namespace, helpers — → spread the original, or those exports become `undefined` at every call site:

```ts
return { ...actual, db: installTestTransaction(actual.db, databaseUrl, databaseName) };
```

**Keep this file's imports of the app at zero.** ES imports hoist above statements, so a static `import { db } from "../src/db/client.js"` here would build the client _before_ `setupWorkerDatabase()` assigns `DATABASE_URL` — pointing the whole suite at the dev database. App modules are reached lazily, through the `vi.mock` factory above or a dynamic `import()`. Library imports are safe: they read no environment at import time.

**Done when:** the file exists, the mock path and export name match the real client module, extra exports are spread when the module has them, and the only static imports in the file are from `vitest` and `@flefebvre/prisma-test-helper`.

## 7. `vitest.config.ts`

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    // Both are Vitest defaults, set explicitly because the harness depends on them:
    // together they re-run `setupFiles` in a fresh process per test file.
    pool: "forks",
    isolate: true,
  },
});
```

**A config already exists** → merge, preserving every existing key. Add the four settings above, appending to `globalSetup` and `setupFiles` if they already hold entries. Where the existing config uses `projects`, put the four settings on the project that runs the database tests, not at the root.

`pool: "forks"` and `isolate: true` are load-bearing. If the existing config sets `pool: "threads"` or `isolate: false`, correct them and tell the user why: under `isolate: false` module state leaks across files, and the `setupDatabase()` opt-in guard relies on its module re-instantiating per file.

**Done when:** a single Vitest config carries all four settings alongside its original contents, and the paths match the files from steps 5 and 6.

## 8. Prove it works

Write a smoke test against a real model from the project's schema — two tests, in this order, so the second proves the first was rolled back:

```ts
// tests/smoke.test.ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase();

test("writes inside a test transaction", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});

test("sees a pristine database afterwards", async () => {
  expect(await db.author.count()).toBe(0);
});
```

Run the suite. Both tests must pass, and running it a **second time** must pass identically — a leaked row would break the second test on the repeat run.

A failure names its own cause: match the error against the table in the `prisma-test-helper` usage skill (or the README's "When something is mis-wired"), fix the wiring step it points at, and run again.

**Done when:** the full suite passes twice in a row, and the pristine-database test is genuinely running (not skipped).

## 9. Hand over

Report what was created or merged, and the Postgres image in use. Then:

- **Ask whether to delete `tests/smoke.test.ts`** or keep it as a regression check on the wiring. Do not delete it without an answer.
- Point the user at the `prisma-test-helper` usage skill for writing tests from here, and say this installer skill can be removed now.
- Name the one rule that outlives the install: `setupDatabase()` at the top of every database-touching test file, once.
