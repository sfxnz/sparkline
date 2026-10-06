/// <reference lib="dom" />
// Benchmark flows against the demo console (simulated, time-compressed runs; nothing touches real hardware):
// configure -> confirm -> live progress -> results -> baseline -> compare -> export, the cancel flow, parameter
// validation, and axe on every benchmark screen in both themes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

interface RunRow {
  id: string;
  bench_id: string;
  status: string;
}
interface Spec {
  id: string;
  name: string;
  params: { name: string; label: string; min: number | null; max: number | null }[];
}

/** Names, labels and bounds come from the console's catalog (the backend owns that copy), never hard-coded. */
async function catalog(page: Page): Promise<Record<string, Spec>> {
  const res = await page.request.get('/api/v1/bench/catalog');
  expect(res.ok()).toBe(true);
  return Object.fromEntries(((await res.json()) as Spec[]).map((s) => [s.id, s]));
}
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function ready(page: Page) {
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^spark1/ })).toBeVisible({ timeout: 15_000 });
}

async function catalogReady(page: Page) {
  await ready(page);
  await expect(page.locator('.bench-card').first()).toBeVisible({ timeout: 15_000 });
}

async function axeViolations(page: Page) {
  // A route change fades the page in: let it settle so contrast is measured on the final colours.
  await page.waitForFunction(() => [...document.querySelectorAll('.shell__page')].every((el) => getComputedStyle(el).opacity === '1'));
  await page.waitForTimeout(300); // dialogs fade in with CSS transitions
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  return results.violations.map((v) => `${v.impact ?? ''} ${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')})`);
}

async function seededRuns(page: Page): Promise<RunRow[]> {
  const res = await page.request.get('/api/v1/bench/runs?limit=200');
  expect(res.ok()).toBe(true);
  return (await res.json()) as RunRow[];
}

// The flows start real (simulated) runs on the shared demo, so they run one after another.
test.describe.serial('benchmark flows', () => {
  test('configure, confirm, watch it run, set a baseline, export and compare', async ({ page }) => {
    const mm = (await catalog(page))['gpu-matmul'];
    if (!mm) throw new Error('gpu-matmul missing from the catalog');
    const iters = mm.params.find((p) => p.name === 'iterations');
    await page.goto('/benchmarks');
    await catalogReady(page);
    await page.getByRole('button', { name: `Configure ${mm.name}…` }).click();
    const dialog = page.getByRole('dialog', { name: `Configure ${mm.name}` });
    await expect(dialog).toBeVisible();
    if (iters) await dialog.getByLabel(iters.label).fill(String(iters.min ?? 10)); // shortest run
    await expect(dialog.getByText(/Estimated/)).toBeVisible();
    await dialog.getByRole('button', { name: /Review & run/ }).click();

    const confirm = page.getByRole('dialog', { name: `Run ${mm.name}?` });
    await expect(confirm.getByText(`Runs ${mm.name} on spark1.`)).toBeVisible();
    await expect(confirm.getByText(/Thermal/).first()).toBeVisible();
    await expect(confirm.getByText('You can cancel at any time; cancelling cleans up containers and temp files.')).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Back' })).toBeFocused(); // never straight onto Run
    await confirm.getByRole('button', { name: 'Run benchmark' }).click();

    // Optimistic: the run view at once, then the console's id.
    await expect(page).toHaveURL(/\/benchmarks\/runs\//);
    await expect(page.getByRole('heading', { name: mm.name, level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/\/benchmarks\/runs\/[0-9a-z]+$/, { timeout: 10_000 });
    await expect(page.getByRole('progressbar', { name: 'Benchmark progress' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Live telemetry' })).toBeVisible();
    expect(await axeViolations(page), 'running').toEqual([]);

    await expect(page.getByText(/^Completed in /)).toBeVisible({ timeout: 30_000 });
    const results = page.getByRole('region', { name: 'Results' });
    await expect(results.getByRole('table')).toContainText('BF16');
    await expect(results.getByRole('table')).toContainText('TFLOPS');
    const runId = page.url().split('/').pop() ?? '';

    await results.getByRole('button', { name: 'Set as baseline' }).click();
    await expect(results.getByText('This run is the baseline')).toBeVisible();

    const json = page.waitForEvent('download');
    await results.getByRole('link', { name: 'JSON' }).click();
    expect((await json).suggestedFilename()).toMatch(/\.json$/);
    const csv = page.waitForEvent('download');
    await results.getByRole('link', { name: 'CSV' }).click();
    expect((await csv).suggestedFilename()).toMatch(/\.csv$/);

    await results.getByRole('button', { name: 'Share card' }).click();
    const share = page.getByRole('dialog', { name: 'Share card' });
    await expect(share.getByRole('img', { name: new RegExp(`Sparkline share card: ${esc(mm.name)}`) })).toBeVisible();
    const png = page.waitForEvent('download');
    await share.getByRole('link', { name: 'Download PNG' }).click();
    expect((await png).suggestedFilename()).toMatch(/^sparkline-gpu-matmul-.*\.png$/);
    await page.keyboard.press('Escape');

    // History -> tick this run and an older GPU matmul run -> compare.
    await page.getByRole('link', { name: 'All benchmarks' }).click();
    await page.getByLabel('Filter by benchmark').selectOption('gpu-matmul');
    const boxes = page.getByRole('checkbox', { name: new RegExp(`^Select ${esc(mm.name)} run`) });
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.getByRole('button', { name: /^Compare 2$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/benchmarks/compare\\?ids=${runId},`));
    await expect(page.getByRole('region', { name: 'Side by side' }).getByRole('table')).toContainText('BF16');
  });

  test('a running benchmark can be cancelled, and says what cancelling does', async ({ page }) => {
    const soak = (await catalog(page))['thermal-soak'];
    if (!soak) throw new Error('thermal-soak missing from the catalog');
    await page.goto('/benchmarks');
    await catalogReady(page);
    await page.getByRole('button', { name: `Configure ${soak.name}…` }).click();
    const dialog = page.getByRole('dialog', { name: `Configure ${soak.name}` });
    await dialog.getByRole('checkbox', { name: /spark1/ }).uncheck();
    await dialog.getByRole('checkbox', { name: /spark2/ }).check();
    await dialog.getByRole('button', { name: /Review & run/ }).click();
    await page.getByRole('dialog', { name: `Run ${soak.name}?` }).getByRole('button', { name: 'Run benchmark' }).click();
    await expect(page).toHaveURL(/\/benchmarks\/runs\/[0-9a-z]+$/, { timeout: 10_000 });
    await expect(page.getByRole('progressbar', { name: 'Benchmark progress' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel run' }).click();
    const confirm = page.getByRole('dialog', { name: `Stop ${soak.name}?` });
    await expect(confirm.getByText('Stops the benchmark on spark2 and removes its containers and temp files. Partial results are discarded.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Stop benchmark' }).click();
    await expect(page.getByText(/^The benchmark was stopped after/)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.bench-run__title-row')).toContainText('Cancelled');
    await expect(page.getByRole('progressbar', { name: 'Benchmark progress' })).toHaveCount(0);
  });
});

test('parameters are validated before the confirmation step', async ({ page }) => {
  const mm = (await catalog(page))['gpu-matmul'];
  const iters = mm?.params.find((p) => p.name === 'iterations');
  if (!mm || iters?.min == null || iters.max == null) throw new Error('gpu-matmul iterations bounds missing');
  await page.goto('/benchmarks');
  await catalogReady(page);
  await page.getByRole('button', { name: `Configure ${mm.name}…` }).click();
  const dialog = page.getByRole('dialog', { name: `Configure ${mm.name}` });
  await dialog.getByLabel(iters.label).fill(String(iters.max + 1));
  await expect(dialog.getByText(`Must be between ${iters.min} and ${iters.max}`)).toBeVisible(); // inline, as soon as it is typed
  const review = dialog.getByRole('button', { name: /Review & run/ });
  await expect(review).toHaveAttribute('aria-disabled', 'true');
  await review.click({ force: true }); // still focusable and clickable: it only re-states the errors
  await expect(page.getByRole('dialog', { name: `Run ${mm.name}?` })).toHaveCount(0);
  await expect(dialog.getByLabel(iters.label)).toHaveAttribute('aria-invalid', 'true');
});

test('closing the configure dialog returns focus to its Configure button', async ({ page }) => {
  const mm = (await catalog(page))['gpu-matmul'];
  if (!mm) throw new Error('gpu-matmul missing from the catalog');
  await page.goto('/benchmarks');
  await catalogReady(page);
  const opener = page.getByRole('button', { name: `Configure ${mm.name}…` });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: `Configure ${mm.name}` });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await page.getByRole('dialog', { name: `Configure ${mm.name}` }).getByRole('button', { name: 'Cancel' }).click();
  await expect(opener).toBeFocused();
});

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test('every benchmark screen passes axe', async ({ page }) => {
      test.setTimeout(60_000);
      const specs = await catalog(page);
      const rdma = specs['rdma-bw-lat']?.name ?? '';
      const runs = await seededRuns(page);
      const done = runs.find((r) => r.bench_id === 'gpu-matmul' && r.status === 'succeeded');
      const soak = runs.find((r) => r.bench_id === 'thermal-soak' && r.status === 'succeeded');
      const failed = runs.find((r) => r.status === 'failed');
      const pair = runs.filter((r) => r.bench_id === 'gpu-matmul' && r.status === 'succeeded').slice(0, 2);
      expect(done && soak && failed && pair.length === 2).toBeTruthy();

      await page.goto('/benchmarks');
      await catalogReady(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await expect(page.getByRole('table', { name: 'Benchmark runs' })).toBeVisible();
      expect(await axeViolations(page), 'catalog + history').toEqual([]);

      const mm = specs['gpu-matmul']?.name ?? '';
      await page.getByRole('button', { name: `Configure ${mm}…` }).click();
      await expect(page.getByRole('dialog', { name: `Configure ${mm}` })).toBeVisible();
      expect(await axeViolations(page), 'configure (node list)').toEqual([]);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: `Configure ${rdma}…` }).click();
      await expect(page.getByRole('dialog', { name: `Configure ${rdma}` })).toBeVisible();
      expect(await axeViolations(page), 'configure (2-node)').toEqual([]);
      await page.getByRole('button', { name: /Review & run/ }).click();
      await expect(page.getByRole('dialog', { name: `Run ${rdma}?` })).toBeVisible();
      expect(await axeViolations(page), 'confirm').toEqual([]);
      await page.keyboard.press('Escape');

      for (const [what, id] of [['completed run', done?.id], ['soak run', soak?.id], ['failed run', failed?.id]] as const) {
        await page.goto(`/benchmarks/runs/${id ?? ''}`);
        await expect(page.getByRole('region', { name: /Telemetry during the run/ })).toBeVisible({ timeout: 15_000 });
        expect(await axeViolations(page), what).toEqual([]);
      }

      await page.goto(`/benchmarks/runs/${done?.id ?? ''}`);
      await page.getByRole('button', { name: 'Share card' }).click();
      await expect(page.getByRole('dialog', { name: 'Share card' }).getByRole('img')).toBeVisible();
      expect(await axeViolations(page), 'share card').toEqual([]);
      await page.keyboard.press('Escape');

      await page.goto(`/benchmarks/compare?ids=${pair.map((r) => r.id).join(',')}`);
      await expect(page.getByRole('region', { name: 'Side by side' })).toBeVisible({ timeout: 15_000 });
      expect(await axeViolations(page), 'compare').toEqual([]);
    });
  });
}
