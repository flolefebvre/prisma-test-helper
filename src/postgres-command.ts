// The pure half of starting the run's Postgres: the server command line, built from the
// harness's built-in settings and the consumer's `postgresSettings`. No container, no
// I/O — the global setup hands the result to Testcontainers, so it is exercised without
// a container.

/** A Postgres server setting value, as `postgresSettings` accepts it. */
export type PostgresSettingValue = string | number | boolean;

/**
 * The settings every run's container starts with. A throwaway database needs no
 * durability: skipping fsync, synchronous commits and full-page writes makes migrate,
 * the clones and every test write faster. Each one can be overridden through
 * `postgresSettings`.
 */
const DEFAULT_SETTINGS: Readonly<Record<string, PostgresSettingValue>> = {
  fsync: false,
  synchronous_commit: false,
  full_page_writes: false,
};

/**
 * A Postgres setting name: lowercase letters, digits and underscores, optionally
 * prefixed by an extension's name and a dot (`auto_explain.log_min_duration`).
 */
const SETTING_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * The argv the container runs: `postgres`, then one `-c name=value` pair per setting —
 * the built-in defaults, each replaced in place by a `postgresSettings` entry of the same
 * name, then the remaining entries in their given order.
 *
 * Booleans become `on`/`off` and numbers are stringified. Values are neither escaped nor
 * checked: each pair travels as its own argv element, no shell is involved, and Postgres
 * refuses a bad value at startup with a message naming the setting. Names are checked,
 * so a malformed one fails here, before any container starts.
 */
export function postgresCommand(settings: Record<string, PostgresSettingValue> = {}): string[] {
  for (const name of Object.keys(settings)) {
    if (!SETTING_NAME.test(name)) {
      throw new Error(
        `postgresSettings: invalid setting name ${JSON.stringify(name)} — a Postgres ` +
          "setting name is lowercase letters, digits and underscores, optionally prefixed " +
          'by an extension name and a dot (e.g. "auto_explain.log_min_duration")',
      );
    }
  }
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return [
    "postgres",
    ...Object.entries(merged).flatMap(([name, value]) => ["-c", `${name}=${settingValue(value)}`]),
  ];
}

function settingValue(value: PostgresSettingValue): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}
