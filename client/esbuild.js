// @ts-check
const esbuild = require('esbuild');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * The bundles resolve the workspace packages from their TypeScript sources, so a bundle never depends
 * on a previous `tsc -b` run and source maps point at the .ts files. The checker comes along, so the
 * scripts can be checked from a command line with the installed extension alone.
 * @type {import('esbuild').BuildOptions}
 */
const buildOptions = {
  entryPoints: [
    { in: 'src/extension.ts', out: 'extension' },
    { in: '../packages/server/src/server.ts', out: 'server' },
    { in: '../packages/cli/src/cli.ts', out: 'x4-script-check' },
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
    'x4-catalog': path.resolve(__dirname, '../packages/catalog/src/index.ts'),
  },
  // The checker's version, which its own package.json gives when installed from npm.
  define: {
    X4_SCRIPT_CHECK_VERSION: JSON.stringify(require('../packages/cli/package.json').version),
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
