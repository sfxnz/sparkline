/// <reference lib="dom" />
// Key flows against the demo console the Playwright config starts (simulated spark1-3, no auth). Nothing here is
// stubbed: the build, the preview proxy, the console's REST + WebSocket and its alert engine are all real.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TABS = ['summary', 'gpu', 'memory', 'cpu', 'network', 'storage', 'thermals', 'processes'] as const;
const ROUTES = ['/', ...TABS.map((t) => (t === 'summary' ? '/node/spark1' : `/node/spark1/${t}`)), '/alerts', '/benchmarks', '/settings', '/wall'];

/** Connected to the demo and the first node has reported (the sidebar lists it with a status). */
async function ready(page: Page) {
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^spark1/ })).toBeVisible({ timeout: 15_000 });
}

/** Every axe violation, whatever its impact (moderate ones such as duplicate landmarks are real problems too). */
async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  return results.violations.map((v) => `${v.impact ?? ''} ${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')})`);
}

test('overview renders every demo node with a health sentence', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  for (const id of ['spark1', 'spark2', 'spark3']) {
    await expect(page.getByRole("link", { name: new RegExp(`^${id}\\b.*open node details`) })).toBeVisible();
  }
  // The hero answers "is my cluster healthy?" in words, not only colour.
  await expect(page.locator('.ov-hero__sentence')).toHaveText(/healthy|stale|offline|alert|critical|warning|temperature/i); // the demo's thermal episode reads "at its GPU slowdown temperature"
});

test('node tabs are reachable from the keyboard and keep the URL in step', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.keyboard.press('1'); // single-key shortcut: first node
  await expect(page).toHaveURL(/\/node\/spark1$/);
  const summary = page.getByRole('tab', { name: 'Summary' });
  await expect(summary).toHaveAttribute('aria-selected', 'true');
  await summary.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\/node\/spark1\/gpu$/);
  await expect(page.getByRole('tab', { name: 'GPU' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'GPU' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page).toHaveURL(/\/node\/spark1\/processes$/);
  await expect(page.getByRole('heading', { name: 'Top processes' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/\/node\/spark1\/thermals$/);
  await expect(page.getByRole('tabpanel')).toContainText('GPU energy');
});

test('command palette jumps to a node tab', async ({ page }) => {
  await page.goto('/alerts');
  await ready(page);
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: /Search views/ });
  await expect(input).toBeFocused();
  await input.fill('spark2 memory');
  await expect(page.getByRole('listbox', { name: 'Results' }).getByRole('option', { selected: true })).toHaveText(/spark2 › Memory/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/node\/spark2\/memory$/);
  await expect(input).toBeHidden();
  await expect(page.getByText('Unified memory · shared by CPU and GPU', { exact: false })).toBeVisible();
});

test('the time-range picker moves charts from the live buffer to history, and is remembered', async ({ page }) => {
  await page.goto('/node/spark1');
  await ready(page);
  await expect(page.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
  const history = page.waitForRequest((r) => r.url().includes('/api/v1/history') && r.url().includes('gpu0.util'));
  await page.getByRole('radio', { name: 'Last hour' }).click();
  await history;
  await expect(page.getByRole('radio', { name: 'Last hour' })).toHaveAttribute('aria-checked', 'true');
  // Every chart on the tab shows history: none is stuck loading or failed, and the live-only stale chip is gone.
  await expect(page.locator('.tschart [role="img"]').first()).toHaveAttribute('aria-label', /last hour/);
  await expect(page.getByText('History unavailable')).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(page.getByRole('radio', { name: 'Last hour' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Live' }).click(); // leave the shared preference as found
});

test('an open alert can be acknowledged, and stays acknowledged after a reload', async ({ page }) => {
  // The demo raises alerts on a schedule (spark1's thermal episode, spark3 going offline): wait for one.
  test.setTimeout(240_000);
  await page.goto('/alerts');
  await ready(page);
  const ack = page.getByRole('button', { name: /^Acknowledge: / }).first();
  await expect(ack).toBeVisible({ timeout: 200_000 });
  const title = ((await ack.getAttribute('aria-label')) ?? '').replace(/^Acknowledge: /, '');
  const row = page.locator('.open-row').filter({ hasText: title }).first();
  await ack.click();
  await expect(row.getByText('Acknowledged')).toBeVisible(); // optimistic, then confirmed by the console
  await page.reload();
  await ready(page);
  // Still acknowledged after a reload (it may have resolved meanwhile; then the timeline says so).
  await expect(page.getByText(/Acknowledged|Open · acknowledged/).first()).toBeVisible();
});

test('the theme choice in Settings persists across reloads', async ({ page }) => {
  await page.goto('/settings');
  await ready(page);
  const themes = page.getByRole('radiogroup', { name: /Theme/ });
  await themes.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(themes.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await themes.getByRole('radio', { name: 'Dark' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('clearing history needs the node name typed before it can run', async ({ page }) => {
  await page.goto('/settings');
  await ready(page);
  await page.getByRole('button', { name: 'Clear history for spark1…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear history for spark1?' });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Clear history' });
  const phrase = dialog.getByLabel(/Type spark1 to confirm/);
  await expect(confirm).toBeDisabled();
  await phrase.fill('spark');
  await expect(confirm).toBeDisabled();
  await phrase.fill('spark1');
  await expect(confirm).toBeEnabled();
  const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().includes('/api/v1/history?node=spark1'));
  await confirm.click();
  expect((await del).postDataJSON()).toEqual({ confirm: 'DELETE' });
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Demo mode: nothing was deleted on spark1')).toBeVisible();
});

for (const scheme of ['dark', 'light'] as const) {
  test(`no axe violations on any route (${scheme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    for (const route of ROUTES) {
      await page.goto(route);
      if (route !== '/wall') await ready(page); // wall mode has no sidebar
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await page.waitForTimeout(800); // let skeletons resolve into content
      expect(await axeViolations(page), `${route} (${scheme})`).toEqual([]);
    }
  });

  // Interactive and degraded states the route sweep never reaches: an open chart table (a keyboard-scrollable
  // region), an expanded process row under the pointer, the command palette, a confirmation dialog, and a node
  // that is not reporting (dimmed last-known values).
  test(`no axe violations in interactive and degraded states (${scheme})`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ colorScheme: scheme });
    const check = async (what: string) => {
      // Dialogs and the palette fade in: measure contrast on the final colours, not mid-transition.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !((a.effect as KeyframeEffect | null)?.target as Element | null)?.closest('.palette, dialog, [role="dialog"]')));
      expect(await axeViolations(page), `${what} (${scheme})`).toEqual([]);
    };

    await page.goto('/node/spark1/gpu');
    await ready(page);
    await page.getByRole('button', { name: /: data table$/ }).first().click();
    await expect(page.locator('.chart-table[role="region"]').first()).toBeVisible();
    await check('chart data table open');

    await page.goto('/node/spark1/processes');
    await ready(page);
    await page.locator('.procs__toggle').first().click();
    await page.locator('tr.procs__detail').first().hover();
    await check('process row expanded');

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('combobox', { name: /Search views/ })).toBeFocused();
    await check('command palette open');
    await page.keyboard.press('Escape');

    await page.goto('/settings');
    await ready(page);
    await page.getByRole('button', { name: 'Clear history for spark1…' }).click();
    await expect(page.getByRole('dialog', { name: 'Clear history for spark1?' })).toBeVisible();
    await check('confirmation dialog open');
    await page.keyboard.press('Escape');

    // The demo takes spark3 offline on a schedule (stale ~150 s after start, unreachable until ~210 s, every 150 s).
    await page.goto('/node/spark3/gpu');
    await ready(page);
    const spark3 = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^spark3/ });
    await expect(spark3).toContainText(/Offline|Not reporting/, { timeout: 170_000 });
    for (const tab of ['gpu', 'memory', 'processes', 'network']) {
      await page.goto(`/node/spark3/${tab}`);
      await ready(page);
      await page.waitForTimeout(600);
      await check(`spark3 not live, ${tab}`);
    }
  });
}
