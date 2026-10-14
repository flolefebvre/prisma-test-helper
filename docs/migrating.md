# Migrating

Version-to-version upgrade notes. Only read the section for the jump you are making.

## 0.3.0 → 1.0.0

1.0 replaces the per-test rollback transaction with commit-and-reset: tests commit to
their Worker Database for real, through your app's own Prisma client, and the **Reset**
empties every table and rewinds every sequence before a file's first test and after
every test, keeping the rows your migrations insert. Why:
[ADR 0001](https://github.com/flolefebvre/prisma-test-helper/blob/main/docs/adr/0001-commit-and-reset-instead-of-rollback.md).

Your setup file and every database test file change. `vitest.config.ts` and
`tests/global-setup.ts` do not.

### Requirements

- **Vitest ^5.0.3** (was ^4.0.0). Upgrade Vitest first.
- **Node ^22.12, ^24 or >= 26** (was >= 20), as Vitest 5 requires.
- **The default image is `postgres:18-alpine`** (was `postgres:17-alpine`). If you rely on
  the default, your tests move from Postgres 17 to 18. To stay on 17, pin it:
  `createGlobalSetup({ image: "postgres:17-alpine" })`. If you already pass `image`,
  nothing changes.

### The setup file loses its `vi.mock`

There is no module mock any more: test files import your real client. In
`tests/setup.ts`, delete the `vi.mock(...)` block that calls `installTestTransaction`, and
the `installTestTransaction` import. Keep the `setupWorkerDatabase()` call; its return
value is no longer needed. Delete the `vi` import too, unless something else in the file
still uses it. The harness's part of the file is now:

```ts
// tests/setup.ts: no static imports of your app here
import { setupWorkerDatabase } from "@flefebvre/prisma-test-helper/setup";

setupWorkerDatabase();
```

Leave everything else in the file where it is, below `setupWorkerDatabase()`. The
ordering rule is unchanged: the setup file keeps zero static imports of your app.

### Removed exports

These no longer exist. Delete every import of them:

- `installTestTransaction`, and the types `MinimalClient` and `MinimalTransactionClient`,
  from `@flefebvre/prisma-test-helper`;
- `workerCount` and `cloneCommand` from `@flefebvre/prisma-test-helper/global-setup`;
- `workerDatabaseUrl` from `@flefebvre/prisma-test-helper/setup`.

The last three were undocumented test helpers. The full 1.0 surface is in [API](api.md).

### `setupDatabase()` becomes `setupDatabase(db)`

Every opted-in file passes the Prisma client your app uses: the Reset runs through it.

```ts
setupDatabase(); // 0.3
setupDatabase(db); // 1.0
```

To migrate, replace every call, then let `tsc` find the files that lack a `db` in scope:

```sh
grep -rl --include='*.ts' 'setupDatabase()' tests src \
  | xargs perl -pi -e 's/\bsetupDatabase\(\)/setupDatabase(db)/g'
pnpm exec tsc --noEmit
```

Adjust the directories to wherever your tests live, and `db` to your client's export
name. The replacement also rewrites `setupDatabase()` in comments and strings: review the
diff, and restore any string that quotes one of this package's error messages.

- **Files that need a new `db` import** are the ones that called `setupDatabase()` but
  never queried the client themselves: they went through factories, services or route
  handlers only. `tsc` reports them as `Cannot find name 'db'`. Import the client the
  way the rest of the project does (`import { db } from "../src/db/client.js"`, or
  `import { db } from "@/lib/db"`).
- **A file that mocks the client module entirely** (`vi.mock("../src/db/client.js", …)`
  with a fake `db`) does not touch the database: delete its `setupDatabase` call. Passing
  it the mock fails, because `setupDatabase(db)` checks which database the client is
  connected to before the first Reset.
- **A file that mocks the client module and still needs the database** passes the real
  client. A mock that spreads `importOriginal()` and keeps its `db` already hands you the
  real one: pass it. A mock that replaces `db` needs the original:

  ```ts
  const { db: realDb } =
    await vi.importActual<typeof import("../src/db/client.js")>("../src/db/client.js");

  setupDatabase(realDb);
  ```

  Spying on the real client with `vi.spyOn` is often simpler than mocking the module:
  see the workarounds below.

### Tests commit for real

Every write commits, so a test sees exactly what production would:

- **`beforeAll` writes are allowed** (0.3 threw). They commit, and last until the Reset
  after the file's first test, so data every test needs still belongs in `beforeEach`,
  the test, or a factory.
- **`onTestFinished` callbacks reach the database** (0.3 ran them past the rollback).
  They run after the Reset, so rows they write survive into the next test: keep database
  writes in an `afterEach` registered after `setupDatabase(db)`.
- **`$transaction`, second clients and concurrent transactions behave as in
  production.** A `$transaction` runs on its own connection and commits or rolls back for
  real; a second `PrismaClient` or a queue worker sees every row a test writes, from the
  moment it is written; transactions fired with `Promise.all` run in parallel instead of
  one after another. Flip or delete any assertion that a test's writes are invisible
  outside it, or never reach the database.
- **Rows your migrations insert are still there in every test**, as in 0.3. The tables
  that hold rows after migrate form the **Baseline**, and the Reset restores a
  Baseline table, instead of emptying it, whenever a test wrote to it: inserted,
  updated, deleted or truncated. A partitioned Baseline table is restored after every
  test. A test that wants those rows gone deletes them itself, and the next Reset
  brings them back. See
  [Rows your migrations insert](writing-tests.md#rows-your-migrations-insert).
- **Ids restart in every test.** The Reset rewinds every column-owned sequence. A
  sequence owned by an empty table restarts at 1. A sequence owned by a Baseline table
  goes back to where the migrations left it, so the next insert gets the id after the
  last migration row. In 0.3 they kept climbing across tests.
- **The harness owns a `prisma_test_helper` schema** in every Worker Database: the
  Baseline's snapshot and bookkeeping. Discovery skips it, and your migrations must not
  create a schema by that name.

Workarounds the rollback model forced, which you can now remove:

- **One test per expected constraint error.** A failed statement no longer aborts the
  test's transaction, so one test can assert several errors and keep querying after them.
- **Avoiding `vi.spyOn` on the client.** `db` is your real client, not a proxy: spy on
  its methods like any other object.
- **Matching rows by id because they shared one `now()`.** Each statement commits on its
  own, so `DEFAULT now()` timestamps differ between writes and ordering by them works.
- **Rules in your own docs** (`AGENTS.md`, test conventions) telling people or agents not
  to assert on transaction behaviour, or not to use a second client. Delete them.

### Errors

> [!WARNING]
> A database test file without `setupDatabase(db)` no longer throws. 0.3 failed it with
> `the database was touched with no test transaction live`; 1.0 runs it and simply does
> not Reset between its tests, so rows from one test are still there in the next. Your
> tripwire is now `isDatabaseSetUp()`, checked in your own factories:
> [Fixtures and seeded fake data](writing-tests.md#fixtures-and-seeded-fake-data).

The 0.3 errors are gone. What replaces each:

| 0.3 error                                                               | 1.0                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `refusing to open a test transaction on <name> — only Worker Databases` | `refusing to reset <name> — only Worker Databases`           |
| `no test transaction is installed —`                                    | None: there is no module mock to bypass.                     |
| `a test transaction is already live —`                                  | `setupDatabase() was called twice in this file`              |
| `the database was touched with no test transaction live —`              | None: see the warning above. `beforeAll` writes are allowed. |

New in 1.0, each with its fix in
[Troubleshooting](troubleshooting.md#errors-from-this-package):

- `refusing to reset <name> — only Worker Databases`
- `refusing to reset — no Worker Database is configured for this file.`
- `the client passed to setupDatabase() is connected to <name>, but`
- `setupDatabase() was called twice in this file`
- `the Reset could not empty <name>:`

### The agent skills are retired

0.3 shipped two agent skills, `prisma-test-helper-setup` and `prisma-test-helper`,
installed with `npx skills add flolefebvre/prisma-test-helper --skill …` or copied into a
skills directory such as `.claude/skills/`. They teach the rollback model. Delete both
skill directories wherever you installed them, then point your agent at the docs that
ship with the package by adding one line to your project's `AGENTS.md`:

```md
Tests that touch the database use @flefebvre/prisma-test-helper: read
node_modules/@flefebvre/prisma-test-helper/docs/for-agents.md first.
```
