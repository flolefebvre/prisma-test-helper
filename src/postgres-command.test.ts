import { describe, expect, test } from "vitest";

import { postgresCommand } from "./postgres-command.js";

// The server command line the run's container starts with, built without a container.

const DEFAULTS = ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"];

describe("postgresCommand", () => {
  test("holds the three built-in defaults when no settings are given", () => {
    expect(postgresCommand()).toEqual(["postgres", ...DEFAULTS]);
    expect(postgresCommand({})).toEqual(["postgres", ...DEFAULTS]);
  });

  test("appends each setting as its own -c pair, after the defaults", () => {
    expect(postgresCommand({ shared_preload_libraries: "pg_stat_statements" })).toEqual([
      "postgres",
      ...DEFAULTS,
      "-c",
      "shared_preload_libraries=pg_stat_statements",
    ]);
  });

  test("overrides a default of the same name in place, keeping the other defaults", () => {
    expect(postgresCommand({ fsync: true })).toEqual([
      "postgres",
      "-c",
      "fsync=on",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ]);
  });

  test("turns booleans into on/off and stringifies numbers", () => {
    expect(
      postgresCommand({ autovacuum: false, log_checkpoints: true, max_connections: 200 }),
    ).toEqual([
      "postgres",
      ...DEFAULTS,
      "-c",
      "autovacuum=off",
      "-c",
      "log_checkpoints=on",
      "-c",
      "max_connections=200",
    ]);
  });

  test("passes a value as-is, spaces and quotes included, in a single argv element", () => {
    expect(postgresCommand({ log_line_prefix: "%m [%p] 'x' " }).at(-1)).toBe(
      "log_line_prefix=%m [%p] 'x' ",
    );
  });

  test("admits a dotted extension setting", () => {
    expect(postgresCommand({ "auto_explain.log_min_duration": 0 }).slice(-2)).toEqual([
      "-c",
      "auto_explain.log_min_duration=0",
    ]);
  });

  test.each([
    "",
    "Fsync",
    "log-statement",
    "1st",
    "fsync=on",
    "a.b.c",
    "work_mem -c fsync",
    ".leading_dot",
  ])("refuses the setting name %j, naming the option and the key", (name) => {
    expect(() => postgresCommand({ [name]: "x" })).toThrow(
      `postgresSettings: invalid setting name ${JSON.stringify(name)}`,
    );
  });
});
