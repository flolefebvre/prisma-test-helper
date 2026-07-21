import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // Docker-free: everything under src/ runs against mocked testcontainers.
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          clearMocks: true,
          restoreMocks: true,
          // Distinct groupOrder is required when projects differ in maxWorkers;
          // ordering unit first keeps the cheap feedback ahead of the container boot.
          sequence: { groupOrder: 0 },
        },
      },
      // Boots a real container via the repo's own global-setup file — the same
      // wiring the README prescribes to consumers. Needs Docker.
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          // Starts the container and provisions the Worker Databases, once per run.
          globalSetup: ["tests/global-setup.ts"],
          // Points DATABASE_URL at this worker's Worker Database and installs the
          // Client Seam, once per test file.
          setupFiles: ["tests/setup.ts"],
          // Both are Vitest defaults, set explicitly because the harness depends on
          // them: together they re-run `setupFiles` in a fresh process per test file.
          // Under `isolate: false` module state leaks across files, and the
          // `setupDatabase()` opt-in guard relies on its module re-instantiating per
          // file — `isDatabaseSetUp()` would report a neighbouring file's opt-in.
          pool: "forks",
          isolate: true,
          // Pinned so the suite can assert the exact set of Worker Databases.
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
