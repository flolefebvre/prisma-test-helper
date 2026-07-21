# @flolefebvre/prisma-test-helper

An isolated, fast Postgres test database for Prisma + Vitest projects: one throwaway
container per test run, migrations applied once to a Template Database, one Worker
Database cloned per Vitest worker.

**Postgres-only.** The harness starts a real Postgres in Docker and relies on
`CREATE DATABASE … TEMPLATE` for cloning; no other database is supported.

> Early days: all three entry points ship today — `global-setup`, `setup`
> (`setupWorkerDatabase`), and the main entry (`installTestTransaction`, `setupDatabase`,
> `registerResetHook`, `isDatabaseSetUp`) — and this repo's own test suite runs on them.
> The copy-paste recipes below still cover only `global-setup`; the rest arrive with the
> 0.1.0 docs pass. Until then, `tests/setup.ts` and `vitest.config.ts` in this repo are
> the working reference.

## Requirements

- Node >= 20, ESM project
- Docker (or another container runtime Testcontainers can reach)
- Peer dependencies: `vitest` ^4 and `prisma` ^7, with your migrations committed
  (`prisma migrate deploy` is what the harness runs)

## Install

```sh
pnpm add -D @flolefebvre/prisma-test-helper
# or: npm i -D / yarn add -D / bun add -d
```

## Usage

Create a global-setup file:

```ts
// test/global-setup.ts
import { createGlobalSetup } from "@flolefebvre/prisma-test-helper/global-setup";

export default createGlobalSetup({
  image: "postgres:17-alpine", // default — pin to your production major
  databaseName: "prisma_test", // default — the Template Database name
});
```

Register it in your Vitest config:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/global-setup.ts"],
  },
});
```

Per run, this starts one tuned throwaway Postgres container (tmpfs data directory,
`fsync=off`), runs your project's `prisma migrate deploy` against the Template Database,
clones one Worker Database per Vitest worker slot (`<databaseName>_1..N`), and removes
the container when the run ends.

The Template Database connection URI is `provide`d to your tests, fully typed:

```ts
import { inject } from "vitest";

const uri = inject("templateDatabaseUri");
```

## License

MIT
