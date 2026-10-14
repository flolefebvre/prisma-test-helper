import { expect, test, vi } from "vitest";

// `pg` is for the main-process global setup only: workers run the Reset through the
// consumer's own Prisma client, so the main entry and the `/setup` entry must never load
// the driver. Vitest calls a `vi.mock` factory only when something actually imports the
// mocked module, so the factory below doubles as a probe: if anything in an entry's
// import graph imports `pg`, the flag flips. Like surface.test.ts, this lives in its own
// file so nothing else is mocked around the entries.

const probe = vi.hoisted(() => ({ loaded: false }));
vi.mock("pg", () => {
  probe.loaded = true;
  return { default: {} };
});

test("importing the main and /setup entries does not load pg", async () => {
  await import("./index.js");
  await import("./setup.js");

  expect(probe.loaded).toBe(false);
});

// The global-setup entry imports `pg` lazily, when it opens the admin connection, so
// even importing that entry leaves the driver unloaded until a run's setup starts.
test("importing the /global-setup entry does not load pg either", async () => {
  await import("./global-setup.js");

  expect(probe.loaded).toBe(false);
});

// The positive control: without it, a probe that never fires would pass the test above.
// It runs last, as the flag cannot be reset once pg is loaded.
test("the probe fires when pg is imported", async () => {
  await import("pg");

  expect(probe.loaded).toBe(true);
});
