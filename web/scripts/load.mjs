// Initial load on a LAN profile (100 Mbps, 2 ms RTT, cold cache): time to first contentful paint and to an overview
// showing live numbers on every node card, median of N fresh browser contexts, at 1x and 4x CPU throttling.
//
//   npm run build && node scripts/load.mjs [--runs 5] [--throttle 1,4] [--port 9713] [--dist dist]
import { chromium } from '@playwright/test';
import { option, quantile, startDemo, waitLive } from './lib.mjs';

const runs = Number(option('runs', 5));
const throttles = String(option('throttle', '1,4')).split(',').map(Number);
const port = Number(option('port', process.env.PERF_PORT ?? 9713));
const dist = option('dist', process.env.PERF_DIST);
const LAN = { offline: false, latency: 2, downloadThroughput: (100e6 / 8) | 0, uploadThroughput: (100e6 / 8) | 0 };

/** Runs before the app: note the first moment the overview shows live numbers. */
function watchLive() {
  const check = () => {
    const cards = [...document.querySelectorAll('.ov-card')];
    const live = cards.filter((c) => /\d/.test(c.querySelector('.ov-card__stats .num')?.textContent ?? '')).length;
    if (live >= 2) window.__liveAt = performance.now();
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

const demo = await startDemo({ port, ...(dist ? { dist } : {}) });
const browser = await chromium.launch();
const rows = [];
try {
  for (const rate of throttles) {
    const fcp = [];
    const live = [];
    let bytes = 0;
    for (let i = 0; i < runs; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(watchLive);
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', LAN);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      let jsBytes = 0;
      cdp.on('Network.loadingFinished', (e) => { jsBytes += e.encodedDataLength; });
      await page.goto(demo.url);
      await waitLive(page, 60_000);
      const t = await page.evaluate(() => ({
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? NaN,
        live: window.__liveAt ?? NaN,
      }));
      fcp.push(t.fcp);
      live.push(t.live);
      bytes = jsBytes;
      await ctx.close();
    }
    const sorted = (xs) => xs.filter(Number.isFinite).sort((a, b) => a - b);
    fcp.splice(0, fcp.length, ...sorted(fcp));
    live.splice(0, live.length, ...sorted(live));
    const row = { throttle: rate, fcpMedian: Math.round(quantile(fcp, 0.5)), liveMedian: Math.round(quantile(live, 0.5)), liveMax: Math.round(live[live.length - 1]), transferKb: +(bytes / 1024).toFixed(0) };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  await browser.close();
  await demo.stop();
}
console.log('\n| CPU | first contentful paint (median) | overview with live numbers (median / worst) | bytes on the wire until live |');
console.log('|---|---|---|---|');
for (const r of rows) console.log(`| ${r.throttle}x | ${r.fcpMedian} ms | ${r.liveMedian} / ${r.liveMax} ms | ${r.transferKb} KB |`);
