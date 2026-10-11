// @ts-check

import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  // Build output, deps, the generated fixture client, and nested worktrees (each has its
  // own config, which ESLint would otherwise pick up) are never linted.
  globalIgnores(["dist", "node_modules", "coverage", "tests/generated", ".claude/worktrees"]),
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    extends: [tseslint.configs.recommended],
  },
]);
