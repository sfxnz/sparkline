import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** No console behind the UI: every API call fails the way the dev/preview proxy does (502). */
async function noBackend(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 502, contentType: 'text/plain', body: '' }));
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test('no-backend shell renders a designed connection problem with the chrome intact', async ({ page }) => {
      await noBackend(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Can’t reach Sparkline' })).toBeVisible();
      await expect(page.getByText('sparkline --demo')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry now' })).toBeVisible();
      await expect(page.getByText(/Reconnecting in \d+ s|Reconnecting…/)).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });

    test('login screen is accessible', async ({ page }) => {
      await noBackend(page);
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Sign in to Sparkline' })).toBeVisible();
      await expect(page.getByLabel('Console token')).toBeFocused();
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
}

test('command palette opens with Ctrl+K, filters, and closes with Escape', async ({ page }) => {
  await noBackend(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: /Search views/ });
  await expect(input).toBeFocused();
  await input.fill('alerts');
  await expect(page.getByRole('option', { selected: true })).toHaveText(/Alerts/);
  // The palette fades in: measure contrast on the final colours, not mid-transition.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !((a.effect as KeyframeEffect | null)?.target as Element | null)?.closest('.palette, dialog, [role="dialog"]')));
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/alerts$/);
  await page.keyboard.press('Control+k');
  await expect(input).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('wrong token shows a helpful error', async ({ page }) => {
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { authenticated: false, auth_required: true, demo: false } }));
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ status: 401, body: '' }));
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Console token').fill('nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That token wasn’t accepted.')).toBeVisible();
  await expect(page.getByLabel('Console token')).toHaveAttribute('aria-invalid', 'true');
});

test('with a console: hello populates the sidebar and the indicator goes Live', async ({ page }) => {
  const now = Date.now() / 1000;
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/v1/live**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.routeWebSocket('**/api/v1/stream', (ws) => {
    ws.send(JSON.stringify({
      type: 'hello',
      cluster: {
        nodes: [
          { node_id: 'spark1', url: '', status: 'online', since: now, last_sample_ts: null, error: null, info: null, next_retry_ts: null },
          { node_id: 'spark2', url: '', status: 'stale', since: now, last_sample_ts: null, error: null, info: null, next_retry_ts: null },
        ],
        settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
        demo: true,
        version: 'test',
        server_time: now,
      },
    }));
  });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: /spark1.*Healthy/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /spark2.*Not reporting/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Live$/ })).toBeVisible();
  await expect(page.getByText('Demo', { exact: true })).toBeVisible();
  await page.keyboard.press('2');
  await expect(page).toHaveURL(/\/node\/spark2$/);
  // The page heading stays for assistive tech; the node header is the visible title (shared element with its card).
  await expect(page.getByRole('heading', { level: 1, name: 'spark2' })).toBeAttached();
  await expect(page.getByRole('heading', { level: 2, name: 'spark2' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
});
