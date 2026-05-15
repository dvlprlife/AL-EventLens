const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const targets = [
  {
    name: 'node',
    platform: 'node',
    mainFields: ['module', 'main'],
    outfile: 'dist/extension.js'
  },
  {
    name: 'web',
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    outfile: 'dist/web/extension.js'
  }
];

async function buildTarget(target) {
  return esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: target.platform,
    mainFields: target.mainFields,
    outfile: target.outfile,
    external: ['vscode'],
    logLevel: 'info'
  });
}

async function main() {
  const contexts = await Promise.all(targets.map(buildTarget));

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
