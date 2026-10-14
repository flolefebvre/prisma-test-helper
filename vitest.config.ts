import { defineConfig } from "vitest/config";

// What both integration projects share: the per-worker wiring the README prescribes.
const integration = {
  environment: "node",
  // Points DATABASE_URL at this worker's Worker Database, once per test file.
  setupFiles: ["tests/setup.ts"],
  // Both are Vitest defaults, set explicitly because the harness depends on
  // them: together they re-run `setupFiles` in a fresh process per test file.
  // Under `isolate: false` module state leaks across files, and the
  // `setupDatabase(db)` opt-in guard relies on its module re-instantiating per
  // file — `isDatabaseSetUp()` would report a neighbouring file's opt-in.
  pool: "forks" as const,
  isolate: true,
  // Pinned so the suite can assert the exact set of Worker Databases — and
  // equal to the unit project's, so the run is one group with no `groupOrder`
  // (projects that differ in maxWorkers need distinct groups).
  maxWorkers: 2,
};

export default defineConfig({
  test: {
    projects: [
      // Docker-free: everything under src/ runs against mocked testcontainers, and
      // tests/package-files.test.ts checks the tarball through `npm pack --dry-run`.
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/package-files.test.ts"],
          clearMocks: true,
          restoreMocks: true,
          // Same maxWorkers as the integration projects, so all share one group —
          // see the note on `integration`.
          maxWorkers: 2,
        },
      },
      // Boots a real container via the repo's own global-setup file — the same
      // wiring the README prescribes to consumers. Needs Docker.
      {
        test: {
          ...integration,
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Starts the container and provisions the Worker Databases, once per run.
          globalSetup: ["tests/global-setup.ts"],
        },
      },
      // The same suite in url mode, against a plain Postgres container standing in for
      // an existing server (or the server PRISMA_TEST_HELPER_URL names). Needs Docker.
      // container.test.ts reads back the container's own tuning, which url mode does
      // not apply; tests/url-mode/ holds what only url mode guarantees.
      {
        test: {
          ...integration,
          name: "integration-url",
          include: ["tests/integration/**/*.test.ts", "tests/url-mode/**/*.test.ts"],
          exclude: ["tests/integration/container.test.ts"],
          globalSetup: ["tests/global-setup-url.ts"],
        },
      },
    ],
  },
});
