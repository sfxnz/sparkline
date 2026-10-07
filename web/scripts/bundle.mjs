// Startup bundle report: the JS and CSS a cold load of the app fetches before it can render (the entry script, its
// static imports and modulepreloads, the stylesheets), gzip-sized, plus every lazy chunk. Exits 1 over budget.
//
//   npm run build && node scripts/bundle.mjs [--dist dist] [--budget-kb 200]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WEB, option } from './lib.mjs';

const dist = option('dist', join(WEB, 'dist'));
const budgetKb = Number(option('budget-kb', 200));

/** Gzip size of every file the entry HTML loads up front, following static imports between chunks. */
export function startupFiles(distDir) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const seen = new Set();
  const queue = [...refs];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!f.endsWith('.js')) continue;
    const code = readFileSync(join(distDir, f), 'utf8');
    // Static imports only (`from"./x.js"` / `import"./x.js"`); import("./x.js") is lazy.
    for (const m of code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) queue.push(`assets/${m[1]}`);
  }
  return [...seen];
}

const gz = (f) => gzipSync(readFileSync(join(dist, f)), { level: 9 }).length;
const startup = startupFiles(dist);
const js = startup.filter((f) => f.endsWith('.js'));
const css = startup.filter((f) => f.endsWith('.css'));
const kb = (n) => (n / 1024).toFixed(1);
const jsTotal = js.reduce((n, f) => n + gz(f), 0);
const cssTotal = css.reduce((n, f) => n + gz(f), 0);

console.log('Startup (gzip):');
for (const f of [...js, ...css].sort((a, b) => gz(b) - gz(a))) console.log(`  ${kb(gz(f)).padStart(7)} KB  ${f}`);
console.log(`  JS ${kb(jsTotal)} KB, CSS ${kb(cssTotal)} KB (budget: JS < ${budgetKb} KB)`);
const lazy = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js') && !startup.includes(`assets/${f}`));
console.log('Lazy chunks (gzip):');
for (const f of lazy.sort((a, b) => gz(`assets/${b}`) - gz(`assets/${a}`)).slice(0, 15)) console.log(`  ${kb(gz(`assets/${f}`)).padStart(7)} KB  ${f}`);
if (jsTotal / 1024 >= budgetKb) {
  console.log('FAIL: startup JS over budget');
  process.exit(1);
}
