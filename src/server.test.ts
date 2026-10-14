import { describe, expect, test } from "vitest";

import {
  assertNamesFit,
  assertServerUsable,
  dropDatabaseStatement,
  dropStatements,
  ignoredOptionsWarning,
  leftoversByRun,
  lostLockMessage,
  MARKED_DATABASES_QUERY,
  markStatement,
  newRunId,
  parseRunMarker,
  redactUrl,
  resolveServerMode,
  RUN_LOCK_NAMESPACE,
  runLockKey,
  runLockStatement,
  runMarker,
  runTemplateName,
  runUnlockStatement,
  sweepFailedMessage,
  sweptMessage,
  tryRunLockStatement,
  type ServerCheck,
} from "./server.js";

// The pure half of choosing and addressing the run's server, exercised without one: the
// mode and its conflicts, the names a run on a shared server derives, the startup checks,
// the teardown statements, and the Run markers, locks and lines of the Sweep.

const SERVER = "postgresql://app:secret@db:5432/postgres";
const OTHER = "postgresql://dev:pw@localhost:5433/app";

describe("resolveServerMode", () => {
  test("runs in a container when neither the option nor the env var is set", () => {
    expect(resolveServerMode({}, {})).toEqual({ kind: "container" });
  });

  test("treats an empty option and an empty env var as unset", () => {
    expect(resolveServerMode({ url: "" }, { PRISMA_TEST_HELPER_URL: "" })).toEqual({
      kind: "container",
    });
  });

  test("uses the url option", () => {
    expect(resolveServerMode({ url: SERVER }, {})).toEqual({
      kind: "url",
      url: SERVER,
      source: "`url`",
      ignored: [],
    });
  });

  test("lets PRISMA_TEST_HELPER_URL override the url option", () => {
    expect(resolveServerMode({ url: SERVER }, { PRISMA_TEST_HELPER_URL: OTHER })).toEqual({
      kind: "url",
      url: OTHER,
      source: "`PRISMA_TEST_HELPER_URL`",
      ignored: [],
    });
  });

  test.each([
    [{ image: "postgres:16" }, "url: cannot be combined with image — it configures"],
    [{ postgresSettings: {} }, "url: cannot be combined with postgresSettings — it configures"],
    [
      { image: "postgres:16", postgresSettings: { fsync: true } },
      "url: cannot be combined with image and postgresSettings — they configure",
    ],
  ])("refuses the url option alongside %o, naming the options", (options, message) => {
    expect(() => resolveServerMode({ url: SERVER, ...options }, {})).toThrow(message);
  });

  // The env var is a per-machine switch over a shared config that pins `image`.
  test("reports container options as ignored, without failing, when the env var sets the mode", () => {
    expect(
      resolveServerMode(
        { image: "postgres:16", postgresSettings: {} },
        { PRISMA_TEST_HELPER_URL: SERVER },
      ),
    ).toMatchObject({ kind: "url", ignored: ["image", "postgresSettings"] });
  });

  test("refuses a URL that does not parse, without echoing it", () => {
    expect(() => resolveServerMode({ url: "not a url:secret" }, {})).toThrow(
      /^url: not a valid connection URL/,
    );
    expect(() => resolveServerMode({}, { PRISMA_TEST_HELPER_URL: "secret" })).toThrow(
      /^PRISMA_TEST_HELPER_URL: not a valid connection URL — expected postgresql:/,
    );
  });
});

test("ignoredOptionsWarning names the ignored options and the env var", () => {
  expect(ignoredOptionsWarning(["image"])).toBe(
    "@flefebvre/prisma-test-helper: ignoring image — PRISMA_TEST_HELPER_URL is set, so " +
      "the run uses that server and starts no container.",
  );
});

describe("redactUrl", () => {
  test("replaces the password and drops the query", () => {
    expect(redactUrl("postgresql://app:s3cret@db:5432/postgres?sslmode=require&password=x")).toBe(
      "postgresql://app:***@db:5432/postgres",
    );
  });

  test("leaves a URL without a password as it was", () => {
    expect(redactUrl("postgresql://app@db:5432/postgres")).toBe(
      "postgresql://app@db:5432/postgres",
    );
  });

  test("never echoes what it cannot parse", () => {
    expect(redactUrl("s3cret")).toBe("(unparseable URL)");
  });
});

describe("run names", () => {
  test("a run id is 8 lowercase hex characters, fresh each time", () => {
    const ids = new Set(Array.from({ length: 20 }, newRunId));

    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(ids.size).toBe(20);
  });

  test("the template name appends the run id to databaseName", () => {
    expect(runTemplateName("prisma_test", "0a1b2c3d")).toBe("prisma_test_0a1b2c3d");
  });
});

describe("assertNamesFit", () => {
  // The run adds "_0a1b2c3d" (9 bytes) and, with 10 workers, "_10" (3): 51 + 12 = 63.
  test("accepts a longest Worker Database name of exactly 63 bytes", () => {
    const databaseName = "d".repeat(51);

    expect(() =>
      assertNamesFit(runTemplateName(databaseName, "0a1b2c3d"), 10, databaseName),
    ).not.toThrow();
  });

  test("refuses one byte more, saying how far to shorten databaseName", () => {
    const databaseName = "d".repeat(52);

    expect(() =>
      assertNamesFit(runTemplateName(databaseName, "0a1b2c3d"), 10, databaseName),
    ).toThrow(
      `databaseName: "${databaseName}" is too long for url mode — the run names its Worker ` +
        `Databases <databaseName>_<run id>_<n>, and ${databaseName}_0a1b2c3d_10 is 64 bytes, ` +
        "over Postgres's 63-byte identifier limit (Postgres would truncate it silently, so " +
        "names could collide). Shorten databaseName to at most 51 bytes.",
    );
  });

  test("counts bytes, not characters", () => {
    // "é" is 2 bytes: 26 of them are 52 bytes, plus 12 → 64, though only 38 characters.
    const databaseName = "é".repeat(26);

    expect(() =>
      assertNamesFit(runTemplateName(databaseName, "0a1b2c3d"), 10, databaseName),
    ).toThrow(/is 64 bytes/);
  });
});

describe("assertServerUsable", () => {
  const usable: ServerCheck = {
    role: "app",
    superuser: true,
    version_num: 130000,
    version: "13.0",
  };
  const server = "postgresql://app:***@db:5432/postgres";

  test("accepts a superuser on Postgres 13", () => {
    expect(() => assertServerUsable(usable, server)).not.toThrow();
  });

  test("refuses a role that is not a superuser, naming it and why", () => {
    expect(() => assertServerUsable({ ...usable, superuser: false }, server)).toThrow(
      `the role "app" on the Postgres server ${server} is not a superuser — the Reset needs ` +
        "one: it sets session_replication_role and reads pg_stat_file. Connect as a " +
        "superuser role (see the requirements in docs/setup.md).",
    );
  });

  test("refuses a server older than 13, naming its version", () => {
    expect(() =>
      assertServerUsable({ ...usable, version_num: 120022, version: "12.22" }, server),
    ).toThrow(
      `the Postgres server ${server} runs Postgres 12.22 — url mode needs Postgres 13 or later`,
    );
  });
});

// Teardown sends each statement as its own query, and names a failure from its entry.
test("dropStatements drops every Worker Database, then the template, and nothing else", () => {
  expect(dropStatements("prisma_test_0a1b2c3d", 2)).toEqual([
    {
      database: "prisma_test_0a1b2c3d_1",
      statement: 'DROP DATABASE IF EXISTS "prisma_test_0a1b2c3d_1" WITH (FORCE)',
    },
    {
      database: "prisma_test_0a1b2c3d_2",
      statement: 'DROP DATABASE IF EXISTS "prisma_test_0a1b2c3d_2" WITH (FORCE)',
    },
    {
      database: "prisma_test_0a1b2c3d",
      statement: 'DROP DATABASE IF EXISTS "prisma_test_0a1b2c3d" WITH (FORCE)',
    },
  ]);
});

describe("Run markers", () => {
  test("a marker names the run id after the harness's prefix", () => {
    expect(runMarker("0a1b2c3d")).toBe("prisma-test-helper run 0a1b2c3d");
  });

  test("marks a database with its run's marker", () => {
    expect(markStatement("prisma_test_0a1b2c3d_1", "0a1b2c3d")).toBe(
      `COMMENT ON DATABASE "prisma_test_0a1b2c3d_1" IS 'prisma-test-helper run 0a1b2c3d'`,
    );
  });

  test("reads the run id back from a marker", () => {
    const runId = newRunId();

    expect(parseRunMarker(runMarker(runId))).toBe(runId);
  });

  test.each([
    ["no comment", null],
    ["another comment", "dev database, do not drop"],
    ["a marker with something appended", "prisma-test-helper run 0a1b2c3d (kept)"],
    ["a run id that is not 8 lowercase hex", "prisma-test-helper run 0A1B2C3D"],
    ["a run id too short", "prisma-test-helper run 0a1b2c3"],
  ])("names no run for %s", (_, comment) => {
    expect(parseRunMarker(comment)).toBeUndefined();
  });

  test("the listing reads each database's comment, filtered to the harness's prefix", () => {
    expect(MARKED_DATABASES_QUERY).toBe(
      "SELECT datname, shobj_description(oid, 'pg_database') AS marker FROM pg_database " +
        "WHERE shobj_description(oid, 'pg_database') LIKE 'prisma-test-helper run %' " +
        "ORDER BY datname",
    );
  });
});

describe("leftoversByRun", () => {
  test("groups the marked databases by run, in the order listed", () => {
    const rows = [
      { datname: "app_test_0a1b2c3d", marker: runMarker("0a1b2c3d") },
      { datname: "prisma_test_ffffffff", marker: runMarker("ffffffff") },
      { datname: "app_test_0a1b2c3d_1", marker: runMarker("0a1b2c3d") },
    ];

    expect(leftoversByRun(rows, "12345678")).toEqual(
      new Map([
        ["0a1b2c3d", ["app_test_0a1b2c3d", "app_test_0a1b2c3d_1"]],
        ["ffffffff", ["prisma_test_ffffffff"]],
      ]),
    );
  });

  test("leaves out the run's own databases and any marker that does not parse", () => {
    const rows = [
      { datname: "prisma_test_12345678", marker: runMarker("12345678") },
      { datname: "prisma_test_0a1b2c3d", marker: "prisma-test-helper run 0a1b2c3d (kept)" },
      { datname: "prisma_test_0b1b2c3d", marker: null },
    ];

    expect(leftoversByRun(rows, "12345678")).toEqual(new Map());
  });
});

describe("run locks", () => {
  test("the namespace is one fixed int4", () => {
    expect(RUN_LOCK_NAMESPACE).toBe(1886676992);
    expect(RUN_LOCK_NAMESPACE | 0).toBe(RUN_LOCK_NAMESPACE);
  });

  test.each([
    ["00000000", 0],
    ["0000002a", 42],
    ["7fffffff", 2147483647],
    // From 0x80000000 the 32 bits read as a negative int4: the key wraps, it never overflows.
    ["80000000", -2147483648],
    ["ffffffff", -1],
    ["deadbeef", -559038737],
  ])("run id %s locks on key %i", (runId, key) => {
    expect(runLockKey(runId)).toBe(key);
  });

  test("every key fits an int4", () => {
    for (let i = 0; i < 100; i++) {
      const key = runLockKey(newRunId());
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThan(2 ** 31);
    }
  });

  test("locks, tries and unlocks on the harness's namespace and the run's key", () => {
    expect(runLockStatement("ffffffff")).toBe("SELECT pg_advisory_lock(1886676992, -1)");
    expect(tryRunLockStatement("0000002a")).toBe(
      "SELECT pg_try_advisory_lock(1886676992, 42) AS locked",
    );
    expect(runUnlockStatement("0000002a")).toBe("SELECT pg_advisory_unlock(1886676992, 42)");
  });
});

test("dropDatabaseStatement drops one database, whatever sessions it has", () => {
  expect(dropDatabaseStatement("prisma_test_0a1b2c3d")).toBe(
    'DROP DATABASE IF EXISTS "prisma_test_0a1b2c3d" WITH (FORCE)',
  );
});

describe("Sweep lines", () => {
  const server = "postgresql://app:***@db:5432/postgres";

  test("names the server and what was dropped", () => {
    expect(sweptMessage(server, ["prisma_test_0a1b2c3d_1", "prisma_test_0a1b2c3d"])).toBe(
      `@flefebvre/prisma-test-helper: dropped databases left on ${server} by a run that was ` +
        "killed: prisma_test_0a1b2c3d_1, prisma_test_0a1b2c3d",
    );
  });

  test("names each database it could not drop, and says the run goes on", () => {
    expect(sweepFailedMessage(server, ["prisma_test_0a1b2c3d (permission denied)"])).toBe(
      `@flefebvre/prisma-test-helper: could not drop databases left on ${server} by a run ` +
        "that was killed: prisma_test_0a1b2c3d (permission denied) — this run goes on; " +
        'drop them by hand with DROP DATABASE "<name>" WITH (FORCE)',
    );
  });

  test("says what a lost admin connection exposes", () => {
    expect(lostLockMessage(server, "Connection terminated unexpectedly")).toBe(
      `@flefebvre/prisma-test-helper: lost the admin connection to ${server} ` +
        "(Connection terminated unexpectedly) — this run no longer holds its lock, so a run " +
        "starting on that server now may drop this run's databases",
    );
  });
});
