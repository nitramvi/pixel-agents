/**
 * esbuild config for the standalone server.
 * Bundles server/src/standalone.ts → dist/server/standalone.js
 */
const esbuild = require('esbuild');

async function main() {
  await esbuild.build({
    entryPoints: ['server/src/standalone.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outdir: 'dist/server',
    external: ['express', 'ws'],
    sourcemap: true,
    logLevel: 'info',
    banner: {
      js: `// Pixel Agents Standalone Server`,
    },
  });
  console.log('✓ Built server/ → dist/server/');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
