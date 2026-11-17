/// <reference lib="dom" />
// The Recommendations page against the demo console (simulated nodes: apply and undo change a table in memory and
// nothing else): apply one setting on one node, see it applied, undo it, with axe on the confirmation in both themes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

interface Rec {
  id: string;
  title: string;
  one_click: boolean;
  apply: string[];
}
interface View {
  catalog: Rec[];
  nodes: Record<string, { one_click: unknown; items: { id: string; state: string; managed: boolean }[] } | null>;
}

/** Titles, commands and node states come from the console (the backend owns that copy), never hard-coded. */
async function recommendations(page: Page): Promise<View> {
  const res = await page.request.get('/api/v1/recommendations');
  expect(res.ok()).toBe(true);
  return (await res.json()) as View;
}

const stateOf = (view: View, node: string, id: string) => view.nodes[node]?.items.find((i) => i.id === id);

/** A one-click setting that a node which takes clicks has yet to apply. */
function recommended(view: View): { rec: Rec; node: string } {
  for (const rec of view.catalog.filter((r) => r.one_click)) {
    const node = Object.keys(view.nodes).find((n) => view.nodes[n]?.one_click === null && stateOf(view, n, rec.id)?.state === 'not-applied');
    if (node) return { rec, node };
  }
  throw new Error('the demo recommends no one-click setting on a node that takes clicks');
}

async function ready(page: Page) {
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^spark1/ })).toBeVisible({ timeout: 15_000 });
}

async function axeViolations(page: Page) {
  await page.waitForTimeout(300); // dialogs fade in with CSS transitions
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  return results.violations.map((v) => `${v.impact ?? ''} ${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')})`);
}

test('apply a recommendation on one node, see it applied, and undo it', async ({ page }) => {
  const { rec, node } = recommended(await recommendations(page));
  await page.goto('/recommendations');
  await ready(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Recommendations' })).toBeVisible();

  const card = page.getByRole('region', { name: rec.title, exact: true });
  const row = card.getByRole('list', { name: `${rec.title}: your nodes` }).getByRole('listitem').filter({ hasText: node });
  await expect(row.getByText('Recommended', { exact: true })).toBeVisible();
  await expect(card.getByText('Not measured by Sparkline yet: community claim')).toBeVisible();

  await row.getByRole('button', { name: `Apply ${rec.title} on ${node}` }).click();
  const confirm = page.getByRole('dialog', { name: `Apply “${rec.title}” on ${node}?` });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused(); // never straight onto Apply
  for (const command of rec.apply) await expect(confirm.getByRole('region', { name: 'Commands and known risks' })).toContainText(command);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    expect(await axeViolations(page), `apply confirmation (${scheme})`).toEqual([]);
  }
  await confirm.getByRole('button', { name: `Apply on ${node}` }).click();

  await expect(row.getByText('Applied', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(stateOf(await recommendations(page), node, rec.id)).toMatchObject({ state: 'applied', managed: true });
  const undo = row.getByRole('button', { name: `Undo ${rec.title} on ${node}` });
  await expect(undo).toBeFocused(); // the keyboard stays on the row it acted on

  await undo.click();
  await page.getByRole('dialog', { name: `Undo “${rec.title}” on ${node}?` }).getByRole('button', { name: `Undo on ${node}` }).click();
  await expect(row.getByText('Recommended', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(row.getByRole('button', { name: `Apply ${rec.title} on ${node}` })).toBeVisible();
  expect(stateOf(await recommendations(page), node, rec.id)).toMatchObject({ state: 'not-applied', managed: false });
});
