/// <reference lib="dom" />
// A real first run, end to end: a console nobody has signed in to, nodes that answer a few seconds in and one that
// refuses, the getting-started guide left, resumed, dismissed and brought back.
//
// Each test starts its own console (--demo-first-run with a token) and serves the built app from it, because the
// first-run script runs on the console's clock from the moment it starts: a console shared by the whole suite would
// be past "connecting" before the first test opened a page. --demo-speed 0.5 gives the tests room: spark1 answers
// about 6 s in, spark2 about 16 s, and spark3 refuses for the first 90 s.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.E2E_FIRSTRUN_PORT ?? 9704);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'first-run-e2e-token-not-a-secret-0123456789';
const LINK = `${BASE}/login#token=${TOKEN}`;
// What the setup card of a node that refuses connections says to run, in order.
const FIX = ['sudo systemctl start sparkline-agent', 'journalctl -u sparkline-agent -n 50', 'sudo ./install.sh agent'];

// One console at a time on one port: the tests in this file run in order, in one worker.
test.describe.configure({ mode: 'default' });
test.setTimeout(90_000);

let server: ChildProcess | undefined;

test.beforeEach(async ({ request }, testInfo) => {
  const dir = testInfo.outputPath('console');
  mkdirSync(`${dir}/data`, { recursive: true });
  writeFileSync(`${dir}/console.toml`, `token = "${TOKEN}"\ndata_dir = "${dir}/data"\n`);
  server = spawn('../server/.venv/bin/sparkline', ['--demo-first-run', '--demo-speed', '0.5', '--config', `${dir}/console.toml`, '--bind', '127.0.0.1', '--port', String(PORT), '--web-dist', 'dist'], { stdio: 'ignore' });
  await expect.poll(() => request.get(`${BASE}/healthz`).then((r) => r.ok(), () => false), { timeout: 20_000, intervals: [100] }).toBe(true);
});

test.afterEach(async () => {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((done) => {
    child.once('exit', () => { done(); });
    child.kill('SIGTERM');
  });
});

/** Whether the last character of `text` inside `el` is painted inside `el`: not cut off, clamped or ellipsised. */
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
    return r.width > 0 && r.left >= box.left && r.right <= box.right + 0.5 && r.top >= box.top && r.bottom <= box.bottom + 0.5 && el.scrollWidth <= el.clientWidth;
  }
  return false;
};

async function axe(page: Page, within?: string): Promise<string[]> {
  await page.waitForFunction(() => [...document.querySelectorAll('.shell__page')].every((el) => getComputedStyle(el).opacity === '1'));
  await page.waitForTimeout(300);
  const builder = within ? new AxeBuilder({ page }).include(within) : new AxeBuilder({ page });
  const results = await builder.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  return results.violations.map((v) => `${v.impact ?? ''} ${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')})`);
}

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function signInByLink(page: Page) {
  await page.goto(LINK);
  await expect(page).toHaveURL(`${BASE}/`);
}

/** `selector` starts in the first strip of screen under the sticky toolbar, and is still there once the page has settled. */
async function expectJustUnderToolbar(page: Page, selector: string) {
  const gap = () => page.evaluate((sel) => {
    const bar = document.querySelector('.toolbar')?.getBoundingClientRect().bottom ?? 0;
    const top = document.querySelector(sel)?.getBoundingClientRect().top ?? -999;
    return Math.round(top - bar);
  }, selector);
  const near = (n: number) => n >= 0 && n <= 48;
  await expect.poll(async () => near(await gap()), { message: `${selector} under the toolbar` }).toBe(true);
  await page.waitForTimeout(1200);
  expect(near(await gap()), `${selector} still under the toolbar: ${String(await gap())} px`).toBe(true);
}

const setupCard = (page: Page) => page.getByRole('region', { name: 'Node spark3, not connected yet' });
const guidePanel = (page: Page) => page.getByRole('region', { name: 'Getting started', exact: true });
const guideStrip = (page: Page) => page.getByRole('region', { name: /^Getting started, \d of \d done$/ });

/** Nothing on the page says a node that has never answered is broken. */
async function expectNoAlarm(page: Page) {
  await expect(page.locator('.status', { hasText: /critical|offline|error/i })).toHaveCount(0);
  await expect(page.locator('.tone-crit')).toHaveCount(0);
  await expect(page.locator('.nav__badge')).toHaveCount(0);
  await expect(page.getByRole('main').getByText('Critical')).toHaveCount(0);
}

/** The setup card says everything, whole, at this width. */
async function expectWholeFix(card: Locator) {
  await expect(card.getByText('Not connected yet')).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Agent unreachable on spark3' })).toBeVisible();
  await expect(card.getByText('Likely cause')).toBeVisible();
  await expect(card.getByText(/^Connection refused at /)).toBeVisible();
  await expect(card.getByText('How to fix')).toBeVisible();
  await expect(card.locator('.setup__fix-text').first()).toHaveText('Start the agent on spark3: sudo systemctl start sparkline-agent.');
  await expect.poll(() => card.locator('.setup__fix-text').last().evaluate(shows, 'folder there.'), { message: 'the last step is shown to its last word' }).toBe(true);
  await expect(card.locator('.cmd__text')).toHaveText(FIX);
  for (const command of FIX) {
    await expect.poll(() => card.locator('.cmd__text', { hasText: command }).evaluate(shows, command), { message: `${command} is shown to its last character` }).toBe(true);
  }
  await expect(card.getByRole('button', { name: 'Copy command' })).toHaveCount(FIX.length);
  await expect(card.getByText(/Trying again in \d+\s*s|Trying now…/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry now' })).toBeVisible();
}

test('a first run on a desktop: welcome, sign-in link, nodes arriving, the fix, and a guide that stays put away', async ({ page, browser }) => {
  // Nobody has signed in: the sign-in page welcomes the person and says where the token is.
  await page.goto(`${BASE}/login`);
  await expect(page.getByRole('heading', { name: 'Welcome to Sparkline' })).toBeVisible();
  await expect(page.getByText('This console is new.')).toBeVisible();
  await expect(page.getByText('sudo grep ^token /etc/sparkline/console.toml')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy command' })).toBeVisible();

  // The installer's link signs in and leaves no token in the address bar or the history entry.
  await signInByLink(page);
  expect(await page.evaluate(() => `${location.href} ${JSON.stringify(history.state)}`)).not.toContain(TOKEN);
  expect(await page.evaluate(() => location.hash)).toBe('');

  // Nodes that have never answered are connecting, then live. The one that refuses is a setup step, not an outage.
  await expect(page.getByRole('heading', { level: 2, name: /^Welcome to Sparkline\./ })).toBeVisible();
  const spark1 = page.getByRole('region', { name: 'Node spark1', exact: true });
  await expect(spark1.getByText('Connecting')).toBeVisible();
  await expect(spark1.getByText(/^Reaching /)).toBeVisible();
  await expectWholeFix(setupCard(page));
  await expectNoAlarm(page);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^spark3/ })).toContainText('Not connected');
  await expect(spark1.getByText('Healthy')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 2, name: /^Welcome to Sparkline\. spark1 is live/ })).toBeVisible();
  await expect(spark1.getByRole('img', { name: /^GPU utilisation \d+%/ })).toBeVisible({ timeout: 10_000 });
  await expectNoAlarm(page);

  // Benchmarks and Settings > Data say the same of spark3: not connected yet, never offline, and nothing to clear.
  await page.goto(`${BASE}/benchmarks`);
  await expect(page.locator('.bench-avail', { hasText: 'spark3' }).first()).toContainText('Not connected yet');
  await expectNoAlarm(page);
  await page.goto(`${BASE}/settings`);
  await expect(page.getByText('spark3 has not connected yet. It has no history to clear.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear history for spark3…' })).toHaveCount(0);
  await page.goto(`${BASE}/`);

  // The guide is open in full under the node cards, and the sidebar counts it.
  const panel = guidePanel(page);
  await expect(panel.getByRole('listitem')).toHaveCount(5);
  await expect(panel.getByRole('heading', { level: 3 })).toHaveText(['Set up', 'Already on', 'Try it']);
  const entry = page.getByRole('link', { name: /^Get started/ });
  await expect(entry).toContainText(/\d of 5/);

  // Open an item: it is the real page. Come back after a reload: one line, with the next step.
  await panel.getByRole('link', { name: /^Prometheus export/ }).click();
  await expect(page).toHaveURL(`${BASE}/settings#prometheus`);
  const prometheus = page.getByRole('region', { name: 'Prometheus' });
  await expect(prometheus.getByText(`${BASE}/metrics`)).toBeVisible();
  await expect(prometheus.getByRole('button', { name: 'Copy scrape job' })).toBeVisible();
  await page.reload();
  await page.goto(`${BASE}/`);
  const strip = guideStrip(page);
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('link', { name: /^Next / })).toBeVisible();
  await expect(guidePanel(page)).toHaveCount(0);
  // The welcome was for the first visit.
  await expect(page.getByRole('heading', { level: 2, name: /^Welcome to Sparkline/ })).toHaveCount(0);

  // Dismiss: a line says where it went. After a reload there is nothing, here or in the sidebar.
  await strip.getByRole('button', { name: 'Dismiss getting started' }).click();
  await expect(page.getByText('Getting started is put away.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Node spark1', exact: true })).toBeVisible();
  await expect(page.getByText(/Getting started|Get started/)).toHaveCount(0);

  // Another browser on the same console (a phone, say) agrees: signed in, no guide, and no first-run welcome.
  const other = await browser.newContext();
  const phone = await other.newPage();
  await phone.goto(`${BASE}/login`);
  await expect(phone.getByRole('heading', { name: 'Sign in to Sparkline' })).toBeVisible();
  await phone.getByText('Where is the token?').click();
  await expect(phone.getByText('sudo grep ^token /etc/sparkline/console.toml')).toBeVisible();
  await signInByLink(phone);
  await expect(phone.getByRole('region', { name: 'Node spark1', exact: true })).toBeVisible();
  await expect(phone.getByText(/Getting started|Get started/)).toHaveCount(0);
  await other.close();

  // Settings brings it back, on the overview, in full.
  await page.goto(`${BASE}/settings`);
  await page.getByRole('button', { name: 'Open getting started' }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(guidePanel(page)).toBeFocused();
  await expect(guidePanel(page).getByRole('listitem')).toHaveCount(5);
});

test('a link with a wrong token falls back to the form with the usual error, and the token leaves the address bar', async ({ page }) => {
  await page.goto(`${BASE}/login#token=not-the-token`);
  await expect(page.getByText('That token wasn’t accepted.')).toBeVisible();
  await expect(page).toHaveURL(`${BASE}/login`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await expect(page.getByLabel('Console token')).toHaveValue('');
});

test('a first run on a phone: the chip under the welcome goes to the guide, and the fix is whole down to 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/login`);
  await expect(page.getByRole('heading', { name: 'Welcome to Sparkline' })).toBeVisible();
  await expect.poll(() => page.locator('.login__where .cmd__text').evaluate(shows, 'console.toml')).toBe(true);
  expect(await noSidewaysScroll(page)).toBe(true);

  await signInByLink(page);
  await expect(page.getByRole('heading', { level: 2, name: /^Welcome to Sparkline\./ })).toBeVisible();
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await expectWholeFix(setupCard(page));
    expect(await noSidewaysScroll(page), `no sideways scroll at ${width} px`).toBe(true);
  }
  await expectNoAlarm(page);

  // The guide is below the node cards: the chip says it is there and takes the person to it.
  await page.evaluate(() => { window.scrollTo(0, 0); });
  const chip = page.getByRole('button', { name: /^Getting started \d of 5/ });
  await expect(chip).toBeVisible();
  await expect(guidePanel(page)).not.toBeInViewport();
  await chip.click();
  await expect(guidePanel(page)).toBeInViewport();
  await expect(guidePanel(page)).toBeFocused();
  // Taller than the screen: it starts at its title, under the toolbar.
  await expectJustUnderToolbar(page, '#getting-started');

  // Open an item, come back: one line that fits the phone, and the chip still counts.
  await guidePanel(page).getByRole('link', { name: /^Alerts on your phone/ }).click();
  await expect(page).toHaveURL(`${BASE}/alerts#notifications`);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  // The section it names is at the top of the screen, and stays there while the rest of the page loads above it.
  await expectJustUnderToolbar(page, '#notifications');
  await page.goto(`${BASE}/`);
  await expect(guideStrip(page)).toBeVisible();
  // Having been to Alerts ticks it, with no channel configured: "Next" has moved on.
  await expect(guideStrip(page).getByRole('link', { name: /^Next / })).toBeVisible();
  await expect(guideStrip(page).getByRole('link', { name: /^Next / })).not.toContainText('Alerts on your phone');
  await expect(guideStrip(page).getByRole('button', { name: 'Show all' })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await guideStrip(page).getByRole('button', { name: 'Show all' }).click();
  await expect(guidePanel(page).getByRole('listitem')).toHaveCount(5);
  await guidePanel(page).getByRole('link', { name: /^Prometheus export/ }).click();
  await expect(page).toHaveURL(`${BASE}/settings#prometheus`);
  await expectJustUnderToolbar(page, '#prometheus');
  // Model servers lands on the node's panel, which on a phone is far below the top of the node's page.
  await page.goto(`${BASE}/`);
  await guidePanel(page).getByRole('link', { name: /^Model servers/ }).click();
  await expect(page).toHaveURL(/\/node\/spark\d#model-servers$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Model servers' })).toBeFocused();
  await expectJustUnderToolbar(page, '#model-servers');
});

test('the main path with a keyboard only', async ({ page }) => {
  /** Tab until `target` has focus. */
  const tabTo = async (target: Locator) => {
    for (let i = 0; i < 80; i++) {
      if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
      await page.keyboard.press('Tab');
    }
    throw new Error('never reached the target with Tab');
  };

  // Sign in: the token field has focus on arrival; Enter submits.
  await page.goto(`${BASE}/login`);
  await expect(page.getByLabel('Console token')).toBeFocused();
  await page.keyboard.type(TOKEN);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${BASE}/`);

  // The setup card: copy the command and retry, without a pointer.
  const card = setupCard(page);
  await tabTo(card.getByRole('button', { name: 'Copy command' }).first());
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: 'Copied command' })).toBeVisible();
  await tabTo(card.getByRole('button', { name: 'Retry now' }));
  await page.keyboard.press('Enter');
  await expect(card.getByText(/Trying now…|Trying again in/)).toBeVisible();

  // The guide: open a row with Enter, come back, dismiss with the keyboard.
  await tabTo(guidePanel(page).getByRole('link', { name: /^Prometheus export/ }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${BASE}/settings#prometheus`);
  await expect(page.getByRole('heading', { name: 'Prometheus' })).toBeFocused();
  // Back from the sidebar entry: the guide takes focus, every row shown.
  await tabTo(page.getByRole('link', { name: /^Get started/ }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(guidePanel(page)).toBeFocused();
  await tabTo(guidePanel(page).getByRole('button', { name: 'Dismiss getting started' }));
  await page.keyboard.press('Enter');
  await expect(page.getByText('Getting started is put away.')).toBeVisible();

  // Bring it back from the command palette.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: /Search views/ })).toBeFocused();
  await page.keyboard.type('getting started');
  await expect(page.getByRole('option', { name: /Open getting started/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(guidePanel(page)).toBeFocused();
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a node goes live with nothing moving', async ({ page }) => {
    await signInByLink(page);
    const spark1 = page.getByRole('region', { name: 'Node spark1', exact: true });
    await expect(spark1.getByText('Connecting')).toBeVisible();
    // Watch the card from now until well after its first reading: its values never fade or slide.
    await spark1.evaluate((card) => {
      const moved: string[] = [];
      (window as unknown as { moved: string[] }).moved = moved;
      const tick = () => {
        for (const el of card.querySelectorAll<HTMLElement>('.ov-card__values, .ov-card__foot')) {
          const s = getComputedStyle(el);
          if (s.opacity !== '1' || (s.transform !== 'none' && s.transform !== 'matrix(1, 0, 0, 1, 0, 0)')) moved.push(`${el.className}: opacity ${s.opacity}, transform ${s.transform}`);
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
    await expect(spark1.getByRole('img', { name: /^GPU utilisation \d+%/ })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { moved: string[] }).moved)).toEqual([]);
    // The retry bar steps, it does not glide.
    const bar = setupCard(page).locator('.setup-retry__bar i');
    expect(await bar.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThan(0.01);
  });
});

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test('the first-run screens have no accessibility violations, at desktop and phone width', async ({ page }) => {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        // Sign-in, before anyone has signed in (the first pass) and after.
        await page.context().clearCookies();
        await page.goto(`${BASE}/login`);
        await expect(page.getByRole('heading', { name: /Sparkline$/ })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        expect(await axe(page), `sign-in, ${width} px`).toEqual([]);

        // Overview with a connecting or live node, the setup card and the guide in full.
        await signInByLink(page);
        await expect(setupCard(page).getByRole('button', { name: 'Retry now' })).toBeVisible();
        await expect(page.locator('#getting-started')).toBeVisible();
        expect(await axe(page), `overview, ${width} px`).toEqual([]);

        // The node page of the node that has never answered, and the Prometheus section.
        await page.goto(`${BASE}/node/spark3`);
        await expect(page.getByRole('region', { name: 'spark3 is not connected yet' })).toBeVisible();
        expect(await axe(page), `node page, ${width} px`).toEqual([]);
        await page.goto(`${BASE}/settings#prometheus`);
        await expect(page.getByRole('region', { name: 'Prometheus' })).toBeVisible();
        // The section this feature adds, not the rest of Settings.
        expect(await axe(page, '#prometheus'), `settings, ${width} px`).toEqual([]);
      }

      // The one-line strip and the line left behind after dismissing.
      await page.goto(`${BASE}/`);
      await guidePanel(page).getByRole('button', { name: 'Collapse' }).click();
      await expect(guideStrip(page)).toBeVisible();
      expect(await axe(page), 'strip').toEqual([]);
      await guideStrip(page).getByRole('button', { name: 'Dismiss getting started' }).click();
      await expect(page.getByText('Getting started is put away.')).toBeVisible();
      expect(await axe(page), 'put away').toEqual([]);
    });
  });
}
