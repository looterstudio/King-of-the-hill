// Production server build: plain JavaScript bundles, no TypeScript loader at runtime.
// (Running through tsx costs ~30% CPU in the hot loops: helper wrappers on every closure.)
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

await build({
  entryPoints: { index: 'server/src/index.ts', matchworker: 'server/src/matchworker.ts' },
  outdir: 'dist-server', bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true, logLevel: 'info',
});
// the worker host loads ./matchworker-boot.mjs next to itself; in the bundle that is plain JS
writeFileSync('dist-server/matchworker-boot.mjs', "import './matchworker.js';\n");
