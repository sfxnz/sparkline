import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FitRequest, FitResponse, ModelFacts } from '../../lib/types';
import Fit from '../Fit';
import { EMPTY_DRAFT, filledFrom, fromLookup, maxContextOf, parseCount, parseSize, toRequest, type Draft } from './model';

const GIB = 1024 ** 3;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const QWEN: ModelFacts = { repo: 'Qwen/Qwen3-8B', weights_bytes: 16_381_470_720, weights_upper_bound: false, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: 40960 };
const SHARDED: ModelFacts = { ...QWEN, repo: 'some/sharded', weights_bytes: 12_000_000_000, weights_upper_bound: true };
const RESPONSE: FitResponse = {
  estimate: { weights_bytes: 16_381_470_720, kv_bytes_per_token: 147_456, kv_bytes: 4.5 * GIB, total_low: 23_334_639_820, total_high: 25_455_970_713 },
  nodes: [
    { node_id: 'spark1', budget: { kind: 'unified', bytes: 56 * GIB, available: 60 * GIB, headroom: 4 * GIB, gpu_vendor: 'nvidia' }, verdict: 'fits' },
    { node_id: 'spark2', budget: { kind: 'unified', bytes: 23 * GIB, available: 27 * GIB, headroom: 4 * GIB, gpu_vendor: 'nvidia' }, verdict: 'tight' },
    { node_id: 'ws1', budget: { kind: 'gpu', bytes: 12 * GIB, gpu_index: 1, gpu_name: 'RTX 6000 Ada' }, verdict: 'no' },
    { node_id: 'spark3', budget: { kind: 'unknown', reason: 'The node is offline, so its free memory is not known' }, verdict: 'unknown' },
  ],
};

const SHAPE = { num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: 40960 };
const REFUSED: Record<string, unknown> = {
  'some/big-index': {
    problem: { message: 'The weight index of some/big-index is too large for the lookup to read', cause: 'model.safetensors.index.json is 24.0 MiB', fix: 'Enter the model facts by hand' },
    found: { weights_bytes: null, weights_upper_bound: false, shape: SHAPE },
  },
  'some/odd-config': {
    problem: { message: 'Hugging Face does not describe some/odd-config in a way this estimator reads', cause: 'Its config.json has no whole number above 0 for num_hidden_layers at its top level', fix: 'Enter the model facts by hand' },
    found: { weights_bytes: null, weights_upper_bound: false, shape: null },
  },
  // A size with no shape beside it. The console stopped sending this, because a size it cannot pair with a
  // shape is a size it cannot say covers the model, and the page must still hold no earlier shape beside one.
  'some/size-only': {
    problem: { message: 'Hugging Face does not describe some/size-only in a way this estimator reads', cause: 'Its config.json has no whole number above 0 for num_hidden_layers at its top level', fix: 'Enter the model facts by hand' },
    found: { weights_bytes: 9_980_000_000, weights_upper_bound: false, shape: null },
  },
};
const NO_REPO = {
  problem: { message: 'Hugging Face has no public model nope/nope', cause: 'The repo does not exist or is private', fix: 'Check the repo id, or enter the model facts by hand' },
  found: { weights_bytes: null, weights_upper_bound: false, shape: null },
};

function fakeConsole(estimate: FitResponse = RESPONSE) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (init?.method === 'POST') return Promise.resolve(json(estimate));
    const repo = new URL(url as string, 'http://console').searchParams.get('repo') ?? '';
    const facts = [QWEN, SHARDED].find((f) => f.repo === repo);
    return Promise.resolve(facts ? json(facts) : json(REFUSED[repo] ?? NO_REPO, 502));
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
    expect(screen.getByText(/Files tab on Hugging Face lists each \.safetensors file in GB/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '5.57');
    // The page shows sizes in GiB, so a size read off it and typed back is the same size.
    expect(screen.getByRole('combobox', { name: 'Unit of the size' })).toHaveValue('GiB');
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
      facts: { repo: null, weights_bytes: 5_980_741_960, weights_upper_bound: false, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: null },
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

  it('fills in the shape a refused lookup still read, and asks for the size', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/big-index{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('too large for the lookup to read');
    expect(screen.getByRole('alert')).toHaveTextContent('is 24.0 MiB. Enter the model facts by hand.');
    expect(screen.getByText('Partly filled in from some/big-index.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('36');
    expect(screen.getByText('This model supports up to 40,960 tokens.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Weights' })).toHaveValue('');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit of the size' }), 'GB');
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '464.9');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });
    // The shape is still the one the lookup read, so the context it supports goes with it. Only the repo
    // drops out: a typed size is not the repo's, so the numbers no longer stand under the repo's name.
    expect(sent(spy).facts).toEqual({ ...QWEN, repo: null, weights_bytes: 464_900_000_000 });
    expect(screen.getByText(/This model at 32,768 tokens/)).toBeInTheDocument();
  });

  it('fills in the size a refused lookup still read, and asks for the shape', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/size-only{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('does not describe some/size-only');
    expect(screen.getByText('Partly filled in from some/size-only.')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveTextContent('9.3 GiB');
    expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('');

    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '36');
    await user.type(screen.getByRole('textbox', { name: 'KV heads' }), '8');
    await user.type(screen.getByRole('textbox', { name: 'Head size' }), '128');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });
    expect(sent(spy).facts).toEqual({ ...QWEN, repo: null, max_context: null, weights_bytes: 9_980_000_000 });
  });

  it('says beside the size when it is the total of the repo\'s weight files, and not when it is the files a server loads', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/sharded{Enter}');
    expect(await screen.findByText('Filled in from some/sharded.')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveTextContent('11.2 GiB');
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveAccessibleDescription(/total of the repo's weight files.*could not read the repo's index/);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByRole('region', { name: 'Result' })).toHaveTextContent(/total of the repo's weight files/);
    expect(sent(spy).facts.weights_upper_bound).toBe(true);

    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    expect(screen.getByRole('status', { name: 'Weights' })).not.toHaveAccessibleDescription(/total of the repo's weight files/);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByText(/Qwen\/Qwen3-8B at 32,768 tokens/);
    expect(screen.getByRole('region', { name: 'Result' })).not.toHaveTextContent(/total of the repo's weight files/);
  });

  it('does not leave one repo\'s size beside another repo\'s shape', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/big-index{Enter}');
    await screen.findByText('Partly filled in from some/big-index.');
    expect(screen.queryByRole('status', { name: 'Weights' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Weights' })).toHaveValue('');

    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/size-only{Enter}');
    await screen.findByText('Partly filled in from some/size-only.');
    expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('');
    expect(screen.queryByText(/This model supports up to/)).not.toBeInTheDocument();
  });

  it('leaves nothing on the form when a lookup reads nothing, typed values included', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '12.5');
    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '36');

    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'nope/nope{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('no public model nope/nope');
    expect(screen.getByRole('textbox', { name: 'Weights' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('');
    expect(screen.queryByText(/filled in from/)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Context length' })).toHaveValue('32768');
  });

  // The fourth verifier's orders 10, 15 and 16: a shape read from one repo stayed on the form under
  // another repo's name once the source marker had been cleared by hand, and the verdict flipped with it.
  it.each([
    ['the size is cleared with Enter a size', async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole('button', { name: 'Enter a size' }));
    }],
    ['a shape field is corrected by hand', async (user: ReturnType<typeof userEvent.setup>) => {
      await user.type(await screen.findByRole('textbox', { name: 'Head size' }), '0');
    }],
  ])('keeps no shape from an earlier repo after %s', async (_name, edit) => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await edit(user);

    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/size-only{Enter}');
    await screen.findByRole('alert');
    expect(screen.getByText('Partly filled in from some/size-only.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'KV heads' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Head size' })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(screen.getAllByText('Enter a whole number above 0')).toHaveLength(3);
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit of the size' }), 'GB');
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '16.5');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });
    expect(sent(spy).facts).toEqual({ ...QWEN, repo: null, weights_bytes: 16_500_000_000 });
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
    const parsed = toRequest(fromLookup(EMPTY_DRAFT, 'Qwen/Qwen3-8B', { weights_bytes: facts.weights_bytes, weights_upper_bound: false, shape: facts }));
    expect(parsed.ok && parsed.request.facts).toEqual(facts);
  });

  it('reads a typed size in the unit beside it, and nothing that is not a plain number above 0', () => {
    expect(parseSize('9.98', 'GB')).toBe(9_980_000_000);
    expect(parseSize(' 37 ', 'GiB')).toBe(37 * GIB);
    expect(parseSize('0.548', 'GB')).toBe(548_000_000);
    for (const bad of ['', '0', '0.0', '-3', '9,98', '9.98 GB', '1e3', '8.19B', 'abc', '99999999999']) expect(parseSize(bad, 'GB'), bad).toBeNull();
  });

  it('leaves a lookup that read nothing with nothing of the form, and keeps the context length', () => {
    const nothing = { weights_bytes: null, weights_upper_bound: false, shape: null };
    const filled = fromLookup(EMPTY_DRAFT, 'some/size-only', { weights_bytes: 9_980_000_000, weights_upper_bound: false, shape: null });
    expect(fromLookup(filled, 'nope/nope', nothing)).toEqual(EMPTY_DRAFT);
    const typed: Draft = { ...EMPTY_DRAFT, context: '8192', shape: { from: 'hand', layers: '36', kvHeads: '8', headDim: '128' }, weights: { from: 'hand', size: '12', unit: 'GB' } };
    expect(fromLookup(typed, 'nope/nope', nothing)).toEqual({ ...EMPTY_DRAFT, context: '8192' });
  });

  it('holds no size or shape that does not carry the repo it was read from', () => {
    const read = fromLookup(EMPTY_DRAFT, 'Qwen/Qwen3-8B', { weights_bytes: 7, weights_upper_bound: false, shape: QWEN });
    expect(read.weights).toEqual({ from: 'lookup', repo: 'Qwen/Qwen3-8B', bytes: 7, upperBound: false });
    expect(read.shape).toMatchObject({ from: 'lookup', repo: 'Qwen/Qwen3-8B' });
    expect(filledFrom(read)).toEqual({ repo: 'Qwen/Qwen3-8B', complete: true });
    // A size read from one repo and a shape read from another cannot both be on the form: the only way to
    // put a value there is a lookup, and a lookup writes both fields.
    const next = fromLookup(read, 'some/size-only', { weights_bytes: 9, weights_upper_bound: false, shape: null });
    expect(filledFrom(next)).toEqual({ repo: 'some/size-only', complete: false });
    expect(next.shape).toEqual(EMPTY_DRAFT.shape);
    expect(maxContextOf(next)).toBeNull();
  });

  it('sends a typed size as bytes', () => {
    const parsed = toRequest({ ...fromLookup(EMPTY_DRAFT, 'Qwen/Qwen3-8B', { weights_bytes: null, weights_upper_bound: false, shape: QWEN }), weights: { from: 'hand', size: '39.77', unit: 'GB' } });
    expect(parsed.ok && parsed.request.facts.weights_bytes).toBe(39_770_000_000);
  });
});
