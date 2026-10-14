import { configDefaults, defineConfig } from "vitest/config";

// What both integration projects share: the per-worker wiring the README prescribes.
const integration = {
  environment: "node",
  // Points DATABASE_URL at this worker's Worker Database, once per test file.
  setupFiles: ["tests/setup.ts"],
  // Both are Vitest defaults, set explicitly because they are what the docs
  // prescribe: together they re-run `setupFiles` in a fresh process per test file.
  // `isolate: false` is the documented opt-in, run by `integration-no-isolate`.
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
      // tests/package-files.test.ts checks the tarball through `npm pack --dry-run`;
      // tests/node-floor.test.ts keeps pnpm's `nodeVersion` on the `engines.node` floor.
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/package-files.test.ts", "tests/node-floor.test.ts"],
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
          // `exclude` replaces Vitest's defaults (node_modules, dist, …) instead of
          // extending them: spread them back so a wider `include` stays safe.
          exclude: [...configDefaults.exclude, "tests/integration/container.test.ts"],
          globalSetup: ["tests/global-setup-url.ts"],
        },
      },
      // The container suite again under the `isolate: false` opt-in: each worker keeps
      // its modules — the Prisma client, its pool, the cached Reset — across the files it
      // runs, and `setupFiles` still runs before each. Every file must keep its own opt-in
      // state and start from a clean Worker Database. Which files share a worker is the
      // pool's choice; src/opt-in.test.ts pins the pairings deterministically. Needs Docker.
      {
        test: {
          ...integration,
          name: "integration-no-isolate",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/global-setup.ts"],
          isolate: false,
        },
      },
    ],
  },
});
