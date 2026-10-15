import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

// The Node floor contract. package.json `engines.node` is the advertised range and the
// source of truth; pnpm-workspace.yaml's `nodeVersion` makes every install check the
// resolved tree's `engines` against that floor, and CI's `floor` leg runs the gate on it.
// The advertised floor was false twice (undici 8, then testcontainers 12.2.1) before
// anything caught it, so the two values must never drift apart. Docker-free: it runs in
// the `unit` project.

type Version = [number, number, number];

function parse(version: string): Version {
  return version.split(".").map(Number) as Version;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

test("pnpm-workspace.yaml `nodeVersion` is the lowest version in `engines.node`", () => {
  const { engines } = JSON.parse(readFileSync("package.json", "utf8")) as {
    engines: { node: string };
  };
  const versions = [...engines.node.matchAll(/\d+\.\d+\.\d+/g)].map(([version]) => version);
  expect(versions.length).toBeGreaterThan(0);
  const floor = versions.reduce((lowest, version) =>
    compare(parse(version), parse(lowest)) < 0 ? version : lowest,
  );

  const nodeVersion = /^nodeVersion: *(\S+)\s*$/m.exec(
    readFileSync("pnpm-workspace.yaml", "utf8"),
  )?.[1];

  expect(
    nodeVersion,
    `package.json engines.node ("${engines.node}") has floor ${floor}, but ` +
      `pnpm-workspace.yaml nodeVersion is ${nodeVersion ?? "missing"}. ` +
      "Update engines.node in package.json and nodeVersion in pnpm-workspace.yaml " +
      "together so they agree on the floor.",
  ).toBe(floor);
});
