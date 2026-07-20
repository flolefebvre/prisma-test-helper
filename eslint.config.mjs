// @ts-check

import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  // Build output, deps, and the generated fixture client are never linted.
  globalIgnores(["dist", "node_modules", "coverage", "tests/generated"]),
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    extends: [tseslint.configs.recommended],
  },
]);
