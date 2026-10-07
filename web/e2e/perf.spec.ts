/// <reference lib="dom" />
// Performance guards from the brief: no long tasks (> 50 ms) while the overview streams three demo nodes, and a lean
// startup bundle. The deeper measurements (frame times at 1x/4x CPU, initial load, multi-hour memory soak) are
// scripts: scripts/frames.mjs, scripts/load.mjs, scripts/soak.mjs (see web/perf/README.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

const DIST = join(import.meta.dirname, '..', 'dist');
/** Startup JavaScript, gzip: the entry script, its modulepreloads and their static imports. */
const STARTUP_JS_BUDGET_KB = 200;
const STREAM_S = 20;

// A long task is a main-thread budget overrun; a stray one on a busy machine (parallel workers) gets one retry, a real
// regression fails both attempts.
test.describe.configure({ retries: 1 });

test('no long tasks over 50 ms while the overview streams', async ({ page }) => {
  test.setTimeout(60_000 + STREAM_S * 1000);
  let frames = 0;
  page.on('websocket', (ws) => { ws.on('framereceived', () => { frames++; }); });
  await page.addInitScript(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(Math.round(e.duration));
    }).observe({ type: 'longtask' });
  });
  await page.goto('/');
  // Live: every node card shows a number (the first render and the history back-fill are startup, not streaming).
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll('.ov-card')].filter((c) => /\d/.test(c.querySelector('.ov-card__stats .num')?.textContent ?? '')).length), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2); // the demo takes spark3 offline for a while
  await page.waitForTimeout(2000);
  await page.evaluate(() => { (window as unknown as { __long: number[] }).__long.length = 0; });
  const frames0 = frames;
  await page.waitForTimeout(STREAM_S * 1000);
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  // It really streamed (a sample per node per second), and nothing blocked the main thread for more than 50 ms.
  expect(frames - frames0).toBeGreaterThanOrEqual(STREAM_S);
  expect(long, `long tasks (ms) during ${STREAM_S} s of streaming`).toEqual([]);
});

test('startup JavaScript stays within the gzip budget, with the benchmark suite split out', () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const queue = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1] ?? '');
  const startup = new Set<string>();
  while (queue.length) {
    const f = queue.shift() ?? '';
    if (startup.has(f)) continue;
    startup.add(f);
    // Static imports between chunks (`from"./x.js"`, `import"./x.js"`); import("./x.js") is lazy and not counted.
    for (const m of readFileSync(join(DIST, f), 'utf8').matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) queue.push(`assets/${m[1] ?? ''}`);
  }
  const files = [...startup];
  const kb = files.reduce((n, f) => n + gzipSync(readFileSync(join(DIST, f)), { level: 9 }).length, 0) / 1024;
  expect(kb, `startup JS ${kb.toFixed(1)} KB gzip: ${files.join(', ')}`).toBeLessThan(STARTUP_JS_BUDGET_KB);
  // The lazy pages are not in the startup graph.
  for (const lazy of ['Benchmarks', 'Alerts', 'Settings', 'Wall', 'Login', 'motionFeatures']) {
    expect(files.some((f) => f.startsWith(`assets/${lazy}-`)), `${lazy} chunk loaded at startup`).toBe(false);
  }
});
