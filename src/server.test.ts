import { describe, expect, test } from "vitest";

import {
  assertNamesFit,
  assertServerUsable,
  dropStatements,
  ignoredOptionsWarning,
  newRunId,
  redactUrl,
  resolveServerMode,
  runTemplateName,
  type ServerCheck,
} from "./server.js";

// The pure half of choosing and addressing the run's server, exercised without one: the
// mode and its conflicts, the names a run on a shared server derives, the startup checks
// and the teardown statements.

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
