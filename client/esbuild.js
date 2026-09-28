// @ts-check
const esbuild = require('esbuild');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Both bundles resolve the workspace packages from their TypeScript sources, so a bundle never
 * depends on a previous `tsc -b` run and source maps point at the .ts files.
 * @type {import('esbuild').BuildOptions}
 */
const buildOptions = {
  entryPoints: [
    { in: 'src/extension.ts', out: 'extension' },
    { in: '../packages/server/src/server.ts', out: 'server' },
  ],
  bundle: true,
  outdir: 'dist',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: !production,
  sourcesContent: false,
  minify: production,
  logLevel: 'info',
  alias: {
    'x4-script-core': path.resolve(__dirname, '../packages/core/src/index.ts'),
  },
};

async function main() {
  if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log('[esbuild] watching');
  } else {
    await esbuild.build(buildOptions);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
