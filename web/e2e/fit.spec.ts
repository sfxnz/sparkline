import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const QWEN = { repo: 'Qwen/Qwen3-8B', weights_bytes: 16_381_470_720, weights_upper_bound: false, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: 40960, head_dim_worked_out: true };

test('a looked-up model gets an estimate and a verdict for every node', async ({ page }) => {
  await page.route('**/api/v1/fit/lookup?*', (route) => route.fulfill({ json: QWEN }));
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Will it fit?' }).click();
  await expect(page).toHaveTitle('Will it fit? · Sparkline');
  await page.getByRole('textbox', { name: 'Hugging Face repo' }).fill('Qwen/Qwen3-8B');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByRole('status', { name: 'Weights' })).toHaveText('15.3 GiB');
  await page.getByRole('button', { name: 'Estimate' }).click();

  const result = page.getByRole('region', { name: 'Result' });
  await expect(result).toContainText('Qwen/Qwen3-8B at 32,768 tokens');
  await expect(result).toContainText('15.3 GiB');
  await expect(result).toContainText('144.0 KiB per token');
  await expect(result).toContainText('21.7 GiB to 23.7 GiB');
  for (const node of ['spark1', 'spark2', 'spark3']) {
    await expect(result.getByRole('row', { name: new RegExp(`^${node}\\b`) })).toContainText(/Fits|Tight|Does not fit|Unknown/);
  }
  await expect(result).toContainText("Every verdict below counts Qwen/Qwen3-8B's safetensors files and nothing else");
  await expect(result).toContainText('not a hard cap');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('facts typed by hand need no lookup, and a refused lookup says what to do', async ({ page }) => {
  await page.route('**/api/v1/fit/lookup?*', (route) =>
    route.fulfill({ status: 502, json: { problem: { message: 'Could not reach huggingface.co from the console host', cause: 'ConnectError', fix: 'Enter the size and the shape by hand. The size is the total of every weight file the server loads, in every folder of this repo and in any other repo. Where a repo holds the same weights more than once, count them once. The shape is that of the language model that answers, not of a vision, audio or other part' } } }),
  );
  await page.goto('/fit');
  await page.getByRole('textbox', { name: 'Hugging Face repo' }).fill('Qwen/Qwen3-8B');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter the size and the shape by hand. The size is the total of every weight file the server loads');

  await page.getByRole('textbox', { name: 'Weights' }).fill('16.4');
  await page.getByRole('textbox', { name: 'Layers' }).fill('36');
  await page.getByRole('textbox', { name: 'KV heads' }).fill('8');
  await page.getByRole('textbox', { name: 'Head size' }).fill('128');
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByRole('region', { name: 'Result' })).toContainText('This model at 32,768 tokens of context, bf16 KV cache, from facts typed by hand');
  await expect(page.getByRole('region', { name: 'Result' }).getByRole('row', { name: /^spark1\b/ })).toBeVisible();
});
