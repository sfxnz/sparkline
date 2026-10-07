// Memory soak: the production build behind a time-compressed demo console (`sparkline --demo --demo-speed N`) in
// headless Chromium. The page is loaded once and then navigated in-app (overview, every node tab, alerts,
// benchmarks, settings, wall, the command palette, time-range switches) every CYCLE seconds, with a short simulated
// benchmark started every 10 minutes. Every SAMPLE seconds it returns to the overview, forces a full GC over CDP and
// records JS heap, DOM nodes, JS event listeners and uPlot instances. At the end it fits a line through the
// post-warm-up samples and fails (exit 1) if the heap trends up by >= 1 MB/h or DOM nodes / listeners keep growing.
// The JS heap also holds V8's compiled code, which keeps growing for a while as more of the app gets optimized: a heap
// snapshot at the end of the warm-up and one at the end split the growth into app data (objects, arrays, strings,
// closures) and code / browser-native memory, and the app data is what the 1 MB/h limit applies to when they are
// available (--no-snapshots skips them).
//
//   SOAK_MINUTES=1440 npm run soak            # a true 24 h session (default 60 min)
//   node scripts/soak.mjs --minutes 75 --speed 8 --port 9712 --dist dist --out perf
//
// Writes <out>/soak.csv (one row per sample, flushed as it goes) and <out>/soak.svg.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { WEB, fitLine, navigate, option, startBench, startDemo, waitLive } from './lib.mjs';

const minutes = Number(option('minutes', process.env.SOAK_MINUTES ?? 60));
const speed = Number(option('speed', 8));
const port = Number(option('port', process.env.PERF_PORT ?? 9712));
const dist = option('dist', process.env.PERF_DIST);
const out = option('out', join(WEB, 'perf'));
const cycleS = Number(option('cycle', 30));
const sampleS = Number(option('sample', 120));
const warmupMin = Number(option('warmup', Math.min(10, minutes / 4)));
const HEAP_SLOPE_LIMIT_MB_H = 1;
const snapshots = !process.argv.includes('--no-snapshots');
/** Heap snapshot node types that are the app's own data (the rest: V8 code and metadata, browser-native objects). */
const APP_TYPES = new Set(['object', 'array', 'string', 'concatenated string', 'sliced string', 'closure', 'number', 'regexp', 'bigint']);

const TABS = ['', '/gpu', '/memory', '/cpu', '/network', '/storage', '/thermals', '/processes'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(out, { recursive: true });
const csvPath = join(out, 'soak.csv');
writeFileSync(csvPath, 'wall_min,demo_h,heap_mb,heap_total_mb,dom_nodes,listeners,documents,uplot,route_changes\n');

const demo = await startDemo({ port, speed, ...(dist ? { dist } : {}) });
const browser = await chromium.launch();
const rows = [];
const snaps = [];
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(demo.url);
  await waitLive(page);
  const nodes = ((await (await fetch(`${demo.url}/api/v1/cluster`)).json()).nodes ?? []).map((n) => n.node_id);
  const routes = ['/', ...nodes.flatMap((id) => TABS.map((t) => `/node/${id}${t}`)), '/alerts', '/benchmarks', '/settings', '/wall'];

  const t0 = Date.now();
  const elapsedMin = () => (Date.now() - t0) / 60_000;
  let nextSample = 0;
  let nextBench = 0;
  let step = 0;

  const sample = async () => {
    await navigate(page, '/');
    await sleep(5000);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const dom = await cdp.send('Memory.getDOMCounters');
    const uplot = await page.evaluate(() => document.querySelectorAll('.uplot').length);
    const wall = elapsedMin();
    const row = {
      wall_min: +wall.toFixed(2),
      demo_h: +((wall * speed) / 60).toFixed(3),
      heap_mb: +(m.JSHeapUsedSize / 2 ** 20).toFixed(3),
      heap_total_mb: +(m.JSHeapTotalSize / 2 ** 20).toFixed(3),
      dom_nodes: dom.nodes,
      listeners: dom.jsEventListeners,
      documents: dom.documents,
      uplot,
      route_changes: step,
    };
    rows.push(row);
    appendFileSync(csvPath, `${Object.values(row).join(',')}\n`);
    console.log(JSON.stringify(row));
  };

  /** Self size by snapshot node type, in MB (taken right after a sample, so after a full GC on the overview). */
  const snapshotByType = async () => {
    const chunks = [];
    const onChunk = (e) => chunks.push(e.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    const snap = JSON.parse(chunks.join(''));
    const fields = snap.snapshot.meta.node_fields;
    const types = snap.snapshot.meta.node_types[0];
    const [ti, si] = [fields.indexOf('type'), fields.indexOf('self_size')];
    const by = {};
    for (let i = 0; i < snap.nodes.length; i += fields.length) {
      const t = types[snap.nodes[i + ti]];
      by[t] = (by[t] ?? 0) + snap.nodes[i + si] / 2 ** 20;
    }
    return { wall_min: elapsedMin(), by };
  };

  while (elapsedMin() < minutes) {
    const now = elapsedMin();
    if (now >= nextSample) {
      await sample();
      nextSample += sampleS / 60;
      if (snapshots && !snaps.length && now >= warmupMin) snaps.push(await snapshotByType());
    }
    if (now >= nextBench) {
      // A short simulated run (the demo never touches hardware): exercises bench messages and the bench store.
      await startBench(demo.url, 'gpu-matmul', [nodes[step % nodes.length] ?? 'spark1'], { iterations: 10, warmup: 1, sizes: ['4096'], dtypes: ['bf16'] }).catch((e) => console.warn(String(e)));
      nextBench += 10;
    }
    const route = routes[step % routes.length] ?? '/';
    await navigate(page, route);
    step++;
    // Exercise dialogs and the history loader too: the palette every few steps, a fixed range on some charts.
    if (step % 5 === 0) {
      await page.keyboard.press('Control+k');
      await sleep(800);
      await page.keyboard.press('Escape');
    }
    if (step % 7 === 0 && (route === '/' || route.startsWith('/node/'))) {
      const radio = page.getByRole('radio', { name: step % 14 === 0 ? 'Last 24 hours' : 'Last hour' });
      await radio.click({ timeout: 5000 }).catch(() => undefined);
      await sleep(cycleS * 500);
      await page.getByRole('radio', { name: 'Live' }).click({ timeout: 5000 }).catch(() => undefined);
      await sleep(cycleS * 500);
    } else {
      await sleep(cycleS * 1000);
    }
  }
  await sample();
  if (snapshots && snaps.length) snaps.push(await snapshotByType());
  if (errors.length) console.warn(`page errors (${errors.length}):\n${errors.slice(0, 5).join('\n')}`);
} finally {
  await browser.close();
  await demo.stop();
}

// ---------------------------------------------------------------- analysis
const post = rows.filter((r) => r.wall_min >= warmupMin);
const hours = post.map((r) => r.wall_min / 60);
const stat = (key) => {
  const ys = post.map((r) => r[key]);
  const { slope } = fitLine(hours, ys);
  return { slope, min: Math.min(...ys), max: Math.max(...ys), mean: ys.reduce((a, b) => a + b, 0) / ys.length };
};
const heap = stat('heap_mb');
const dom = stat('dom_nodes');
const lis = stat('listeners');
const up = stat('uplot');
const fmt = (s, unit, d = 2) => `slope ${s.slope >= 0 ? '+' : ''}${s.slope.toFixed(d)} ${unit}/h, min ${s.min.toFixed(d)}, max ${s.max.toFixed(d)}`;
console.log(`\nSoak: ${minutes} min wall (${((minutes * speed) / 60).toFixed(1)} h of demo time at --demo-speed ${speed}), ${rows.length} samples, ${post.length} after a ${warmupMin} min warm-up`);
console.log(`  JS heap (after GC)  ${fmt(heap, 'MB')}`);
console.log(`  DOM nodes           ${fmt(dom, 'nodes', 0)}`);
console.log(`  JS event listeners  ${fmt(lis, 'listeners', 0)}`);
console.log(`  uPlot instances     ${fmt(up, 'plots', 1)}`);
// DOM nodes and listeners: a real leak grows every cycle; allow a drift of 2% of the mean per hour for noise
// (which route was last, how many events are on the timeline).
let appSlope = null;
if (snaps.length === 2) {
  const [a, b] = snaps;
  const h = (b.wall_min - a.wall_min) / 60;
  const group = (by) => {
    let app = 0;
    let other = 0;
    for (const [t, mb] of Object.entries(by)) if (APP_TYPES.has(t)) app += mb; else other += mb;
    return { app, other, code: by.code ?? 0, native: by.native ?? 0 };
  };
  const [ga, gb] = [group(a.by), group(b.by)];
  appSlope = (gb.app - ga.app) / h;
  const d = (k) => `${gb[k] - ga[k] >= 0 ? '+' : ''}${((gb[k] - ga[k]) / h).toFixed(2)} MB/h (${ga[k].toFixed(2)} -> ${gb[k].toFixed(2)} MB)`;
  console.log(`  heap snapshots at ${a.wall_min.toFixed(0)} and ${b.wall_min.toFixed(0)} min:`);
  console.log(`    app data (objects, arrays, strings, closures)  ${d('app')}`);
  console.log(`    V8 compiled code                               ${d('code')}`);
  console.log(`    browser-native objects                         ${d('native')}`);
}
if (post.length >= 3) {
  if ((appSlope ?? heap.slope) >= HEAP_SLOPE_LIMIT_MB_H) failed = true;
  if (dom.slope > 0.02 * dom.mean || lis.slope > 0.02 * lis.mean) failed = true;
}
console.log(failed ? 'FAIL: upward trend' : 'PASS: no upward trend');

writeFileSync(join(out, 'soak.svg'), plot(rows, warmupMin, { heap, dom, lis }));
console.log(`wrote ${csvPath} and ${join(out, 'soak.svg')}`);
process.exit(failed ? 1 : 0);

/** Three small multiples (one y axis each): heap, DOM nodes, listeners over wall time, with the fitted trend. */
function plot(data, warm, fits) {
  const W = 720;
  const PH = 150;
  const L = 64;
  const R = 16;
  const panels = [
    ['heap_mb', 'JS heap after GC (MB)', fits.heap, (v) => v.toFixed(1)],
    ['dom_nodes', 'DOM nodes', fits.dom, (v) => v.toFixed(0)],
    ['listeners', 'JS event listeners', fits.lis, (v) => v.toFixed(0)],
  ];
  const xMax = Math.max(1, ...data.map((r) => r.wall_min));
  const x = (m) => L + ((W - L - R) * m) / xMax;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${panels.length * (PH + 40) + 30}" font-family="system-ui, sans-serif" font-size="11">`;
  svg += `<rect width="100%" height="100%" fill="#fff"/>`;
  panels.forEach(([key, title, fit, f], p) => {
    const top = 24 + p * (PH + 40);
    const ys = data.map((r) => r[key]);
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.02, 1);
    lo -= pad;
    hi += pad;
    const y = (v) => top + PH - (PH * (v - lo)) / (hi - lo);
    svg += `<text x="${L}" y="${top - 8}" fill="#1f2328" font-weight="600">${title}</text>`;
    svg += `<text x="${W - R}" y="${top - 8}" fill="#59636e" text-anchor="end">trend ${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(key === 'heap_mb' ? 2 : 0)}${key === 'heap_mb' ? ' MB' : ''}/h after warm-up</text>`;
    for (const v of [lo + pad, hi - pad]) {
      svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#d0d7de" stroke-width="1"/>`;
      svg += `<text x="${L - 6}" y="${y(v) + 4}" fill="#59636e" text-anchor="end">${f(v)}</text>`;
    }
    svg += `<rect x="${L}" y="${top}" width="${x(warm) - L}" height="${PH}" fill="#f6f8fa"/>`;
    svg += `<polyline fill="none" stroke="#2f6fde" stroke-width="2" stroke-linejoin="round" points="${data.map((r) => `${x(r.wall_min).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ')}"/>`;
    const postRows = data.filter((r) => r.wall_min >= warm);
    if (postRows.length >= 2) {
      const h = postRows.map((r) => r.wall_min / 60);
      const { slope, intercept } = fitLine(h, postRows.map((r) => r[key]));
      const a = postRows[0].wall_min;
      const b = postRows[postRows.length - 1].wall_min;
      svg += `<line x1="${x(a)}" x2="${x(b)}" y1="${y(intercept + (slope * a) / 60)}" y2="${y(intercept + (slope * b) / 60)}" stroke="#59636e" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    }
  });
  const base = 24 + panels.length * (PH + 40) - 22;
  for (let m = 0; m <= xMax; m += xMax > 240 ? 120 : xMax > 60 ? 30 : 10) {
    svg += `<text x="${x(m)}" y="${base}" fill="#59636e" text-anchor="middle">${m} min</text>`;
  }
  svg += `<text x="${L}" y="${base + 18}" fill="#59636e">Wall time (shaded: warm-up, excluded from the trend). Dashed: least-squares trend. Demo time runs ${speed}x faster.</text>`;
  return `${svg}</svg>\n`;
}
