/// <reference lib="dom" />
// (DOM types: page.evaluate callbacks run in the browser.)
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

/**
 * A stubbed console: auth ok, no history, and a stream whose first connection says hello. `server()` returns the
 * first stream connection so a test can push messages or close it; later connections are refused (console down).
 */
async function withConsole(page: Page) {
  const now = Date.now() / 1000;
  let first: WebSocketRoute | null = null;
  await page.route('**/api/**', (route) => route.fulfill({ status: 502, body: '' }));
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/v1/live**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.routeWebSocket('**/api/v1/stream', (ws) => {
    if (first) {
      void ws.close();
      return;
    }
    first = ws;
    ws.send(JSON.stringify({
      type: 'hello',
      cluster: {
        nodes: ['spark1', 'spark2'].map((id) => ({ node_id: id, url: '', status: 'online', since: now, last_sample_ts: now, error: null, info: null, next_retry_ts: null })),
        settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
        demo: true,
        version: 'test',
        server_time: now,
      },
    }));
  });
  return {
    server: async () => {
      await expect.poll(() => first !== null).toBe(true);
      return first as unknown as WebSocketRoute;
    },
  };
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test('production build keeps backdrop blur and the sidebar stays sticky with only its right hairline', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await withConsole(page);
  await page.goto('/');
  await expect(nav(page).getByRole('link', { name: /spark1.*Healthy/ })).toBeVisible();
  const sidebar = page.locator('.sidebar');
  const css = await sidebar.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { blur: cs.backdropFilter, left: cs.borderLeftWidth, top: cs.borderTopWidth, right: cs.borderRightWidth };
  });
  expect(css.blur).not.toBe('none');
  expect(css).toMatchObject({ left: '0px', top: '0px' });
  expect(css.right).not.toBe('0px');
  // The material runs the full scroll height; its contents are the sticky part.
  const inner = page.locator('.sidebar__inner');
  expect(await inner.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  expect(await inner.evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
  expect(await sidebar.evaluate((el) => el.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(480);
  // Content now scrolls under the toolbar: it becomes a material with a hairline.
  await expect(page.locator('.toolbar')).toHaveClass(/is-scrolled/);
  expect(await page.locator('.toolbar').evaluate((el) => getComputedStyle(el).backdropFilter)).not.toBe('none');
});

test('system reduced transparency makes materials opaque', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await withConsole(page);
  await page.goto('/');
  await expect(nav(page)).toBeVisible();
  const { bg, blur } = await page.locator('.sidebar').evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, blur: getComputedStyle(el).backdropFilter }));
  expect(bg).toMatch(/^rgb\(/); // opaque, not rgba(…, 0.52)
  expect(blur).toBe('none');
});

test('losing the console turns every node stale and is announced; an open critical alert raises the node', async ({ page }) => {
  const { server } = await withConsole(page);
  await page.goto('/node/spark1');
  await expect(nav(page).getByRole('link', { name: /spark1.*Healthy/ })).toBeVisible();
  const ws = await server();

  ws.send(JSON.stringify({
    type: 'event',
    event: { id: 1, ts: Date.now() / 1000, node_id: 'spark1', severity: 'critical', kind: 'alert', rule_id: 'gpu_temp_crit', title: 'GPU temperature critical on spark1', detail: '', metric: 'gpu0.temp_c', value: 91, resolved_ts: null, acked: false },
  }));
  await expect(nav(page).getByRole('link', { name: /spark1.*Critical/ })).toBeVisible();
  await expect(page.locator('.nhead [data-status]')).toHaveAttribute('data-status', 'critical');
  await expect(nav(page).getByRole('link', { name: /spark2.*Healthy/ })).toBeVisible();

  await ws.close();
  await expect(page.getByText(/Reconnecting/)).toBeVisible();
  await expect(nav(page).getByText('Healthy')).toHaveCount(0);
  await expect(nav(page).getByText('Critical')).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: /spark1.*Not reporting/ })).toBeVisible();
  await expect(page.locator('.nhead [data-status]')).toHaveAttribute('data-status', 'stale');
  await expect(page.getByText('Not live: the connection to Sparkline was lost')).toBeVisible();
  await expect(page.locator('[aria-live="polite"][role="status"]')).toContainText('Connection to Sparkline lost');
});

test('document title follows the page', async ({ page }) => {
  await withConsole(page);
  await page.goto('/');
  await expect(page).toHaveTitle('Overview · Sparkline');
  await nav(page).getByRole('link', { name: 'Alerts' }).click();
  await expect(page).toHaveTitle('Alerts · Sparkline');
  await page.goto('/wall');
  await expect(page).toHaveTitle('Wall mode · Sparkline');
});

test('single-key shortcuts can be turned off', async ({ page }) => {
  await withConsole(page);
  await page.goto('/');
  await expect(nav(page).getByRole('link', { name: /spark2/ })).toBeVisible();
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await help.getByRole('checkbox', { name: /Single-key shortcuts/ }).uncheck();
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Live' }).focus();
  await page.keyboard.press('2');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: /Search views/ })).toBeFocused();
  await page.keyboard.type('single-key');
  await page.keyboard.press('Enter');
  await page.getByRole('radio', { name: 'Live' }).focus();
  await page.keyboard.press('2');
  await expect(page).toHaveURL(/\/node\/spark2$/);
});

test('controls grow with a 200% root font size instead of clipping text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await withConsole(page);
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; });
  });
  await page.goto('/node/spark1');
  await expect(page.getByRole('tab', { name: 'Summary' })).toBeVisible();
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.segmented__option, .nav__item, .tabs__tab, .toolbar__search, .btn, .conn__status, .kbd, .sidebar__name')]
      .filter((el) => el.offsetParent !== null && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1))
      .map((el) => `${el.className}: ${el.textContent}`),
  );
  expect(clipped).toEqual([]);
});

for (const scheme of ['dark', 'light'] as const) {
  test(`wall mode is accessible (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await withConsole(page);
    await page.goto('/wall');
    await expect(page.getByRole('button', { name: 'Exit wall mode' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });
}
