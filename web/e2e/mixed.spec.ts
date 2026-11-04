/// <reference lib="dom" />
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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
