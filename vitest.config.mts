import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  // The tests run on the catalog reader's sources, as on the core's: no previous `tsc -b` needed, and never a stale build.
  resolve: {
    alias: { 'x4-catalog': here('./packages/catalog/src/index.ts') },
  },
  test: {
    // Each package a project named as the package, with the alias above.
    projects: ['packages/catalog', 'packages/core', 'packages/server', 'packages/cli', 'packages/mcp', 'client'].map((root) => ({
      extends: true,
      test: { root, name: (JSON.parse(readFileSync(here(`./${root}/package.json`), 'utf8')) as { name: string }).name },
    })),
  },
});
