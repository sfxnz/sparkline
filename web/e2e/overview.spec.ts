/// <reference lib="dom" />
// (DOM types: page.evaluate callbacks run in the browser.)
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const fixture = (path: string) => JSON.parse(readFileSync(new URL(`../src/test/fixtures/${path}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const sample = fixture('sample.json');

/**
 * A stubbed two-node console where spark2 reports no memory (mem_total 0) and its energy history fails to load, so
 * both the memory and the energy totals leave spark2 out. `linked` gives the nodes an interconnect, which puts the
 * totals in the narrower column beside the interconnect panel.
 */
async function partialCluster(page: Page, linked: boolean) {
  const now = Date.now() / 1000;
  const net = (peer: string) => (linked ? [{ name: 'rdma0', role: 'interconnect', label: 'QSFP 1', mac: null, ipv4: [], speed_mbps: 200_000, rdma_device: null, counter_source: 'netdev_rdma', peer }] : []);
  const info = (id: string, peer: string, memTotal: number) => ({
    schema_version: 1, node_id: id, hostname: id, agent_version: 'test', os: 'Linux', kernel: '6', driver: null, cuda: null, nvml: null,
    cpu_model: 'cpu', cores: [], mem_total: memTotal, swap_total: 0, gpus: [], net: net(peer), disks: [], sensors: [],
    unsupported: memTotal ? [] : [{ metric: 'mem', reason: 'No memory reading', kind: 'hardware' }], tools: {}, sample_interval_ms: 1000, boot_time: now - 3600,
  });
  await page.route('**/api/**', (route) => route.fulfill({ status: 502, body: '' }));
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/v1/live**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/history?**', (route) =>
    new URL(route.request().url()).searchParams.get('node') === 'spark1'
      ? route.fulfill({ json: { node_id: 'spark1', resolution_s: 60, ts: [now - 120, now - 60], series: { 'gpu0.energy_j': [123_000_000, 123_100_000] }, min: {}, max: {} } })
      : route.fulfill({ status: 502, body: '' }),
  );
  await page.routeWebSocket('**/api/v1/stream', (ws) => {
    ws.send(JSON.stringify({
      type: 'hello',
      cluster: {
        nodes: [info('spark1', 'spark2', 130_676_342_784), info('spark2', 'spark1', 0)].map((i) => ({
          node_id: i.node_id, url: '', status: 'online', since: now, last_sample_ts: now, error: null, info: i, next_retry_ts: null,
        })),
        settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
        demo: true,
        version: 'test',
        server_time: now,
      },
    }));
    for (const id of ['spark1', 'spark2']) ws.send(JSON.stringify({ type: 'sample', node_id: id, sample: { ...sample, node_id: id, ts: now } }));
  });
}

/** Whether the last character of `text` inside `el` is painted inside `el` (not cut off by overflow, an ellipsis or a line clamp). */
const shows = (el: Element, text: string) => {
  el.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.textContent?.indexOf(text) ?? -1;
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(n, at + text.length - 1);
    range.setEnd(n, at + text.length);
    const r = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const inside = r.left >= box.left && r.right <= box.right + 0.5 && r.top >= box.top && r.bottom <= box.bottom + 0.5;
    return inside && el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight;
  }
  return false;
};

for (const linked of [false, true]) {
  test(`cluster totals always show which node they leave out (${linked ? 'beside the interconnect' : 'full width'})`, async ({ page }) => {
    await partialCluster(page, linked);
    await page.goto('/');
    const totals = page.getByRole('region', { name: 'Cluster totals' });
    await expect(page.locator('.ov-pair')).toHaveClass(linked ? /^ov-pair$/ : /ov-pair--single/);
    const footer = (label: string) => totals.locator('.stat').filter({ hasText: label }).locator('.stat__footer');
    await expect(footer('Unified memory in use')).toContainText('excl. spark2');
    await expect(footer('GPU power')).toContainText('excl. spark2');
    for (const width of [1680, 1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const label of ['Unified memory in use', 'GPU power']) {
        await expect.poll(() => footer(label).evaluate(shows, 'excl. spark2'), { message: `${label} footer shows "excl. spark2" at ${width} px` }).toBe(true);
      }
    }
  });
}

interface GpuReading { index: number; temp_c?: number | null }

/** A stubbed console with one node, ws1 (four RTX 6000 Ada, slowdown 93 °C), whose GPUs read as `gpus` makes them. */
async function workstation(page: Page, gpus: (g: GpuReading) => GpuReading) {
  const now = Date.now() / 1000;
  const info = { ...fixture('platforms/workstation/info.json'), node_id: 'ws1' };
  const reading = fixture('platforms/workstation/sample.json');
  await page.route('**/api/**', (route) => route.fulfill({ status: 502, body: '' }));
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/v1/live**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.routeWebSocket('**/api/v1/stream', (ws) => {
    ws.send(JSON.stringify({
      type: 'hello',
      cluster: {
        nodes: [{ node_id: 'ws1', url: '', status: 'online', since: now, last_sample_ts: now, error: null, info, next_retry_ts: null }],
        settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
        demo: true,
        version: 'test',
        server_time: now,
      },
    }));
    ws.send(JSON.stringify({ type: 'sample', node_id: 'ws1', sample: { ...reading, node_id: 'ws1', ts: now, gpu: (reading.gpu as GpuReading[]).map(gpus) } }));
  });
}

/** Whether `el` paints `text` in full: a visible copy lies inside every box above it that clips (overflow, line clamp). */
const paintsInFull = (el: Element, text: string) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.textContent?.indexOf(text) ?? -1;
    if (at < 0 || !n.parentElement?.checkVisibility()) continue;
    const range = document.createRange();
    range.setStart(n, at);
    range.setEnd(n, at + text.length);
    const r = range.getBoundingClientRect();
    let inside = true;
    for (let box = n.parentElement as Element | null; box && box !== el.parentElement; box = box.parentElement) {
      const style = getComputedStyle(box);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const b = box.getBoundingClientRect();
      inside &&= r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
    }
    if (inside) return true;
  }
  return false;
};

test('the ws1 card shows GPU 3 at slowdown in full on a phone and a laptop', async ({ page }) => {
  await workstation(page, (g) => (g.index === 3 ? { ...g, temp_c: 94 } : g));
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Node ws1' });
  await expect(card).toContainText('At slowdown');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const text of ['At slowdown', 'GPU 3']) {
      await expect.poll(() => card.evaluate(paintsInFull, text), { message: `ws1 card shows "${text}" in full at ${String(width)} px` }).toBe(true);
    }
  }
});
