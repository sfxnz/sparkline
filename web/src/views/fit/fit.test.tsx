import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FitRequest, FitResponse, ModelFacts } from '../../lib/types';
import Fit from '../Fit';
import { EMPTY_DRAFT, fromLookup, maxContextOf, parseCount, parseSize, readFrom, toRequest, type Draft } from './model';

const GIB = 1024 ** 3;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const QWEN: ModelFacts = { repo: 'Qwen/Qwen3-8B', weights_bytes: 16_381_470_720, weights_upper_bound: false, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: 40960, head_dim_worked_out: false };
// A repo whose config.json holds no head_dim: the console divided hidden_size by num_attention_heads.
const NO_HEAD_DIM: ModelFacts = { ...QWEN, repo: 'some/no-head-dim', head_dim: 80, head_dim_worked_out: true };
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

const SHAPE = { num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: 40960, head_dim_worked_out: false };
// The two instructions a refusal ends with, as the console sends them.
const SIZE_ASKED = 'the total of every weight file the server loads, in every folder of this repo and in any other repo. Where a repo holds the same weights more than once, count them once';
const ASK_SIZE = `Enter the size by hand: ${SIZE_ASKED}`;
const ASK_BOTH = `Enter the size and the shape by hand. The size is ${SIZE_ASKED}. The shape is that of the language model that answers, not of a vision, audio or other part`;
const REFUSED: Record<string, unknown> = {
  'some/big-index': {
    problem: { message: 'The weight index of some/big-index is too large for the lookup to read', cause: 'model.safetensors.index.json is 24.0 MiB', fix: ASK_SIZE },
    shape: SHAPE,
  },
  'some/odd-config': {
    problem: { message: 'The config.json of some/odd-config holds no shape at its top level', cause: 'The lookup reads the top level only, and found no whole number above 0 there for num_hidden_layers', fix: ASK_BOTH },
    shape: null,
  },
  // A draft model. Its own config holds a whole shape (one layer), and the console sends none of it.
  'some/draft': {
    problem: {
      message: "The config.json of some/draft has a key that a draft model's config has",
      cause: 'It has draft_vocab_size. The lookup cannot tell whether the repo holds a draft model',
      fix: ASK_BOTH,
    },
    shape: null,
  },
  // A refusal has no size. One that carries a size anyway, in the body the console sent before or in any
  // other, fills none in: a size with no shape beside it is one the console could not say covers the model.
  'some/size-in-a-refusal': {
    problem: { message: 'The config.json of some/size-in-a-refusal holds no shape at its top level', cause: 'The lookup reads the top level only, and found no whole number above 0 there for num_hidden_layers', fix: ASK_BOTH },
    shape: null,
    weights_bytes: 9_980_000_000,
    found: { weights_bytes: 9_980_000_000, weights_upper_bound: false, shape: SHAPE },
  },
};
const NO_REPO = {
  problem: { message: 'Hugging Face has no public model nope/nope', cause: 'The lookup cannot tell whether nothing has that id, or whether a private model, a dataset or a space has it', fix: ASK_BOTH },
  shape: null,
};

function fakeConsole(estimate: FitResponse = RESPONSE) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (init?.method === 'POST') return Promise.resolve(json(estimate));
    const repo = new URL(url as string, 'http://console').searchParams.get('repo') ?? '';
    const facts = [QWEN, SHARDED, NO_HEAD_DIM].find((f) => f.repo === repo);
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
    // The hint asks for the same total a refusal asks for, and names no page to copy a number from.
    expect(screen.getByText(/Type the total of every weight file the server loads, in every folder of the repo and in any other repo\. Where a repo holds the same weights more than once, count them once\./)).toBeInTheDocument();
    expect(screen.queryByText(/Files tab/)).not.toBeInTheDocument();
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
      facts: { repo: null, weights_bytes: 5_980_741_960, weights_upper_bound: false, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: null, head_dim_worked_out: false },
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

  // The seventh verifier's orders 20, 25 and 26: an answer given without a lookup wiped what was typed.
  describe.each([
    ['text that is not of the form the lookup takes', () => Promise.resolve(json({ problem: { message: 'The lookup takes a repo id of the form owner/name', cause: 'The text typed does not have that form', fix: 'Type an id of that form' } }, 422))],
    ['a console with the lookup turned off', () => Promise.resolve(json({ problem: { message: 'The Hugging Face lookup is turned off on this console', cause: '`hf_lookup = false`', fix: 'Enter the model facts by hand' } }, 403))],
    ['a console the browser cannot reach', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a gateway that answers for a console that is down', () => Promise.resolve(new Response('<html>502</html>', { status: 502 }))],
  ])('an answer given without a lookup: %s', (_what, noLookup) => {
    const consoleThatMakesNoLookup = () =>
      vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
        if (init?.method === 'POST') return Promise.resolve(json(RESPONSE));
        return new URL(url as string, 'http://console').searchParams.get('repo') === 'Qwen/Qwen3-8B' ? Promise.resolve(json(QWEN)) : noLookup();
      });

    it('leaves typed values and their result as they were', async () => {
      const user = userEvent.setup();
      consoleThatMakesNoLookup();
      render(<Fit />);
      await user.type(screen.getByRole('textbox', { name: 'Weights' }), '3.5');
      await user.type(screen.getByRole('textbox', { name: 'Layers' }), '12');
      await user.type(screen.getByRole('textbox', { name: 'KV heads' }), '4');
      await user.type(screen.getByRole('textbox', { name: 'Head size' }), '64');
      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      await screen.findByRole('region', { name: 'Result' });

      await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'gpt2{Enter}');
      await screen.findByRole('alert');
      expect(screen.getByRole('textbox', { name: 'Weights' })).toHaveValue('3.5');
      expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('12');
      expect(screen.getByRole('textbox', { name: 'KV heads' })).toHaveValue('4');
      expect(screen.getByRole('textbox', { name: 'Head size' })).toHaveValue('64');
      expect(screen.getByRole('region', { name: 'Result' })).toHaveTextContent('from facts typed by hand');
    });

    it('leaves a looked-up model and its result under the name of the repo they were read from', async () => {
      const user = userEvent.setup();
      consoleThatMakesNoLookup();
      render(<Fit />);
      await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
      await screen.findByText('Filled in from Qwen/Qwen3-8B.');
      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      await screen.findByRole('region', { name: 'Result' });

      await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
      await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'gpt2{Enter}');
      await screen.findByRole('alert');
      expect(screen.getByText('Filled in from Qwen/Qwen3-8B.')).toBeInTheDocument();
      expect(screen.getByRole('status', { name: 'Weights' })).toHaveTextContent('15.3 GiB');
      expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('36');
      expect(screen.getByRole('region', { name: 'Result' })).toHaveTextContent('Qwen/Qwen3-8B at 32,768 tokens');
    });
  });

  it('explains a failed lookup and still lets the facts be typed', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'nope/nope');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Hugging Face has no public model nope/nope');
    expect(alert).toHaveTextContent('Enter the size and the shape by hand.');
    expect(screen.getByRole('textbox', { name: 'Weights' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeEnabled();
  });

  it('fills in the shape a refused lookup still read, and asks for the size', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/big-index{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('too large for the lookup to read');
    expect(screen.getByRole('alert')).toHaveTextContent(`is 24.0 MiB. ${ASK_SIZE}.`);
    expect(screen.getByText('Shape read from some/big-index. The size is typed by hand.')).toBeInTheDocument();
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

  it('fills in no size from a refusal, whatever its body holds', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/size-in-a-refusal{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The config.json of some/size-in-a-refusal holds no shape');
    expect(screen.queryByRole('status', { name: 'Weights' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Weights' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue('');
    expect(screen.queryByText(/filled in from/i)).not.toBeInTheDocument();
  });

  // The fifth verifier's draft model: the lookup refused, the page kept the draft's one layer, and the
  // size the refusal asked for then gave Fits for a model that does not fit.
  it('fills in nothing after a refusal over a second model, and gives no verdict until the shape is typed', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/draft{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(`${ASK_BOTH}.`);
    for (const field of ['Weights', 'Layers', 'KV heads', 'Head size']) expect(screen.getByRole('textbox', { name: field })).toHaveValue('');
    expect(screen.queryByText(/filled in from/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/This model supports up to/)).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '16');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(screen.getAllByText('Enter a whole number above 0')).toHaveLength(3);
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('says beside the size when it is the total of every safetensors file in the repo, and not when it is the files a server loads', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/sharded{Enter}');
    expect(await screen.findByText('Filled in from some/sharded.')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveTextContent('11.2 GiB');
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveAccessibleDescription(/total of every safetensors file in the repo.*could not read the repo's index/);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByRole('region', { name: 'Result' })).toHaveTextContent(/read from some\/sharded: the total of its safetensors files, index not read/);
    expect(sent(spy).facts.weights_upper_bound).toBe(true);

    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    expect(screen.getByRole('status', { name: 'Weights' })).not.toHaveAccessibleDescription(/total of every safetensors file/);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByText(/Qwen\/Qwen3-8B at 32,768 tokens/);
    expect(screen.getByRole('region', { name: 'Result' })).not.toHaveTextContent(/the total of its safetensors files/);
  });

  it('says what the size covers and what it leaves out, on the form and beside the verdicts', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    const notCounted = /A second model the repo loads, a draft model's target and the base model under an adapter are not counted/;
    expect(screen.getByText(/Type the total of every weight file the server loads/)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveAccessibleDescription(/This is the size of this repo's safetensors files/);
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveAccessibleDescription(notCounted);

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    expect(result.getByText('read from Qwen/Qwen3-8B: its safetensors files')).toBeInTheDocument();
    expect(result.getByText('shape read from Qwen/Qwen3-8B')).toBeInTheDocument();
    expect(result.getByText(/Every verdict below counts Qwen\/Qwen3-8B's safetensors files and nothing else/)).toBeInTheDocument();
    // A repo can hold the same weights again as GGUF, so no label on the page says every weight file was counted.
    expect(screen.queryByText(/own weight files/)).not.toBeInTheDocument();
    expect(result.getByText(notCounted, { exact: false })).toBeInTheDocument();
  });

  it('marks a result built from typed facts as the user\'s own numbers', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '12.5');
    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '36');
    await user.type(screen.getByRole('textbox', { name: 'KV heads' }), '8');
    await user.type(screen.getByRole('textbox', { name: 'Head size' }), '128');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    expect(result.getByText(/This model at 32,768 tokens of context, bf16 KV cache, from facts typed by hand/)).toBeInTheDocument();
    expect(result.getByText('typed by hand')).toBeInTheDocument();
    expect(result.getByText('shape typed by hand')).toBeInTheDocument();
    expect(result.getByText('Too low for a model whose layers are wider than typed or run more than once. It may be too high for the kinds of model the note at the foot of this page names.')).toBeInTheDocument();
    expect(result.getByText(/The console did not read the model and cannot check them/)).toBeInTheDocument();
  });

  // The fifth verifier looked Qwen/Qwen3-8B up, changed Head size and pressed Estimate. The result called
  // the size the console had read "typed by hand" and dropped the sentence on what that size leaves out.
  it('keeps a looked-up size as the lookup\'s, with what it leaves out, when the shape is retyped', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await user.clear(screen.getByRole('textbox', { name: 'Head size' }));
    await user.type(screen.getByRole('textbox', { name: 'Head size' }), '129');
    expect(screen.getByText('Size read from Qwen/Qwen3-8B. The shape is typed by hand.')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Weights' })).toHaveTextContent('15.3 GiB');

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    expect(sent(spy).facts).toEqual({ ...QWEN, repo: null, max_context: null, head_dim: 129 });
    expect(result.getByText('read from Qwen/Qwen3-8B: its safetensors files')).toBeInTheDocument();
    expect(result.getByText('shape typed by hand')).toBeInTheDocument();
    expect(result.getByText(/Every verdict below counts Qwen\/Qwen3-8B's safetensors files and nothing else/)).toBeInTheDocument();
    expect(result.getByText(/A second model the repo loads, a draft model's target and the base model under an adapter are not counted/)).toBeInTheDocument();
    expect(result.getByText(/The shape was typed on the form, and the console cannot check it/)).toBeInTheDocument();
    expect(result.queryByText(/The console did not read the model/)).not.toBeInTheDocument();
    expect(result.queryByText(/from facts typed by hand/)).not.toBeInTheDocument();
  });

  it('marks a typed size as typed and keeps a looked-up shape as the lookup\'s', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/big-index{Enter}');
    await screen.findByText('Shape read from some/big-index. The size is typed by hand.');
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '433');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    expect(result.getByText('typed by hand')).toBeInTheDocument();
    expect(result.getByText('shape read from some/big-index')).toBeInTheDocument();
    expect(result.getByText(/built from a size typed on the form, which the console cannot check\. The shape was read from some\/big-index/)).toBeInTheDocument();
    expect(result.queryByText(/The console did not read the model/)).not.toBeInTheDocument();
    expect(result.queryByText(/are not counted/)).not.toBeInTheDocument();
  });

  const WORKED_OUT_HINT = 'Not read from the repo: its config.json gives no head_dim, so this is hidden_size divided by num_attention_heads.';
  const WHEN_ALIKE = 'For a model whose layers are all alike and each run once per token:';
  const READ_HINT = `${WHEN_ALIKE} head_dim, or hidden_size divided by num_attention_heads where the model's code works it out that way and takes no default of its own.`;
  const TYPED_SHAPE = 'Too low for a model whose layers are wider than typed or run more than once. It may be too high for the kinds of model the note at the foot of this page names.';

  it('says under each shape box which models the keys it names describe', () => {
    render(<Fit />);
    expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveAccessibleDescription(`${WHEN_ALIKE} num_hidden_layers of the language model that answers, in its config.`);
    expect(screen.getByRole('textbox', { name: 'KV heads' })).toHaveAccessibleDescription(`${WHEN_ALIKE} num_key_value_heads, or num_attention_heads when the model has no grouped attention.`);
    expect(screen.getByRole('textbox', { name: 'Head size' })).toHaveAccessibleDescription(READ_HINT);
  });

  it('keeps the condition under the boxes after a lookup that filled in nothing', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/odd-config{Enter}');
    await screen.findByRole('alert');
    for (const box of ['Layers', 'KV heads', 'Head size']) {
      expect(screen.getByRole('textbox', { name: box })).toHaveValue('');
      expect(screen.getByRole('textbox', { name: box }).getAttribute('aria-describedby')).toBeTruthy();
      expect(screen.getByRole('textbox', { name: box })).toHaveAccessibleDescription(new RegExp(`^${WHEN_ALIKE}`));
    }
  });

  it('says beside a typed shape in which direction its KV cache can be wrong, and not beside a looked-up one', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(within(await screen.findByRole('region', { name: 'Result' })).queryByText(TYPED_SHAPE)).not.toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Layers' }));
    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '44');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    await waitFor(() => { expect(result.getByText('shape typed by hand')).toBeInTheDocument(); });
    expect(result.getByText(TYPED_SHAPE)).toBeInTheDocument();
  });

  it('says on the form and in the result when the head size was worked out, not read', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/no-head-dim{Enter}');
    await screen.findByText('Filled in from some/no-head-dim.');
    expect(screen.getByRole('textbox', { name: 'Head size' })).toHaveValue('80');
    expect(screen.getByRole('textbox', { name: 'Head size' })).toHaveAccessibleDescription(WORKED_OUT_HINT);

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    expect(sent(spy).facts).toEqual(NO_HEAD_DIM);
    expect(result.getByText('shape read from some/no-head-dim, except the head size: worked out as hidden_size divided by num_attention_heads')).toBeInTheDocument();
  });

  it('says the same beside a typed size, where the verdicts name the shape\'s source', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/no-head-dim{Enter}');
    await screen.findByText('Filled in from some/no-head-dim.');
    await user.click(screen.getByRole('button', { name: 'Enter a size' }));
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '16');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    expect(result.getByText(/The shape was read from some\/no-head-dim, except the head size: worked out as hidden_size divided by num_attention_heads\.$/)).toBeInTheDocument();
  });

  it('does not call a head size worked out when the lookup read it, or once it is retyped', async () => {
    const user = userEvent.setup();
    const spy = fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    expect(screen.getByRole('textbox', { name: 'Head size' })).toHaveAccessibleDescription(READ_HINT);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(within(await screen.findByRole('region', { name: 'Result' })).getByText('shape read from Qwen/Qwen3-8B')).toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/no-head-dim{Enter}');
    await screen.findByText('Filled in from some/no-head-dim.');
    await user.clear(screen.getByRole('textbox', { name: 'Head size' }));
    await user.type(screen.getByRole('textbox', { name: 'Head size' }), '256');
    expect(screen.getByRole('textbox', { name: 'Head size' })).toHaveAccessibleDescription(READ_HINT);
    spy.mockClear();
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const result = within(await screen.findByRole('region', { name: 'Result' }));
    expect(sent(spy).facts.head_dim_worked_out).toBe(false);
    expect(result.getByText('shape typed by hand')).toBeInTheDocument();
    expect(result.queryByText(/worked out/)).not.toBeInTheDocument();
  });

  it('says what the KV cache estimate counts, and for a looked-up and a typed shape apart where it is off', () => {
    render(<Fit />);
    const note = screen.getByText(/The total is a range/);
    expect(note).toHaveTextContent('The KV cache counts every layer as an attention layer of one width, the KV heads times the head size above, run once per token.');
    // A looked-up shape is never called low, and a typed one is never called high as a flat fact.
    expect(note).toHaveTextContent('With a shape a lookup filled in, that is what vLLM keeps at its defaults or more: more for a model that windows its attention in some layers, or whose code gives it fewer KV heads than its config.json holds.');
    expect(note).toHaveTextContent('With a typed shape it is as right as the numbers typed: too low for a model whose layers are wider than typed or run more than once, and too high, sometimes several times, for a model that');
    for (const kind of ['windows its attention', 'shares a latent cache', 'Mamba, convolution, linear attention']) expect(note).toHaveTextContent(kind);
    expect(note).not.toHaveTextContent(/every layer at full width|halve|That is too high|under a key the lookup does not read/);
  });

  it('does not leave one repo\'s size beside another repo\'s shape', async () => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');
    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/big-index{Enter}');
    await screen.findByText('Shape read from some/big-index. The size is typed by hand.');
    expect(screen.queryByRole('status', { name: 'Weights' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Weights' })).toHaveValue('');

    await user.clear(screen.getByRole('textbox', { name: 'Hugging Face repo' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/odd-config{Enter}');
    await waitFor(() => { expect(screen.getByRole('textbox', { name: 'Layers' })).toHaveValue(''); });
    expect(screen.queryByText(/filled in from/i)).not.toBeInTheDocument();
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

  // The sixth verifier's orders 03 and 10: a result built from typed numbers stayed on the page under a form
  // that said "Filled in from <repo>" until Estimate was pressed again.
  it.each([
    ['answers', 'Qwen/Qwen3-8B', 'Filled in from Qwen/Qwen3-8B.'],
    ['refuses and fills in the shape', 'some/big-index', 'Shape read from some/big-index. The size is typed by hand.'],
    ['refuses and fills in nothing', 'some/odd-config', 'holds no shape at its top level'],
  ])('takes the result off the page when a later lookup %s', async (_what, repo, shown) => {
    const user = userEvent.setup();
    fakeConsole();
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '3.5');
    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '12');
    await user.type(screen.getByRole('textbox', { name: 'KV heads' }), '4');
    await user.type(screen.getByRole('textbox', { name: 'Head size' }), '64');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByRole('region', { name: 'Result' });

    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), `${repo}{Enter}`);
    await screen.findByText(shown, { exact: false });
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument();
  });

  it('shows no result for an estimate that answers after a later lookup has replaced the model', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      init?.method === 'POST' ? new Promise<Response>((resolve) => { answer = resolve; }) : Promise.resolve(json(QWEN)),
    );
    render(<Fit />);
    await user.type(screen.getByRole('textbox', { name: 'Weights' }), '3.5');
    await user.type(screen.getByRole('textbox', { name: 'Layers' }), '12');
    await user.type(screen.getByRole('textbox', { name: 'KV heads' }), '4');
    await user.type(screen.getByRole('textbox', { name: 'Head size' }), '64');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'Qwen/Qwen3-8B{Enter}');
    await screen.findByText('Filled in from Qwen/Qwen3-8B.');

    await act(async () => {
      answer(json(RESPONSE));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Estimate' })).toBeEnabled();
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
    await user.type(screen.getByRole('textbox', { name: 'Hugging Face repo' }), 'some/odd-config{Enter}');
    await screen.findByRole('alert');
    expect(screen.queryByText(/filled in from/i)).not.toBeInTheDocument();
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
    const parsed = toRequest(fromLookup(EMPTY_DRAFT, 'Qwen/Qwen3-8B', facts));
    expect(parsed.ok && parsed.request.facts).toEqual(facts);
  });

  it('reads a typed size in the unit beside it, and nothing that is not a plain number above 0', () => {
    expect(parseSize('9.98', 'GB')).toBe(9_980_000_000);
    expect(parseSize(' 37 ', 'GiB')).toBe(37 * GIB);
    expect(parseSize('0.548', 'GB')).toBe(548_000_000);
    for (const bad of ['', '0', '0.0', '-3', '9,98', '9.98 GB', '1e3', '8.19B', 'abc', '99999999999']) expect(parseSize(bad, 'GB'), bad).toBeNull();
  });

  it('leaves a lookup that read nothing with nothing of the form, and keeps the context length', () => {
    const filled = fromLookup(EMPTY_DRAFT, 'Qwen/Qwen3-8B', QWEN);
    expect(fromLookup(filled, 'nope/nope', null)).toEqual(EMPTY_DRAFT);
    const typed: Draft = { ...EMPTY_DRAFT, context: '8192', shape: { from: 'hand', layers: '36', kvHeads: '8', headDim: '128' }, weights: { from: 'hand', size: '12', unit: 'GB' } };
    expect(fromLookup(typed, 'nope/nope', null)).toEqual({ ...EMPTY_DRAFT, context: '8192' });
  });

  it('holds no size or shape that does not carry the repo it was read from', () => {
    const read = fromLookup(EMPTY_DRAFT, 'Qwen/Qwen3-8B', { ...QWEN, weights_bytes: 7 });
    expect(read.weights).toEqual({ from: 'lookup', repo: 'Qwen/Qwen3-8B', bytes: 7, upperBound: false });
    expect(read.shape).toMatchObject({ from: 'lookup', repo: 'Qwen/Qwen3-8B' });
    expect(readFrom(read)).toEqual({ size: 'Qwen/Qwen3-8B', shape: 'Qwen/Qwen3-8B' });
    // A size read from one repo and a shape read from another cannot both be on the form: the only way to
    // put a value there is a lookup, and a lookup writes both fields.
    const next = fromLookup(read, 'some/big-index', SHAPE);
    expect(readFrom(next)).toEqual({ size: null, shape: 'some/big-index' });
    expect(next.weights).toEqual(EMPTY_DRAFT.weights);
    expect(maxContextOf(next)).toBe(40960);
  });

  it('lets each part answer for where it came from, so retyping one leaves the other a lookup\'s', () => {
    const read = fromLookup(EMPTY_DRAFT, 'Qwen/Qwen3-8B', QWEN);
    const shapeTyped: Draft = { ...read, shape: { from: 'hand', layers: '36', kvHeads: '8', headDim: '129' } };
    expect(readFrom(shapeTyped)).toEqual({ size: 'Qwen/Qwen3-8B', shape: null });
    const sizeTyped: Draft = { ...read, weights: { from: 'hand', size: '16', unit: 'GiB' } };
    expect(readFrom(sizeTyped)).toEqual({ size: null, shape: 'Qwen/Qwen3-8B' });
    expect(readFrom(EMPTY_DRAFT)).toEqual({ size: null, shape: null });
    // The request names the repo only when every fact in it is that repo's.
    for (const draft of [shapeTyped, sizeTyped]) {
      const parsed = toRequest(draft);
      expect(parsed.ok && parsed.request.facts.repo).toBeNull();
    }
  });

  it('carries whether the head size was worked out with a looked-up shape, and drops it with a typed one', () => {
    const read = fromLookup(EMPTY_DRAFT, 'some/no-head-dim', NO_HEAD_DIM);
    expect(read.shape).toMatchObject({ from: 'lookup', headDimWorkedOut: true });
    const refused = fromLookup(EMPTY_DRAFT, 'some/big-index', { ...SHAPE, head_dim_worked_out: true });
    expect(refused.shape).toMatchObject({ from: 'lookup', headDimWorkedOut: true });
    const retyped = toRequest({ ...read, shape: { from: 'hand', layers: '36', kvHeads: '8', headDim: '80' } });
    expect(retyped.ok && retyped.request.facts.head_dim_worked_out).toBe(false);
  });

  it('sends a typed size as bytes', () => {
    const parsed = toRequest({ ...fromLookup(EMPTY_DRAFT, 'Qwen/Qwen3-8B', SHAPE), weights: { from: 'hand', size: '39.77', unit: 'GB' } });
    expect(parsed.ok && parsed.request.facts.weights_bytes).toBe(39_770_000_000);
  });
});
