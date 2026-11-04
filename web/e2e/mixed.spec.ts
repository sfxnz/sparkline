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
