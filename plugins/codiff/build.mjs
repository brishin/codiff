import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { build } from 'esbuild';

const root = `${import.meta.dirname}/`;
await mkdir(`${root}dist`, { recursive: true });
await build({
  bundle: true,
  entryPoints: [`${root}thread-review.mjs`],
  format: 'cjs',
  outfile: `${root}dist/thread-review.cjs`,
  platform: 'node',
  target: 'node24',
});
await build({
  bundle: true,
  entryPoints: [`${root}agent-settings.mjs`],
  format: 'cjs',
  outfile: `${root}dist/agent-settings.cjs`,
  platform: 'node',
  target: 'node24',
});
await build({
  bundle: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  entryPoints: [`${root}review.tsx`],
  format: 'esm',
  jsx: 'automatic',
  loader: { '.svg': 'dataurl', '.wasm': 'dataurl', '.woff2': 'dataurl' },
  minify: true,
  outfile: `${root}dist/review.js`,
  platform: 'browser',
  target: 'es2022',
});
const [script, css] = await Promise.all([
  readFile(`${root}dist/review.js`, 'utf8'),
  readFile(`${root}dist/review.css`, 'utf8'),
]);
await writeFile(
  `${root}dist/review.html`,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codiff</title><style>${css}</style><style>
html,body,#root{height:100%;margin:0}body{overflow:hidden}.thread-review{height:100%;display:flex;flex-direction:column}.thread-review-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;gap:16px;border-bottom:1px solid var(--border)}.thread-review-header span{display:block;font-size:12px;margin-top:4px;opacity:.7}.thread-review-surface{flex:1;min-height:0}.thread-review-surface>.app-shell{height:100%}.thread-review-error,.thread-review-empty{padding:16px}
</style></head><body><div id="root"></div><script type="module">${script.replaceAll('</script', String.raw`<\/script`)}</script></body></html>`,
);
process.stdout.write('Built standalone thread review server and UI.\n');
