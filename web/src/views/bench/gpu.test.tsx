import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../test/fixtures/platforms/gb10/sample.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
import type { BenchCreate, NodeInfo, Sample } from '../../lib/types';
import { useBench } from '../../store/bench';
import { useCluster } from '../../store/cluster';
import { liveStore } from '../../store/live';
import { ConfigureDialog } from './ConfigureDialog';
import { MAC_GPU, MATMUL, WS1, WS_MATMUL, run, wsGpuOptions } from './fixtures';
import { Home } from './Home';
import { Availability } from './parts';

const GB10 = gb10Info as unknown as NodeInfo;
const GB10_SAMPLE: Sample = gb10Sample;
const RTX = 'NVIDIA RTX 6000 Ada Generation';
const noop = () => undefined;
/** "GPU 2" naming one GPU of several, not a load like "GPU 62%". */
const GPU_NUMBER = /GPU \d+(?![\d%])/;

/** ws1's sample with some GPUs' utilisation replaced (by GPU index). */
function wsWith(utils: Record<number, number>): Sample {
  const s = wsSample as unknown as Sample;
  return { ...s, gpu: s.gpu.map((g) => (g.index in utils ? { ...g, util: utils[g.index] ?? null } : g)) };
}

function cluster(nodes: { info: NodeInfo; sample?: Sample }[]) {
  useCluster.setState({
    clockOffset: 0,
    order: nodes.map((n) => n.info.node_id),
    nodes: Object.fromEntries(nodes.map(({ info }) => [info.node_id, { node_id: info.node_id, url: '', status: 'online' as const, since: 0, last_sample_ts: null, error: null, info, next_retry_ts: null }])),
  });
  act(() => {
    for (const { info, sample } of nodes) {
      liveStore.removeNode(info.node_id);
      if (sample) liveStore.pushSample({ ...sample, ts: Date.now() / 1000 - 1 });
    }
    liveStore.flush();
  });
}

const review = () => { fireEvent.click(screen.getByRole('button', { name: /Review & run/ })); };
const MATMUL_DEFAULTS = { dtypes: ['bf16', 'fp16', 'fp8'], size: '8192', iterations: 50 };

describe('choosing the GPU on a multi-GPU node', () => {
  it('offers every GPU of ws1 with its live load, and names the one picked through to the run', () => {
    cluster([{ info: GB10, sample: GB10_SAMPLE }, { info: WS1, sample: wsWith({ 2: 3 }) }]);
    const onRun = vi.fn();
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={onRun} initialNodes={['ws1']} />);
    const picker = screen.getByRole('combobox', { name: 'GPU on ws1' });
    expect(picker).toHaveValue('0');
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      `GPU 0 · 86% busy · ${RTX}`,
      `GPU 1 · 86% busy · ${RTX}`,
      `GPU 2 · 3% busy · ${RTX}`,
      `GPU 3 · 87% busy · ${RTX}`,
    ]);

    fireEvent.change(picker, { target: { value: '2' } });
    expect(screen.getByText('serving vllm-llama70b · GPU 2 3%')).toBeInTheDocument();
    review();
    expect(screen.getByText('Runs GPU matmul on ws1 GPU 2.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nothing to compete with' })).toBeInTheDocument();
    expect(screen.getByText('ws1 GPU 2 is idle (3%).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    expect(onRun).toHaveBeenCalledWith(['ws1'], MATMUL_DEFAULTS, { ws1: 2 });
  });

  it('warns when the chosen GPU is busy, naming what runs on the node', () => {
    cluster([{ info: WS1, sample: wsWith({}) }]);
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={noop} initialNodes={['ws1']} />);
    review();
    expect(screen.getByRole('heading', { name: 'It will compete with running work' })).toBeInTheDocument();
    expect(screen.getByText('ws1 GPU 0 is 86% busy while ws1 is serving vllm-llama70b; results will be lower and the workload will slow down.')).toBeInTheDocument();
  });

  it('lists a GPU that cannot run it as disabled, with why, and starts on the next one', () => {
    cluster([{ info: WS1, sample: wsWith({}) }]);
    const lost = { message: 'GPU 0 on ws1 is not responding', cause: 'NVML: GPU is lost', fix: 'Reset GPU 0, then restart sparkline-agent on ws1' };
    const onRun = vi.fn();
    render(<ConfigureDialog spec={{ ...WS_MATMUL, gpu_options: { ws1: wsGpuOptions({ 0: lost }) } }} open onClose={noop} onRun={onRun} initialNodes={['ws1']} initialGpuIndex={{ ws1: 0 }} />);
    const picker = screen.getByRole('combobox', { name: 'GPU on ws1' });
    const gpu0 = within(picker).getByRole('option', { name: 'GPU 0 — GPU 0 on ws1 is not responding' });
    expect(gpu0).toBeDisabled();
    expect(picker).toHaveValue('1');
    expect(screen.getByText('NVML: GPU is lost')).toBeInTheDocument();
    expect(screen.getByText('Reset GPU 0, then restart sparkline-agent on ws1')).toBeInTheDocument();
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    expect(onRun).toHaveBeenCalledWith(['ws1'], MATMUL_DEFAULTS, { ws1: 1 });
  });

  it('adds nothing for a GB10 node: no picker, no GPU number, the same load and competition sentences', () => {
    cluster([{ info: GB10, sample: GB10_SAMPLE }]);
    const onRun = vi.fn();
    const { baseElement } = render(<ConfigureDialog spec={MATMUL} open onClose={noop} onRun={onRun} />);
    expect(screen.queryByRole('combobox', { name: /GPU/ })).toBeNull();
    expect(screen.getByText('serving DeepSeek-V4.1-Flash-EXL3 · GPU 62%')).toBeInTheDocument();
    expect(baseElement.textContent).not.toMatch(GPU_NUMBER);
    review();
    expect(screen.getByText('Runs GPU matmul on spark1.')).toBeInTheDocument();
    expect(screen.getByText('spark1 is currently serving DeepSeek-V4.1-Flash-EXL3 at 62% GPU; results will be lower and the workload will slow down.')).toBeInTheDocument();
    expect(baseElement.textContent).not.toMatch(GPU_NUMBER);
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    expect(onRun).toHaveBeenCalledWith(['spark1'], MATMUL_DEFAULTS, {});
  });
});

describe('a node that cannot run GPU benchmarks', () => {
  const spec = { ...MATMUL, availability: { spark1: null, mac1: MAC_GPU } };

  it('is disabled in the dialog with the agent’s message, cause and fix', () => {
    useCluster.setState({ order: ['spark1', 'mac1'], nodes: {} });
    render(<ConfigureDialog spec={spec} open onClose={noop} onRun={noop} />);
    const mac = screen.getByRole('checkbox', { name: /^mac1/ });
    expect(mac).toBeDisabled();
    const row = mac.closest('label') as HTMLElement;
    for (const text of [MAC_GPU.message, MAC_GPU.cause, MAC_GPU.fix]) expect(within(row).getByText(text)).toBeInTheDocument();
  });

  it('reads Unavailable in the catalog, with the reason on its info button', () => {
    render(<ul><Availability node="mac1" problem={MAC_GPU} /></ul>);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    const why = screen.getByRole('button', { name: 'Why mac1 can’t run this: GPU benchmarks need an NVIDIA GPU' });
    for (const text of [MAC_GPU.message, MAC_GPU.cause, MAC_GPU.fix]) expect(why).toHaveAccessibleDescription(expect.stringContaining(text));
  });

  it('shows no Fix line when the agent gives none', () => {
    render(<ul><Availability node="mac1" problem={{ ...MAC_GPU, fix: '' }} /></ul>);
    const why = screen.getByRole('button', { name: /^Why mac1/ });
    expect(why).toHaveAccessibleDescription(expect.stringContaining(MAC_GPU.cause));
    expect(why).toHaveAccessibleDescription(expect.not.stringContaining('Fix'));
  });
});

describe('starting a run', () => {
  const posted: BenchCreate[] = [];
  const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  const previous = run({ id: 'r-ws1', nodes: ['ws1'], params: { ...MATMUL_DEFAULTS, iterations: 100 }, gpu_index: { ws1: 3 } });

  beforeEach(() => {
    posted.length = 0;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/v1/bench/catalog')) return reply([WS_MATMUL]);
        if (url.startsWith('/api/v1/bench/runs') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string) as BenchCreate;
          posted.push(body);
          return reply(run({ id: 'r-new', status: 'queued', nodes: body.nodes, gpu_index: body.gpu_index }), 201);
        }
        if (url.startsWith('/api/v1/bench/runs')) return reply([previous]);
        return new Promise(() => undefined);
      }),
    );
    cluster([{ info: GB10, sample: GB10_SAMPLE }, { info: WS1, sample: wsWith({}) }]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useBench.setState({ runs: {} });
  });

  const home = (path: string) => {
    const loc = memoryLocation({ path });
    return render(<Router hook={loc.hook} searchHook={loc.searchHook}><Home /></Router>);
  };

  it('runs again on the GPU the previous run used, and sends it to the console', async () => {
    useBench.setState({ runs: { [previous.id]: previous } });
    home(`/benchmarks?configure=gpu-matmul&from=${previous.id}`);
    expect(await screen.findByRole('combobox', { name: 'GPU on ws1' })).toHaveValue('3');
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    expect(Object.values(useBench.getState().runs).find((r) => r.id.startsWith('pending-'))?.gpu_index).toEqual({ ws1: 3 });
    await waitFor(() => { expect(posted).toHaveLength(1); });
    expect(posted[0]).toEqual({ bench_id: 'gpu-matmul', nodes: ['ws1'], params: { ...MATMUL_DEFAULTS, iterations: 100 }, confirm: true, gpu_index: { ws1: 3 } });
  });

  it('sends no GPU for a GB10 node', async () => {
    home('/benchmarks?configure=gpu-matmul');
    expect(await screen.findByRole('checkbox', { name: /^spark1/ })).toBeChecked();
    expect(screen.queryByRole('combobox', { name: /GPU/ })).toBeNull();
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await waitFor(() => { expect(posted).toHaveLength(1); });
    expect(posted[0]).toEqual({ bench_id: 'gpu-matmul', nodes: ['spark1'], params: MATMUL_DEFAULTS, confirm: true });
  });
});
