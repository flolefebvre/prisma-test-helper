import { describe, expect, test } from "vitest";

// The runtime surface of each entry point, pinned to the exact value exports docs/api.md
// lists (that page is the source of truth: change both together). Anything else an
// entry exports ships as public API in its `.d.ts`, so a helper exported only for a test
// fails here. These checks live in their own file, not in the entries' test files,
// because those mock testcontainers: what they import is the mock-wrapped module, and
// the surface must be checked unmocked. Types have no runtime presence and are not
// covered.

async function valueExports(entry: string): Promise<string[]> {
  return Object.keys(await import(entry)).sort();
}

describe("entry point surface", () => {
  test("the package root exports only its documented functions", async () => {
    expect(await valueExports("./index.js")).toEqual([
      "isDatabaseSetUp",
      "registerResetHook",
      "setupDatabase",
    ]);
  });

  test("/setup exports only setupWorkerDatabase", async () => {
    expect(await valueExports("./setup.js")).toEqual(["setupWorkerDatabase"]);
  });

  test("/global-setup exports only createGlobalSetup", async () => {
    expect(await valueExports("./global-setup.js")).toEqual(["createGlobalSetup"]);
  });
});
