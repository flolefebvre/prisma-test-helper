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
          globalSetup: ["tests/global-setup.ts"],
          pool: "forks",
          // Pinned so the suite can assert the exact set of Worker Databases.
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
