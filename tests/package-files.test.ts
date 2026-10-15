import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

// The tarball contract. The docs ship inside the package so an agent reading
// `node_modules/@flefebvre/prisma-test-helper/` finds pages that match the installed
// version — which only holds if every page ships, nothing repo-internal does, and every
// relative link resolves to a packed file. This resolves the real packlist, so a `files`
// edit or a renamed page fails here rather than after publish. Docker-free: it runs in
// the `unit` project.
//
// `dist/` is listed only once built, and the gate runs tests before the build, so the
// presence of the built entry points is checked in CI after the build instead.

const packed: string[] = (
  JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf8",
    }),
  ) as { files: { path: string }[] }[]
)[0]!.files.map((file) => file.path);

const docPages = readdirSync("docs")
  .filter((name) => name.endsWith(".md"))
  .map((name) => `docs/${name}`);
const markdownFiles = ["README.md", ...docPages];

/** GitHub's heading anchor: lowercased, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** Every anchor a Markdown file exposes, with GitHub's `-1`, `-2` suffixes on repeats. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const [, heading] of text.matchAll(/^#{1,6} (.+)$/gm)) {
    const base = slug(heading!);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

interface Link {
  from: string;
  /** Repo-relative path of the target file. */
  target: string;
  fragment: string | undefined;
}

/** Every relative link in a Markdown file, resolved against that file's directory. */
function relativeLinks(file: string): Link[] {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map(([, href]) => href!)
    .filter((href) => !/^[a-z][a-z0-9+.-]*:/i.test(href))
    .map((href) => {
      const [pathPart, fragment] = href.split("#") as [string, string | undefined];
      const target = pathPart === "" ? file : path.posix.join(path.posix.dirname(file), pathPart);
      return { from: file, target, fragment };
    });
}

const links = markdownFiles.flatMap(relativeLinks);

test("the docs exist and link to each other", () => {
  expect(docPages).toContain("docs/for-agents.md");
  expect(links.length).toBeGreaterThan(20);
});

test("every docs/*.md page is in the tarball", () => {
  expect(docPages.filter((page) => !packed.includes(page))).toEqual([]);
});

test("the tarball holds only the build, the docs pages, README, LICENSE and package.json", () => {
  const allowed = /^(dist\/|docs\/[^/]+\.md$|README\.md$|LICENSE$|package\.json$)/;
  expect(packed.filter((file) => !allowed.test(file))).toEqual([]);
  for (const internal of ["docs/adr/", "docs/agents/", "skills/"]) {
    expect(packed.filter((file) => file.startsWith(internal))).toEqual([]);
  }
});

test("every relative link in README.md and docs/*.md resolves to a packed file", () => {
  const dead = links
    .filter((link) => !packed.includes(link.target))
    .map((link) => `${link.from} → ${link.target}`);
  expect(dead).toEqual([]);
});

test("every link fragment names a heading in its target", () => {
  const broken = links
    // A dead target is reported by the test above; only packed pages are read here.
    .filter((link) => link.fragment !== undefined && packed.includes(link.target))
    .filter((link) => link.target.endsWith(".md"))
    .filter((link) => !anchors(link.target).has(link.fragment!))
    .map((link) => `${link.from} → ${link.target}#${link.fragment}`);
  expect(broken).toEqual([]);
});

test("`files` covers every export target", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    exports: Record<string, string | Record<string, string>>;
    files: string[];
  };
  const targets = Object.values(pkg.exports)
    .flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry)))
    .map((target) => target.replace(/^\.\//, ""))
    .filter((target) => target !== "package.json");
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect(pkg.files.some((entry) => target.startsWith(`${entry}/`))).toBe(true);
  }
});
