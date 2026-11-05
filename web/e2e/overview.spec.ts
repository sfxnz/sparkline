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
        await expect.poll(() => footer(label).evaluate(shows, 'excl.\u00a0spark2'), { message: `${label} footer shows "excl. spark2" at ${width} px` }).toBe(true);
      }
    }
  });
}

interface GpuReading { index: number; temp_c?: number | null }

interface StubNode { id: string; platform: 'gb10' | 'workstation'; gpus?: (g: GpuReading) => GpuReading | null; gaps?: unknown[]; errors?: Record<string, string> }

async function stubbed(page: Page, nodes: StubNode[]) {
  const now = Date.now() / 1000;
  const infoOf = (n: StubNode) => {
    const base = fixture(`platforms/${n.platform}/info.json`);
    return { ...base, node_id: n.id, unsupported: [...(base.unsupported as unknown[]), ...(n.gaps ?? [])] };
  };
  await page.route('**/api/**', (route) => route.fulfill({ status: 502, body: '' }));
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/v1/live**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.routeWebSocket('**/api/v1/stream', (ws) => {
    ws.send(JSON.stringify({
      type: 'hello',
      cluster: {
        nodes: nodes.map((n) => ({ node_id: n.id, url: '', status: 'online', since: now, last_sample_ts: now, error: null, info: infoOf(n), next_retry_ts: null })),
        settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
        demo: true,
        version: 'test',
        server_time: now,
      },
    }));
    for (const n of nodes) {
      const reading = fixture(`platforms/${n.platform}/sample.json`);
      const gpu = (reading.gpu as GpuReading[]).flatMap((g) => n.gpus?.(g) ?? (n.gpus ? [] : g));
      ws.send(JSON.stringify({ type: 'sample', node_id: n.id, sample: { ...reading, node_id: n.id, ts: now, gpu, errors: n.errors ?? {} } }));
    }
  });
}

const workstation = (page: Page, gpus: (g: GpuReading) => GpuReading, gaps: unknown[] = []) => stubbed(page, [{ id: 'ws1', platform: 'workstation', gpus, gaps }]);

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

/** The visible " · " separators in `el` that start a line: each should share a line with the word before it. */
const strandedSeparators = (el: Element) => {
  const words: { text: string; top: number; block: Element | null }[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.checkVisibility() || n.parentElement.closest('.visually-hidden')) continue;
    let block: Element | null = n.parentElement;
    while (block && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement;
    for (const m of (n.textContent ?? '').matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      words.push({ text: m[0], top: Math.round(range.getBoundingClientRect().top), block });
    }
  }
  return words.flatMap((w, i) => {
    const before = words[i - 1];
    return w.text === '·' && before?.block === w.block && Math.abs(before.top - w.top) > 4 ? [`· after "${before.text}"`] : [];
  });
};

for (const [state, temp] of [['heating up', 88], ['at slowdown', 94]] as const) {
  test(`the ws1 card never starts a line with a separator while GPU 3 is ${state}`, async ({ page }) => {
    await workstation(page, (g) => (g.index === 3 ? { ...g, temp_c: temp } : g));
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Node ws1' });
    await expect(card).toContainText('GPU 3');
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => card.evaluate(strandedSeparators), { message: `separators starting a line at ${String(width)} px` }).toEqual([]);
    }
  });
}

const LOST_GPU0 = [{ metric: 'gpu0', reason: 'NVML could not open GPU 0 (NVML: GPU is lost)', kind: 'hardware' }];

for (const [state, temp] of [['calm', 77], ['heating up', 89], ['at slowdown', 94]] as const) {
  test(`the ws1 card says its temperature reads 3 of 4 GPUs while GPU 0 is lost and GPU 3 is ${state}`, async ({ page }) => {
    await workstation(page, (g) => (g.index === 0 ? { index: 0 } : g.index === 3 ? { ...g, temp_c: temp } : g), LOST_GPU0);
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Node ws1' });
    await expect(card).toContainText('GPU temp');
    const stats = card.locator('.ov-card__stats');
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => stats.evaluate(paintsInFull, '3 of 4 GPUs'), { message: `"3 of 4 GPUs" under the temperature at ${String(width)} px` }).toBe(true);
    }
  });
}

for (const [state, temp, flag, gaps] of [
  ['heating up', 89, 'headroom', []],
  ['at slowdown', 94, 'At slowdown', []],
  ['heating up beside a lost GPU 0', 89, 'headroom', LOST_GPU0],
  ['at slowdown beside a lost GPU 0', 94, 'At slowdown', LOST_GPU0],
] as const) {
  test(`the ws1 card paints its flag in full at every width from 320 to 1440 px while GPU 3 is ${state}`, async ({ page }) => {
    await workstation(page, (g) => (gaps.length && g.index === 0 ? { index: 0 } : g.index === 3 ? { ...g, temp_c: temp } : g), [...gaps]);
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Node ws1' });
    await expect(card).toContainText(flag);
    const stats = card.locator('.ov-card__stats');
    const texts = [flag, 'GPU 3', ...(gaps.length ? ['3 of 4 GPUs'] : [])];
    const clipped: string[] = [];
    const sweep = Array.from({ length: 141 }, (_, i) => 320 + 8 * i);
    for (const width of [...sweep, 455, 460, 465, 470, 650]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      for (const text of texts) if (!(await stats.evaluate(paintsInFull, text))) clipped.push(`"${text}" at ${String(width)} px`);
    }
    expect(clipped).toEqual([]);
  });
}

test('the ws1 card paints "3 of 4 GPUs" in its utilisation sparkline caption on a phone and a laptop while GPU 0 is lost', async ({ page }) => {
  await workstation(page, (g) => (g.index === 0 ? { index: 0 } : g), LOST_GPU0);
  await page.goto('/');
  const caption = page.getByRole('region', { name: 'Node ws1' }).locator('.ov-spark__label').first();
  await expect(caption).toContainText('3 of 4 GPUs');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const text of ['GPU utilisation', '3 of 4 GPUs', '3 min']) {
      await expect.poll(() => caption.evaluate(paintsInFull, text), { message: `caption shows "${text}" in full at ${String(width)} px` }).toBe(true);
    }
  }
});

test('the ws1 card paints its plain headroom line in full at every width from 300 to 1440 px', async ({ page }) => {
  await workstation(page, (g) => g);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Node ws1' });
  await expect(card).toContainText('headroom');
  const stats = card.locator('.ov-card__stats');
  const clipped: string[] = [];
  for (const width of [...Array.from({ length: 31 }, (_, i) => 300 + 4 * i), 480, 640, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    if (!(await stats.evaluate(paintsInFull, 'headroom'))) clipped.push(`"headroom" at ${String(width)} px`);
  }
  expect(clipped).toEqual([]);
});

test('a healthy GB10 card keeps its plain headroom line beside its temperature at 375 px, as before the narrow-column rule', async ({ page }) => {
  await stubbed(page, [{ id: 'spark1', platform: 'gb10' }]);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Node spark1' });
  await expect(card).toContainText('headroom');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(card.locator('.ov-stat__headroom'), `headroom in the temperature stat at ${String(width)} px`).toBeVisible();
    await expect(card.locator('.ov-card__headroom'), `no headroom row under the stats at ${String(width)} px`).toBeHidden();
  }
});

const lineStarts = (el: Element) => [...el.querySelectorAll('.unsupported__line')].map((line) => {
  const range = document.createRange();
  range.selectNodeContents(line);
  const lefts = [...range.getClientRects()].reduce<{ top: number; left: number }[]>((rows, r) => {
    const row = rows.find((x) => Math.abs(x.top - r.top) < 2);
    if (row) row.left = Math.min(row.left, r.left);
    else rows.push({ top: r.top, left: r.left });
    return rows;
  }, []).sort((a, b) => a.top - b.top).map((r) => Math.round(r.left));
  return { lefts, em: parseFloat(getComputedStyle(line).fontSize) };
});

test("a tooltip over several nodes indents each line's wrapped part under its first word", async ({ page }) => {
  await stubbed(page, ['ws1', 'ws2'].map((id) => ({ id, platform: 'workstation', gpus: () => null, errors: { gpu: `nvml: RuntimeError: the NVIDIA driver on ${id} stopped answering every query this tick` } })));
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/');
  const tip = page.locator('.tooltip', { hasText: 'ws1: ' }).filter({ hasText: 'ws2: ' }).first();
  await expect(tip, 'a tooltip names both nodes').toBeAttached();
  await tip.locator('xpath=..').getByRole('button', { name: 'Why is this not reported?' }).focus();
  await expect(tip).toBeVisible();
  const lines = await tip.evaluate(lineStarts);
  const wrapped = lines.filter((l) => l.lefts.length > 1);
  expect(wrapped.length, 'at least one tooltip line wraps at 375 px').toBeGreaterThan(0);
  for (const l of wrapped) for (const left of l.lefts.slice(1)) expect(left - (l.lefts[0] ?? 0)).toBeCloseTo(l.em, 0);
});
