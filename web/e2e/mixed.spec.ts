/// <reference lib="dom" />
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const MIXED = `http://127.0.0.1:${process.env.E2E_MIXED_PORT ?? 9703}`;
const GPU_SECTION = /^GPU \d+$/;

test('a multi-GPU workstation shows one live section per GPU', async ({ page }) => {
  await page.goto(`${MIXED}/node/ws1/gpu`);
  const sections = page.getByRole('region', { name: GPU_SECTION });
  await expect(sections).toHaveCount(4, { timeout: 15_000 });
  for (let i = 0; i < 4; i++) {
    const section = page.getByRole('region', { name: `GPU ${i}`, exact: true });
    await expect(section.getByText('NVIDIA RTX 6000 Ada Generation')).toBeVisible();
    await expect(section.locator('.stat', { hasText: 'Utilisation' })).toContainText(/\d+\s*%/);
  }
  await expect(page.getByRole('heading', { name: 'All GPUs' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(results.violations.map((v) => `${v.impact ?? ''} ${v.id}: ${v.help}`)).toEqual([]);
});

test('a GB10 on the same console keeps the single-GPU layout', async ({ page }) => {
  await page.goto(`${MIXED}/node/spark1/gpu`);
  await expect(page.getByRole('region', { name: /now$/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Clock limits' })).toBeVisible();
  await expect(page.getByRole('region', { name: GPU_SECTION })).toHaveCount(0);
});

test('long GPU names on Thermals & Power wrap, so every reading stays in view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${MIXED}/node/ws1/thermals`);
  const table = page.locator('.tp-sensors').first();
  await expect(table.getByRole('rowheader', { name: 'NVIDIA RTX 6000 Ada Generation #3' })).toBeVisible({ timeout: 15_000 });
  await expect(table.getByRole('columnheader', { name: 'Headroom' })).toBeVisible();
  const overflow = await table.evaluate((t) => (t.parentElement ? t.parentElement.scrollWidth - t.parentElement.clientWidth : 0));
  expect(overflow).toBe(0);
});

for (const width of [375, 1440]) {
  test(`each GPU's energy footer keeps its time span on one line at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${MIXED}/node/ws1/gpu`);
    const footers = page.locator('.ngpu-section .stat', { hasText: 'Energy since driver load' }).locator('.stat__footer');
    await expect(footers).toHaveCount(4, { timeout: 15_000 });
    for (const footer of await footers.all()) {
      await expect(footer).toHaveText(/last\s\d+\s\w+/, { timeout: 15_000 });
      const lines = await footer.evaluate((el) => {
        const rows: { top: number; words: string[] }[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (const m of (n.textContent ?? '').matchAll(/\S+/g)) {
            const r = document.createRange();
            r.setStart(n, m.index);
            r.setEnd(n, m.index + m[0].length);
            const top = Math.round(r.getBoundingClientRect().top);
            const row = rows.find((x) => Math.abs(x.top - top) < 4);
            if (row) row.words.push(m[0]);
            else rows.push({ top, words: [m[0]] });
          }
        }
        return rows.map((x) => x.words.join(' '));
      });
      expect(lines.some((l) => /last \d+ \w+/.test(l)), JSON.stringify(lines)).toBe(true);
    }
  });
}

interface RunJson {
  id: string;
  status: string;
  results: { metric: string; label: string; extras: Record<string, unknown> }[];
}

const STREAMS_NOTE = 'For ws1, token rates and timings are modelled on GB10, not measured.';
const TOOL_EVAL_NOTE = 'For ws1, timings and the Responsiveness and Deployability scores are modelled on GB10, not measured.';
const FOOTNOTE = 'For ws1, figures marked † are modelled on GB10, not measured.';

async function startRun(page: Page, bench: string, nodes: string[], params: Record<string, unknown>): Promise<string> {
  const res = await page.request.post(`${MIXED}/api/v1/bench/runs`, { data: { bench_id: bench, nodes, params, confirm: true } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as RunJson).id;
}

const getRun = async (page: Page, id: string) => (await (await page.request.get(`${MIXED}/api/v1/bench/runs/${id}`)).json()) as RunJson;

async function succeeded(page: Page, id: string): Promise<RunJson> {
  await expect.poll(async () => (await getRun(page, id)).status, { timeout: 90_000 }).toBe('succeeded');
  return getRun(page, id);
}

async function resultRows(page: Page, run: RunJson) {
  await page.goto(`${MIXED}/benchmarks/runs/${run.id}`);
  const table = page.getByRole('region', { name: 'Results' }).getByRole('table');
  await expect(table).toBeVisible({ timeout: 15_000 });
  const rows = await table.locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => {
      const cell = tr.querySelector('.bench-res__metric > span');
      return { label: cell?.firstChild?.textContent ?? '', marked: (cell?.textContent ?? '').includes('†'), height: tr.getBoundingClientRect().height };
    }),
  );
  return new Map(run.results.map((r) => [r.metric, rows.find((x) => x.label === r.label)]));
}

async function compareWithSpark1(page: Page, bench: string, params: Record<string, unknown>, note: string, live: boolean): Promise<RunJson> {
  const spark1 = await startRun(page, bench, ['spark1'], params);
  const ws1 = await startRun(page, bench, ['ws1'], params);
  await page.setViewportSize({ width: 1440, height: 900 });
  if (live) {
    await page.goto(`${MIXED}/benchmarks/runs/${ws1}`);
    await expect(page.getByRole('progressbar', { name: 'Benchmark progress' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(note)).toBeVisible();
  }
  const run = await succeeded(page, ws1);
  const twin = await succeeded(page, spark1);
  const modelled = new Set(run.results.filter((r) => r.extras.modelled_on === 'GB10').map((r) => r.metric));
  expect(modelled.size).toBeGreaterThan(0);
  expect(run.results.filter((r) => /modelled/i.test(r.label))).toEqual([]);

  const wide = await resultRows(page, run);
  await expect(page.getByText(note)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Results' }).getByText(FOOTNOTE)).toBeVisible();
  for (const [metric, row] of wide) {
    expect(row, metric).toBeDefined();
    expect(row?.marked, metric).toBe(modelled.has(metric));
    expect(row?.label, metric).not.toMatch(/modelled/i);
  }

  await page.setViewportSize({ width: 375, height: 900 });
  const narrow = await resultRows(page, run);
  const theirs = await resultRows(page, twin);
  const compared = [...narrow].filter(([metric]) => theirs.has(metric));
  expect(compared.length).toBe(narrow.size);
  for (const [metric, row] of compared) expect(row?.height, metric).toBeLessThanOrEqual((theirs.get(metric)?.height ?? 0) + 0.5);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${MIXED}/benchmarks/runs/${run.id}`);
  return run;
}

async function openFinished(page: Page, id: string) {
  await page.goto(`${MIXED}/benchmarks/runs/${id}`);
  await expect(page.getByRole('region', { name: 'Results' }).getByRole('table')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return {
    heads: page.getByRole('region', { name: 'Result', exact: true }).getByRole('listitem'),
    rows: page.getByRole('region', { name: 'Results' }).locator('tbody tr'),
  };
}

/** Each † in these elements, with the visible characters its box covers. */
const daggerCovers = (scopes: Locator) =>
  scopes.evaluateAll((els) =>
    els.flatMap((el) => {
      const glyphs: { c: string; box: DOMRect }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('.visually-hidden')) continue;
        const text = n.textContent ?? '';
        for (let i = 0; i < text.length; i++) {
          if (/\s/.test(text.charAt(i))) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          glyphs.push({ c: text.charAt(i), box: r.getBoundingClientRect() });
        }
      }
      const overlap = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.25 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.25;
      return glyphs.filter((g) => g.c === '†').map((d) => ({ in: el.textContent, covers: glyphs.filter((g) => g !== d && overlap(g.box, d.box)).map((g) => g.c).join('') }));
    }),
  );

/** Height by the label's own text, plus the Node column for a row. */
const heightsBy = (scopes: Locator, label: string) =>
  scopes.evaluateAll(
    (els, sel) => Object.fromEntries(els.map((el) => [`${el.querySelector(sel)?.firstChild?.textContent ?? ''}|${el instanceof HTMLTableRowElement ? (el.cells[1]?.textContent ?? '') : ''}`, el.getBoundingClientRect().height])),
    label,
  );

test.describe.serial('figures ws1 shows from the GB10 model', () => {
  test("a † never covers the text beside it, and no ws1 headline or row is taller than spark1's", async ({ page }) => {
    test.setTimeout(120_000);
    const ws1First = await startRun(page, 'llm-inference', ['ws1', 'spark1'], { requests: 2 });
    await succeeded(page, ws1First);
    const spark1First = await startRun(page, 'llm-inference', ['spark1', 'ws1'], { requests: 2 });
    await succeeded(page, spark1First);

    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const { heads, rows } = await openFinished(page, ws1First);
      const marks = await daggerCovers(heads.or(rows));
      expect(marks.length, `${width} px`).toBeGreaterThanOrEqual(8);
      expect(marks.filter((m) => m.covers), `${width} px`).toEqual([]);
    }

    await page.setViewportSize({ width: 375, height: 900 });
    const { heads, rows } = await openFinished(page, ws1First);
    const rowHeight = await heightsBy(rows, '.bench-res__metric > span');
    const ws1Rows = Object.entries(rowHeight).filter(([k]) => k.endsWith('|ws1'));
    for (const [k, h] of ws1Rows) {
      const twin = rowHeight[k.replace(/\|ws1$/, '|spark1')];
      if (twin !== undefined) expect(h, k).toBeLessThanOrEqual(twin + 0.5);
    }
    expect(ws1Rows.length).toBeGreaterThanOrEqual(5);
    const ws1Heads = await heightsBy(heads, '.bench-head__label');
    const spark1Heads = await heightsBy((await openFinished(page, spark1First)).heads, '.bench-head__label');
    expect(Object.keys(ws1Heads).sort()).toEqual(Object.keys(spark1Heads).sort());
    for (const [k, h] of Object.entries(ws1Heads)) expect(h, k).toBeLessThanOrEqual((spark1Heads[k] ?? 0) + 0.5);
  });

  test('llm-inference names them in the note, the headlines, the Results rows, Metadata and the share card', async ({ page }) => {
    test.setTimeout(120_000);
    await compareWithSpark1(page, 'llm-inference', { requests: 2 }, STREAMS_NOTE, false);
    await expect(page.getByRole('region', { name: 'Result', exact: true }).getByText(FOOTNOTE)).toBeVisible();
    const meta = page.getByRole('region', { name: 'Metadata' });
    await expect(meta.locator('.bench-meta > div', { hasText: 'Modelled on' })).toContainText('GB10');
    await page.waitForFunction(() => [...document.querySelectorAll('.shell__page')].every((el) => getComputedStyle(el).opacity === '1'));
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    expect(results.violations.map((v) => `${v.impact ?? ''} ${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
    await page.getByRole('region', { name: 'Results' }).getByRole('button', { name: 'Share card' }).click();
    await expect(page.getByRole('dialog', { name: 'Share card' }).getByRole('img')).toHaveAttribute('alt', /Decode tokens\/s per request [\d.]+ tok\/s \(modelled on GB10\)/);
  });

  test('a concurrency sweep says so live and finished', async ({ page }) => {
    test.setTimeout(120_000);
    await compareWithSpark1(page, 'llm-inference', { concurrency: 2, requests: 2, sweep: true }, STREAMS_NOTE, true);
  });

  test('llm-showcase says so above its outputs', async ({ page }) => {
    test.setTimeout(120_000);
    await compareWithSpark1(page, 'llm-showcase', { streams: 2, max_tokens: 64 }, STREAMS_NOTE, false);
  });

  test('tool-eval says which timings and scores are modelled, live and finished', async ({ page }) => {
    test.setTimeout(180_000);
    await compareWithSpark1(page, 'tool-eval', { suite: 'core' }, TOOL_EVAL_NOTE, true);
  });

  test('thermal soak is ws1\'s own telemetry, so nothing says modelled', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await startRun(page, 'thermal-soak', ['ws1'], { minutes: 1 });
    await page.goto(`${MIXED}/benchmarks/runs/${id}`);
    await expect(page.getByRole('progressbar', { name: 'Benchmark progress' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/modelled/i)).toHaveCount(0);
    await succeeded(page, id);
    await expect(page.getByRole('region', { name: 'Results' }).getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/modelled|†/i)).toHaveCount(0);
  });
});
