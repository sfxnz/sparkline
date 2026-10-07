// Frame budget while streaming: for each view, record every animation frame's duration (rAF deltas) and every
// long task (PerformanceObserver 'longtask') over a window, at 1x and 4x CPU throttling (CDP; 4x approximates a
// mid-range laptop on a fast desktop). Uses the production build behind a throwaway demo console (3 nodes).
//
//   npm run build && node scripts/frames.mjs [--seconds 60] [--throttle 1,4] [--views overview,gpu,cpu,wall,bench]
//                                            [--port 9711] [--dist dist] [--json out.json] [--css 'extra rules (A/B)']
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { navigate, option, quantile, startBench, startDemo, waitLive } from './lib.mjs';

const seconds = Number(option('seconds', 60));
const throttles = String(option('throttle', '1,4')).split(',').map(Number);
const viewNames = String(option('views', 'overview,gpu,cpu,wall,bench')).split(',');
const port = Number(option('port', process.env.PERF_PORT ?? 9711));
const dist = option('dist', process.env.PERF_DIST);
const jsonOut = option('json', null);
const css = option('css', null);

/** Installed before any app code: frame deltas and long tasks, reset per measurement window. */
function instrument() {
  const perf = { frames: [], long: [], loaf: [] };
  window.__perf = perf;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) perf.long.push(e.duration);
  }).observe({ type: 'longtask' });
  try {
    // Long animation frames name the scripts behind slow frames (Chromium 123+).
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const s = [...e.scripts].sort((a, b) => b.duration - a.duration)[0];
        perf.loaf.push({ d: Math.round(e.duration), block: Math.round(e.blockingDuration), src: s ? `${s.invoker} ${s.sourceFunctionName || ''} ${(s.sourceURL || '').split('/').pop()}:${s.sourceCharPosition}` : '' });
      }
    }).observe({ type: 'long-animation-frame' });
  } catch {
    /* unsupported */
  }
  let last = 0;
  const tick = (t) => {
    if (last) perf.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const demo = await startDemo({ port, ...(dist ? { dist } : {}) });
const browser = await chromium.launch();
const results = [];
try {
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.VW ?? 1440), height: Number(process.env.VH ?? 900) } });
  await ctx.addInitScript(instrument);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const mainThread = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await page.goto(demo.url);
  if (css) await page.addStyleTag({ content: css });
  await waitLive(page);
  let benchRun = null;
  const views = {
    overview: '/',
    gpu: '/node/spark1/gpu',
    cpu: '/node/spark1/cpu',
    wall: '/wall',
    bench: async () => {
      // A long simulated thermal soak keeps the run view streaming for the whole window.
      benchRun ??= await startBench(demo.url, 'thermal-soak', ['spark1'], { minutes: 60 });
      return `/benchmarks/runs/${benchRun}`;
    },
  };
  for (const rate of throttles) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    for (const name of viewNames) {
      const v = views[name];
      const path = typeof v === 'function' ? await v() : v;
      await navigate(page, path);
      await page.waitForTimeout(5000); // route change, lazy chunks, first data
      await page.evaluate(() => { const p = window.__perf; p.frames.length = p.long.length = p.loaf.length = 0; });
      const m0 = await mainThread();
      await page.waitForTimeout(seconds * 1000);
      const raw = await page.evaluate(() => window.__perf);
      const m1 = await mainThread();
      const busy = (k) => +((100 * (m1[k] - m0[k])) / seconds).toFixed(1);
      const f = [...raw.frames].sort((a, b) => a - b);
      const r = {
        view: name,
        throttle: rate,
        frames: f.length,
        fps: +(f.length / seconds).toFixed(1),
        p50: +quantile(f, 0.5).toFixed(1),
        p95: +quantile(f, 0.95).toFixed(1),
        p99: +quantile(f, 0.99).toFixed(1),
        dropped: +((100 * f.filter((d) => d > 16.7 * 1.5).length) / f.length).toFixed(2),
        over50: +((100 * f.filter((d) => d > 50).length) / f.length).toFixed(2),
        // Main-thread time per wall second (CDP cumulative task/script/layout/style durations), in %: the part of
        // a frame budget the app itself spends, independent of how fast this machine can composite.
        mainPct: busy('TaskDuration'),
        scriptPct: busy('ScriptDuration'),
        layoutStylePct: +(busy('LayoutDuration') + busy('RecalcStyleDuration')).toFixed(1),
        longTasks: raw.long.length,
        longMax: raw.long.length ? Math.round(Math.max(...raw.long)) : 0,
        loafTop: raw.loaf.filter((l) => l.block > 0).sort((a, b) => b.block - a.block).slice(0, 3), // the frames that blocked input, with their main script
      };
      results.push(r);
      console.log(JSON.stringify({ ...r, loafTop: undefined }));
      for (const l of r.loafTop) console.log('   loaf', l.d, 'ms block', l.block, l.src);
    }
  }
  if (benchRun) await fetch(`${demo.url}/api/v1/bench/runs/${benchRun}/cancel`, { method: 'POST' }).catch(() => undefined);
} finally {
  await browser.close();
  await demo.stop();
}

console.log('\n| view | CPU | fps | p50 ms | p95 ms | p99 ms | frames > 25 ms | frames > 50 ms | long tasks (max ms) | main thread % (script, layout+style) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.view} | ${r.throttle}x | ${r.fps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.dropped}% | ${r.over50}% | ${r.longTasks} (${r.longMax}) | ${r.mainPct} (${r.scriptPct}, ${r.layoutStylePct}) |`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
