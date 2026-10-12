# Setup

Wiring `@flefebvre/prisma-test-helper` into a Prisma + Vitest project takes five files: a
Prisma config, your Prisma client module, a Vitest global setup, a per-worker setup file,
and the Vitest config. Work the steps in order; each one lands before the next starts.

The blocks below are the wiring this repo's own test suite runs: see `prisma.config.ts`,
`tests/global-setup.ts`, `tests/setup.ts`, `tests/db/client.ts` and `vitest.config.ts` in
the [repository](https://github.com/flolefebvre/prisma-test-helper).

## Before you start

Confirm every requirement before touching a file:

- `prisma` and `@prisma/client` at **^7**, `vitest` at **^5.0.3**. On older versions,
  upgrade first; the harness does not support them.
- Node **^22.12, ^24 or >= 26**, as Vitest 5 requires (check `engines`, `.nvmrc`, or
  `node -v`).
- Committed migrations under the schema's migrations directory. The harness runs
  `prisma migrate deploy`, so a project with no migration files has nothing to apply.
- Docker reachable: `docker info`. Without it the wiring can still be written, but the
  check in [step 6](#6-prove-it-works) cannot run until Docker is started.
- A Postgres superuser. The Reset sets `session_replication_role` and reads `pg_stat_file`
  and `pg_stat_activity`, which need one. The container the harness starts connects as
  its superuser, so there is nothing to do. The harness needs this of any server it runs
  against; the why is in
  [ADR 0001](https://github.com/flolefebvre/prisma-test-helper/blob/main/docs/adr/0001-commit-and-reset-instead-of-rollback.md).

**A missing `"type": "module"` is not a blocker.** The package ships ESM only, but the
wiring runs under Vitest, which transforms modules through Vite rather than leaving them
to Node's `require`. A CommonJS project (a stock Next.js app, for instance) wires up and
passes. The project's module system only decides the import style in
[step 2](#2-your-prisma-client-module) and in your test files.

Then install the package. The npm scope is **`flefebvre`**, the GitHub org is
`flolefebvre`: the package is `@flefebvre/prisma-test-helper`, and
`@flolefebvre/prisma-test-helper` does not exist. Use the project's package manager,
detected from the lockfile in the project root (`pnpm-lock.yaml` → pnpm,
`package-lock.json` → npm, `yarn.lock` → yarn, `bun.lockb` or `bun.lock` → bun), then the
`packageManager` field, then npm:

```sh
pnpm add -D @flefebvre/prisma-test-helper
# or: npm i -D / yarn add -D / bun add -d
```

`testcontainers` and `@testcontainers/postgresql` are dependencies of this package: do
not add them to your project.

**pnpm build scripts.** Through testcontainers, the install pulls in `cpu-features`,
`ssh2` and `protobufjs`, which carry build scripts. The harness runs with all three
unbuilt, so nothing from this package needs approving. pnpm 10 skips their scripts with a
warning; pnpm 11 and later fail the install with `ERR_PNPM_IGNORED_BUILDS` until they are listed.
List them as `false` in `pnpm-workspace.yaml` (pnpm before 10.26 does not know
`allowBuilds`: put them under `ignoredBuiltDependencies` instead):

```yaml
allowBuilds:
  cpu-features: false
  protobufjs: false
  ssh2: false
```

`prisma` and `@prisma/engines` show up in the same report and do need `true`, but that
is Prisma's requirement, not this package's.

**Done when:** every requirement is confirmed, `@flefebvre/prisma-test-helper` is in
`devDependencies`, and the install exited clean.

## 1. Prisma config

Prisma 7 reads the datasource URL from `prisma.config.ts`, not from the schema, and
`prisma migrate deploy` **fails without it**. The harness runs your project's own
`migrate deploy` with `DATABASE_URL` pointed at the throwaway container, so read it from
the environment here. The placeholder keeps database-free commands (`prisma generate`)
working.

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

**A config already exists** → merge into it: keep its `schema`, `migrations` and
everything else, and add or correct only `datasource.url` so it reads
`process.env.DATABASE_URL` with a placeholder fallback. A hard-coded URL there would send
the harness's migrations at that database.

**Done when:** `prisma.config.ts` resolves `datasource.url` from
`process.env.DATABASE_URL`, and its `schema` and `migrations` paths match the project's
real layout.

## 2. Your Prisma client module

Your tests hand the harness **the same Prisma client your app uses**, so it needs to live
in one module. Find it: search for `new PrismaClient(` across the project's source,
**excluding `node_modules` and the schema's `generator client { output = … }`
directory**. The generated client documents its own constructor in doc comments, so
searching it yields matches that are all noise. Note the module path and the export name
(commonly `db` or `prisma`): every test file imports it.

- **Exactly one match** → that is the module. Use it as-is.
- **Several matches** → use the one the app's code imports.
- **No match** → create one:

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

This needs `@prisma/adapter-pg` as a dependency; install it if it is missing. The import
path follows your own `generator client { output = … }`: adjust it to wherever your
schema emits the client.

**Match the project's import style rather than copying this block's.** The `.js`-suffixed
relative specifier above suits an ESM project on `moduleResolution: "nodenext"`. A
project on `"bundler"` resolution (Next.js, most Vite apps) writes extensionless imports
and usually a path alias instead: `import { PrismaClient } from "@/generated/prisma/client"`.
Read `tsconfig.json`'s `moduleResolution` and `paths`, and follow what the project's
existing source already does.

**Build the client from `DATABASE_URL`**: that is the variable the harness points at each
worker's database. A module that reads another variable or hard-codes a URL fails every
file with `the client passed to setupDatabase() is connected to …`; change it to read
`DATABASE_URL`. Throwing when `DATABASE_URL` is unset is worth keeping in an existing
module, and worth adding to one that lacks it. It is the tripwire for the ordering rule
in [step 4](#4-per-worker-setup): if the setup file ever imports your app statically,
this throw fires loudly instead of silently pointing the suite at your dev database.

### Database-free commands

The throw fires in any process that imports the module without `DATABASE_URL`, not only
in tests. If a command that needs no database still imports it (`next build`, a script,
a code generator), that command fails with `DATABASE_URL is not set`. For those
projects, build the client on first use instead of at import, and keep `export const db`
so the rest of the app is untouched:

```ts
// src/db/client.ts: throws on first use, not at import
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client.js";

let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return client;
}

export const db = new Proxy({} as PrismaClient, {
  get(_, property) {
    const value = Reflect.get(getClient(), property);
    return typeof value === "function" ? value.bind(getClient()) : value;
  },
});
```

With this variant the import no longer throws, so the check that catches a misrouted
client is `setupDatabase(db)`'s guard, which refuses a client connected anywhere but this
worker's database. Projects without such a command keep the simpler module above.

**Done when:** the module path and export name are known, the file exists, and it builds
the client from `DATABASE_URL`.

## 3. Global setup

Use the project's existing test directory if it has one (`test/`, `tests/`, `src/test/`),
and keep that name consistent through steps 4 and 5. The examples here use `tests/`.

```ts
// tests/global-setup.ts
import { createGlobalSetup } from "@flefebvre/prisma-test-helper/global-setup";

export default createGlobalSetup();
```

**Pin the Postgres image to production's major.** Read `docker-compose.yml` (also
`compose.yaml`, `compose.yml`, `docker-compose.yaml`) and look for a Postgres service's
`image:`. Found one → pass it through, so a test never runs against a different Postgres
than the one you deploy on:

```ts
export default createGlobalSetup({ image: "postgres:16-alpine" });
```

No compose file, or no Postgres service in it → leave the call bare. It defaults to
`postgres:18-alpine`; pass `image` if production runs another major. Every option is in
the [API reference](api.md#createglobalsetupoptions).

This file must be inside `tsconfig.json`'s `include`. It carries the module augmentation
that types `inject("templateDatabaseUri")`; outside the TypeScript program, that call
will not typecheck.

**Done when:** the file exists, exports the setup as `default`, pins the image when a
compose file names one, and is inside the TypeScript program.

## 4. Per-worker setup

```ts
// tests/setup.ts
import { setupWorkerDatabase } from "@flefebvre/prisma-test-helper/setup";

setupWorkerDatabase();
```

That is the whole file. It points `DATABASE_URL` at this worker's own Worker Database
before any test file loads your app. Nothing is mocked: test files import the app's real
client and hand it to `setupDatabase(db)`.

**A setup file already exists** → add the import and the call at the top, above
everything else in it.

**This file must keep zero static imports of your app.** ES imports hoist above
statements, so a static `import { db } from "../src/db/client.js"` here would build the
client _before_ `setupWorkerDatabase()` assigns `DATABASE_URL`, pointing it at your dev
database. `setupDatabase(db)` refuses to reset a client connected anywhere but this
worker's database, so the mistake fails loudly, but it fails every file. If an existing
setup file imports app modules statically, turn them into dynamic `import()` calls below
`setupWorkerDatabase()`. Library imports are safe: they read no environment at import
time.

### TLS

The container speaks plaintext. If your app turns on TLS whenever a variable is set (an
SSL mode, a CA path), every database test fails with
`The server does not support SSL connections`. Unset the variable your app checks, below
`setupWorkerDatabase()`. For `pg`'s own `PGSSLMODE`:

```ts
setupWorkerDatabase();
delete process.env.PGSSLMODE;
```

The setup file runs in each test file's own process, so this touches nothing outside the
test run.

**Done when:** the file calls `setupWorkerDatabase()` first, the only static imports in
it are library ones, and it unsets any variable that turns on TLS.

## 5. Vitest config

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

**A config already exists** → merge, preserving every existing key. Add the four
settings above, appending to `globalSetup` and `setupFiles` if they already hold entries.
`tests/setup.ts` must come first in `setupFiles`, so `DATABASE_URL` is set before any
other setup file loads your app.

`pool: "forks"` and `isolate: true` are load-bearing. Under `isolate: false` module state
leaks across files, and the `setupDatabase(db)` opt-in guard relies on its module
re-instantiating per file. If an existing config sets `pool: "threads"` or
`isolate: false`, correct them.

### Projects

If you split your config into `projects`, put these four settings on the project that
runs database tests, not at the root: inline projects inherit the root's `setupFiles`, so
every project would load `tests/setup.ts`. Any `sequence.groupOrder` layout works with
the harness.

### Path aliases

If `tsconfig.json` has `compilerOptions.paths`, turn on alias resolution, or every aliased
import in your tests fails to resolve with `Cannot find package '@/lib/db'`:

```ts
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {/* … */},
});
```

Vite resolves `paths` natively; reach for the `vite-tsconfig-paths` plugin only on a Vite
version too old to support the option.

### `server-only`

If your client module imports `server-only` (common in Next.js), alias it to the empty
build that package ships for non-render environments, or importing the module in a test
fails with the misleading `This module cannot be imported from a Client Component module`:

```ts
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {/* … */},
});
```

The file path is deliberate: `server-only` exposes only `.` in its `exports` map, so the
subpath specifier `server-only/empty.js` does not resolve.

**Done when:** a single Vitest config carries all four settings alongside its original
contents, its paths match the files from steps 3 and 4, and aliased imports resolve.

## 6. Prove it works

Write a smoke test against a real model from your schema, importing the client from the
module path and export name found in [step 2](#2-your-prisma-client-module). Two tests,
in this order, so the second proves the Reset emptied the database after the first:

```ts
// tests/smoke.test.ts
import { expect, test } from "vitest";

import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

setupDatabase(db);

test("commits a write", async () => {
  await db.author.create({ data: { name: "Ada" } });
  expect(await db.author.count()).toBe(1);
});

test("sees an empty database afterwards", async () => {
  expect(await db.author.count()).toBe(0);
});
```

Run the suite. Both tests must pass, and running it a **second time** must pass
identically: a leaked row would break the second test on the repeat run.

A failure names its own cause: find the error in [Troubleshooting](troubleshooting.md),
fix the step it points at, and run again.

**Done when:** the full suite passes twice in a row, and the empty-database test is
genuinely running, not skipped. Keep `tests/smoke.test.ts` as a regression check on the
wiring, or delete it.

From here, every test file that touches the database follows
[Writing tests](writing-tests.md).
