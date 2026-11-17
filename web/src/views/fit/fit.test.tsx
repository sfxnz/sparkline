import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FitRequest, FitResponse, ModelFacts } from '../../lib/types';
import Fit from '../Fit';
import { EMPTY_DRAFT, fromFacts, parseCount, parseSize, toRequest } from './model';

const GIB = 1024 ** 3;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const QWEN: ModelFacts = { repo: 'Qwen/Qwen3-8B', weights_bytes: 16_381_470_720, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: 40960 };
const RESPONSE: FitResponse = {
  estimate: { weights_bytes: 16_381_470_720, kv_bytes_per_token: 147_456, kv_bytes: 4.5 * GIB, total_low: 23_334_639_820, total_high: 25_455_970_713 },
  nodes: [
    { node_id: 'spark1', budget: { kind: 'unified', bytes: 56 * GIB, available: 60 * GIB, headroom: 4 * GIB, gpu_vendor: 'nvidia' }, verdict: 'fits' },
    { node_id: 'spark2', budget: { kind: 'unified', bytes: 23 * GIB, available: 27 * GIB, headroom: 4 * GIB, gpu_vendor: 'nvidia' }, verdict: 'tight' },
    { node_id: 'ws1', budget: { kind: 'gpu', bytes: 12 * GIB, gpu_index: 1, gpu_name: 'RTX 6000 Ada' }, verdict: 'no' },
    { node_id: 'spark3', budget: { kind: 'unknown', reason: 'The node is offline, so its free memory is not known' }, verdict: 'unknown' },
  ],
};

function fakeConsole(estimate: FitResponse = RESPONSE) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (init?.method === 'POST') return Promise.resolve(json(estimate));
    return Promise.resolve(
      url === '/api/v1/fit/lookup?repo=Qwen%2FQwen3-8B'
        ? json(QWEN)
        : json({ problem: { message: 'Hugging Face has no public model nope/nope', cause: 'The repo does not exist or is private', fix: 'Check the repo id, or enter the model facts by hand' } }, 502),
    );
  });
}

const sent = (spy: ReturnType<typeof fakeConsole>) => JSON.parse(spy.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body as string) as FitRequest;
const row = (node: string) => within(screen.getByRole('row', { name: new RegExp(`^${node}\\b`) }));

describe('Will it fit', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('looks a repo up, estimates it and shows a verdict for every node', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('Filled in from Qwen/Qwen3-8B.')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveTextContent('15.3 GiB');
    expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('36');
    expect(screen.getByText('This model supports up to 40,960 tokens.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    expect(sent(spy)).toEqual({ facts: QWEN, context_tokens: 32768, kv_dtype: 'bf16' });
    expect(result.getByText(/Qwen\/Qwen3-8B at 32,768 tokens/)).toBeInTheDocument();
    expect(result.getByText('15.3 GiB')).toBeInTheDocument();
    expect(result.getByText('4.5 GiB')).toBeInTheDocument();
    expect(result.getByText('144.0 KiB per token')).toBeInTheDocument();
    expect(result.getByText('21.7 GiB to 23.7 GiB')).toBeInTheDocument();

    expect(row('spark1').getByText('Fits')).toBeInTheDocument();
    expect(row('spark1').getByText('60.0 GiB available, 4.0 GiB kept free')).toBeInTheDocument();
    expect(row('spark2').getByText('Tight')).toBeInTheDocument();
    expect(row('ws1').getByText('Does not fit')).toBeInTheDocument();
    expect(row('ws1').getByText(/GPU 1 \(RTX 6000 Ada\)\. Single-GPU fit/)).toBeInTheDocument();
    expect(row('spark3').getByText('Unknown')).toBeInTheDocument();
    expect(row('spark3').getByText(/The node is offline/)).toBeInTheDocument();
    expect(result.getByText(/vLLM's memory fraction is not a hard cap/)).toBeInTheDocument();
  });

  it('warns about the vLLM memory fraction only when a GB10 is in the answer', async () => {
    const user = userEvent.setup();
    fakeConsole({ ...RESPONSE, nodes: RESPONSE.nodes.filter((n) => n.budget.kind !== 'unified') });
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });
    expect(screen.queryByText(/not a hard cap/)).not.toBeInTheDocument();
  });

  it('estimates from facts typed by hand, with no lookup', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(screen.getAllByText('Enter a whole number above 0')).toHaveLength(3);
    expect(screen.getByText('Enter a size above 0, for example 9.98')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();

    expect(screen.queryByRole('textbox', { name: 'Parameters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Bits per weight' })).not.toBeInTheDocument();
    expect(screen.getByText(/add up the \.safetensors files on the repo's Files tab/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '5.57');
    expect(screen.getByRole('combobox', { name: 'Unit of the size' })).toHaveValue('GB');
    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '36');
    await user.type(screen.getByRole('textbox', { name: 'KV heads' }), '8');
    await user.type(screen.getByRole('textbox', { name: 'Head size' }), '128');
    await user.clear(screen.getByRole('textbox', { name: 'Context length' }));
    await user.type(screen.getByRole('textbox', { name: 'Context length' }), '8192');
    await user.selectOptions(screen.getByRole('combobox', { name: 'KV cache dtype' }), 'fp8');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sent(spy)).toEqual({
      facts: { repo: null, weights_bytes: 5_570_000_000, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: null },
      context_tokens: 8192,
      kv_dtype: 'fp8',
    });
    expect(screen.getByText(/This model at 8,192 tokens/)).toBeInTheDocument();
  });

  it('takes a size in GiB too, and no size without a number above 0', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '36');
    await user.type(screen.getByRole('textbox', { name: 'KV heads' }), '8');
    await user.type(screen.getByRole('textbox', { name: 'Head size' }), '128');
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '8.19B');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(screen.getByText('Enter a size above 0, for example 9.98')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();

    await user.clear(screen.getByRole('textbox', { name: 'Weights' }));
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '2.5');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit of the size' }), 'GiB');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });
    expect(sent(spy).facts.weights_bytes).toBe(2.5 * GIB);
  });

  it('explains a failed lookup and still lets the facts be typed', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'nope/nope');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Hugging Face has no public model nope/nope');
    expect(alert).toHaveTextContent('enter the model facts by hand');
    expect(screen.getByRole('textbox', { name: 'Weights' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeEnabled();
  });

  it('says when the context is longer than the looked-up model supports', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await user.clear(screen.getByRole('textbox', { name: 'Context length' }));
    await user.type(screen.getByRole('textbox', { name: 'Context length' }), '131072');
    expect(screen.getByText('More than this model supports (40,960 tokens).')).toBeInTheDocument();
  });

  it('stops calling the facts the repo\'s once one is edited by hand', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '0');
    expect(screen.queryByText(/This model supports up to/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });
    expect(sent(spy).facts).toEqual({ ...QWEN, repo: null, max_context: null, num_layers: 360 });
  });

  it('lets a typed size replace the size a lookup found, and stops saying the repo filled the form in', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Enter a size' }));
    expect(screen.queryByText('Filled in from Qwen/Qwen3-8B.')).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '16.5');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });
    expect(sent(spy).facts).toEqual({ ...QWEN, repo: null, max_context: null, weights_bytes: 16_500_000_000 });
  });
});

describe('fit form model', () => {
  it('reads counts the way model cards write them', () => {
    expect(parseCount('8190735360')).toBe(8_190_735_360);
    expect(parseCount(' 8,190,735,360 ')).toBe(8_190_735_360);
    expect(parseCount('8.19B')).toBe(8_190_000_000);
    expect(parseCount('32k')).toBe(32_000);
    for (const bad of ['', '0', '-3', '1e9', '8 billion', '0.4']) expect(parseCount(bad), bad).toBeNull();
  });

  it('sends the size a lookup found as it came', () => {
    const facts = { ...QWEN, weights_bytes: 5_570_829_761 };
    const parsed = toRequest(fromFacts(EMPTY_DRAFT, facts));
    expect(parsed.ok && parsed.request.facts).toEqual(facts);
  });

  it('reads a typed size in the unit beside it, and nothing that is not a plain number above 0', () => {
    expect(parseSize('9.98', 'GB')).toBe(9_980_000_000);
    expect(parseSize(' 37 ', 'GiB')).toBe(37 * GIB);
    expect(parseSize('0.548', 'GB')).toBe(548_000_000);
    for (const bad of ['', '0', '0.0', '-3', '9,98', '9.98 GB', '1e3', '8.19B', 'abc', '99999999999']) expect(parseSize(bad, 'GB'), bad).toBeNull();
  });

  it('sends a typed size as bytes', () => {
    const parsed = toRequest({ ...fromFacts(EMPTY_DRAFT, QWEN), weights: { kind: 'typed', size: '39.77', unit: 'GB' } });
    expect(parsed.ok && parsed.request.facts.weights_bytes).toBe(39_770_000_000);
  });
});
