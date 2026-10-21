/// <reference lib="dom" />
// Benchmark flows against the demo console (simulated, time-compressed runs; nothing touches real hardware):
// configure -> confirm -> live progress -> results -> baseline -> compare -> export, the cancel flow, the LLM
// benchmark's live streams and concurrency sweep, the tool-calling evaluation, parameter validation, and axe on every
// benchmark screen in both themes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

interface RunRow {
  id: string;
  bench_id: string;
  status: string;
  params: Record<string, unknown>;
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

const label = (spec: Spec, name: string) => spec.params.find((p) => p.name === name)?.label ?? name;

/** Configure from the catalog (`set` changes parameters), confirm, and land on the run's own page; returns its id. */
async function runFromCatalog(page: Page, spec: Spec, set: (dialog: Locator) => Promise<void>): Promise<string> {
  await page.goto('/benchmarks');
  await catalogReady(page);
  await page.getByRole('button', { name: `Configure ${spec.name}…` }).click();
  const dialog = page.getByRole('dialog', { name: `Configure ${spec.name}` });
  await set(dialog);
  await dialog.getByRole('button', { name: /Review & run/ }).click();
  await page.getByRole('dialog', { name: `Run ${spec.name}?` }).getByRole('button', { name: 'Run benchmark' }).click();
  await expect(page).toHaveURL(/\/benchmarks\/runs\/[0-9a-z]+$/, { timeout: 10_000 });
  return page.url().split('/').pop() ?? '';
}

/** LLM inference sweeping 1, 2, 4 and 8 streams (the demo plays it in about 30 s). */
async function runLlmSweep(page: Page): Promise<Spec> {
  const llm = (await catalog(page))['llm-inference'];
  if (!llm) throw new Error('llm-inference missing from the catalog');
  await runFromCatalog(page, llm, async (dialog) => {
    await dialog.getByRole('textbox', { name: label(llm, 'concurrency') }).fill('8');
    const sweep = dialog.getByRole('switch', { name: label(llm, 'sweep') });
    await sweep.click();
    await expect(sweep).toHaveAttribute('aria-checked', 'true');
  });
  return llm;
}

/** Axe on the current page in the light theme, then again after the system switches to dark. */
async function axeBothThemes(page: Page, what: string) {
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await axeViolations(page), `${what} (light)`).toEqual([]);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await axeViolations(page), `${what} (dark)`).toEqual([]);
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

  test('LLM inference shows every concurrent stream live, then the sweep, the timeline and the final outputs', async ({ page }) => {
    test.setTimeout(120_000);
    await runLlmSweep(page);
    const streams = page.getByRole('region', { name: 'Concurrency streams' });
    await expect(streams).toBeVisible({ timeout: 15_000 });
    const rail = streams.getByRole('list', { name: 'Concurrency levels' });
    await expect(rail.getByRole('listitem')).toHaveCount(4); // 1, 2, 4 and 8 streams

    // A card's text grows while its request decodes (same request, more text a moment later).
    const card = streams.getByRole('list', { name: /^Streams: / }).getByRole('button').first();
    const sample = async () => ({ name: (await card.getAttribute('aria-label')) ?? '', text: (await card.locator('.strm-body').textContent()) ?? '' });
    await expect.poll(async () => {
      const a = await sample();
      await page.waitForTimeout(300);
      const b = await sample();
      return a.name === b.name && b.name.includes('decoding') && b.text.length > a.text.length;
    }, { timeout: 20_000 }).toBe(true);
    await axeBothThemes(page, 'streams live');

    // The rail advances a level at a time; a finished level shows its output.
    await expect(rail.locator('[aria-current="step"]')).toContainText('8 streams', { timeout: 45_000 });
    await expect(rail.getByRole('listitem').first()).toContainText('tok/s');
    await expect(streams.getByRole('list', { name: /^Streams: / }).getByRole('listitem')).toHaveCount(8);

    await expect(page.getByText(/^Completed in /)).toBeVisible({ timeout: 45_000 });
    await expect(streams).toHaveCount(0);
    const sweep = page.getByRole('region', { name: 'Concurrency sweep' });
    await expect(sweep.getByRole('table', { name: 'Concurrency sweep, one row per level' }).getByRole('row')).toHaveCount(5); // header + 4 levels
    await expect(page.getByRole('region', { name: 'Stream timeline' })).toContainText('at 8 streams');
    const outputs = page.getByRole('region', { name: 'Final outputs' });
    await outputs.getByText('Show 8 streams').click();
    await expect(outputs.getByRole('list', { name: 'Final outputs' }).getByRole('listitem')).toHaveCount(8);
    await axeBothThemes(page, 'sweep finished');
  });

  test('a cancelled LLM sweep says it stopped and keeps what it recorded', async ({ page }) => {
    test.setTimeout(90_000);
    const llm = await runLlmSweep(page);
    const rail = page.getByRole('region', { name: 'Concurrency streams' }).getByRole('list', { name: 'Concurrency levels' });
    await expect(rail.locator('[aria-current="step"]')).toContainText('2 streams', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await page.getByRole('dialog', { name: `Stop ${llm.name}?` }).getByRole('button', { name: 'Stop benchmark' }).click();

    await expect(page.getByText(/^The benchmark was stopped after .* What it recorded before it stopped is shown below\.$/)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.bench-run__title-row')).toContainText('Cancelled');
    await expect(page.getByRole('region', { name: 'Concurrency streams' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Concurrency sweep' })).toContainText(/Stopped during level \d of 4/);
    const outputs = page.getByRole('region', { name: 'Final outputs' });
    await expect(outputs).toContainText('when the run was cancelled');
    await outputs.getByText(/^Show \d+ streams$/).click();
    // Streams cut off mid-request read "stopped", never as if they had finished.
    await expect(outputs.getByRole('list', { name: 'Final outputs' }).getByRole('button', { name: /: stopped/ }).first()).toBeVisible();
  });

  test('the tool-calling evaluation fills its board, then shows the score, every scenario and upstream’s JSON', async ({ page }) => {
    test.setTimeout(150_000);
    const te = (await catalog(page))['tool-eval'];
    if (!te) throw new Error('tool-eval missing from the catalog');
    const runId = await runFromCatalog(page, te, async (dialog) => {
      await dialog.getByRole('combobox', { name: label(te, 'suite') }).selectOption('core');
      await expect(dialog.getByText(/Estimated/)).toBeVisible();
    });

    const evaluation = page.getByRole('region', { name: 'Tool-calling evaluation' });
    await expect(evaluation.getByRole('region', { name: 'Now running' })).toContainText(/Now running · \d+ of 15/, { timeout: 20_000 });
    const board = evaluation.getByRole('group', { name: 'Scenario board' });
    await expect(board.getByRole('button')).toHaveCount(15);
    const graded = () => board.getByRole('button', { name: /, (passed|partial|failed|excluded)$/ }).count();
    await expect.poll(graded, { timeout: 20_000 }).toBeGreaterThan(0);
    const first = await graded();
    await expect.poll(graded, { timeout: 20_000 }).toBeGreaterThan(first); // verdicts keep arriving
    await axeBothThemes(page, 'evaluation live');

    await expect(page.getByText(/^Completed in /)).toBeVisible({ timeout: 60_000 });
    await expect(evaluation.getByRole('img', { name: /^Tool-calling score \d+%/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Score per category' })).toBeVisible();
    const scenarios = page.getByRole('region', { name: 'Scenarios' });
    const table = scenarios.getByRole('table', { name: 'Scenario results' });
    await expect(table.getByRole('row')).toHaveCount(16); // header + 15

    const filter = scenarios.getByRole('combobox', { name: 'Filter by result' });
    await filter.selectOption('pass');
    const passed = Number(/\((\d+)\)/.exec((await filter.locator('option:checked').textContent()) ?? '')?.[1]);
    expect(passed).toBeGreaterThan(0);
    await expect(table.getByRole('row')).toHaveCount(passed + 1);
    await filter.selectOption('all');
    await scenarios.getByRole('searchbox', { name: 'Search scenarios' }).fill('unit handling');
    await expect(table.getByRole('row')).toHaveCount(2);
    await table.getByRole('button', { name: 'Unit Handling' }).click();
    const dialog = page.getByRole('dialog', { name: /^TC-04 · Unit Handling/ });
    await expect(dialog.getByRole('list', { name: 'Upstream’s pass and fail criteria' }).getByRole('listitem')).toHaveCount(2);
    await expect(dialog.getByRole('region', { name: 'Trace of TC-04' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    const json = page.waitForEvent('download');
    await evaluation.getByRole('button', { name: 'Download tool-eval-bench JSON' }).click();
    expect((await json).suggestedFilename()).toBe(`tool-eval-bench-${runId}.json`);
    await axeBothThemes(page, 'evaluation finished');
  });
});

test('the seeded concurrency sweep opens from History, with a timeline per level and its data table', async ({ page }) => {
  await page.goto('/benchmarks');
  await catalogReady(page);
  await page.getByLabel('Filter by benchmark').selectOption('llm-inference');
  await page.getByRole('table', { name: 'Benchmark runs' }).getByRole('row').filter({ hasText: 'Concurrency 32' }).getByRole('link', { name: 'LLM inference' }).click();
  await expect(page.getByRole('region', { name: 'Concurrency sweep' })).toContainText('6 levels');

  const timeline = page.getByRole('region', { name: 'Stream timeline' });
  await expect(timeline).toContainText('32 requests at 32 streams'); // the last level first
  const levels = timeline.getByRole('radiogroup', { name: 'Level' });
  await levels.getByRole('radio', { name: '8 streams' }).click();
  await expect(timeline).toContainText('8 requests at 8 streams');
  const toggle = timeline.getByRole('button', { name: 'Stream timeline: data table' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(timeline.getByRole('table', { name: 'Requests at 8 streams' }).getByRole('row')).toHaveCount(9); // header + 8
  await levels.getByRole('radio', { name: '16 streams' }).click();
  await expect(timeline.getByRole('table', { name: 'Requests at 16 streams' }).getByRole('row')).toHaveCount(17);
  await toggle.click();
  await expect(timeline.getByRole('table')).toHaveCount(0);
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
      test.setTimeout(90_000);
      const specs = await catalog(page);
      const rdma = specs['rdma-bw-lat']?.name ?? '';
      const runs = await seededRuns(page);
      const done = runs.find((r) => r.bench_id === 'gpu-matmul' && r.status === 'succeeded');
      const soak = runs.find((r) => r.bench_id === 'thermal-soak' && r.status === 'succeeded');
      const failed = runs.find((r) => r.status === 'failed');
      const sweep = runs.find((r) => r.bench_id === 'llm-inference' && r.status === 'succeeded' && r.params.concurrency === 32);
      const evaluation = runs.find((r) => r.bench_id === 'tool-eval' && r.status === 'succeeded');
      const pair = runs.filter((r) => r.bench_id === 'gpu-matmul' && r.status === 'succeeded').slice(0, 2);
      expect(done && soak && failed && sweep && evaluation && pair.length === 2).toBeTruthy();

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

      for (const [what, id] of [['completed run', done?.id], ['soak run', soak?.id], ['failed run', failed?.id], ['concurrency sweep', sweep?.id], ['tool-calling evaluation', evaluation?.id]] as const) {
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
