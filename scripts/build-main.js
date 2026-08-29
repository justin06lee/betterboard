// Yagami and the Agent SDK rely on import.meta.url. An ESM bundle preserves it
// while still providing `require` for BetterBoard's CommonJS main-process
// source and dependencies. Electron itself remains external at runtime.
const { build } = require('esbuild');

void build({
  entryPoints: ['src/main/main.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist-main/main.mjs',
  external: ['electron'],
  banner: {
    js: 'import { createRequire as __betterboardCreateRequire } from "node:module"; const require = __betterboardCreateRequire(import.meta.url);',
  },
  logLevel: 'info',
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
