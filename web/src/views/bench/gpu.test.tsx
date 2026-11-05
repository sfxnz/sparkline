import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../test/fixtures/platforms/gb10/sample.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
import type { BenchCreate, BenchRun, NodeInfo, NodeStatus, Sample } from '../../lib/types';
import { useBench } from '../../store/bench';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import { ConfigureDialog } from './ConfigureDialog';
import { LLM, MAC_GPU, MATMUL, SOAK, WS1, WS_MATMUL, WS_MEMBW, run, wsGpuOptions } from './fixtures';
import { Home } from './Home';
import { Availability } from './parts';
import type { ChartSeries } from './RunChart';
import { RunTelemetry } from './RunTelemetry';
import { RunView } from './RunView';
import { SoakPanel } from './SoakPanel';
import { nodeState } from './streams/fixtures';

const charts: { title: string; series: readonly ChartSeries[] }[] = [];
vi.mock('./RunChart', () => ({
  RunChart: (p: { title: string; series: readonly ChartSeries[] }) => {
    charts.push(p);
    return null;
  },
}));

const GB10 = gb10Info as unknown as NodeInfo;
const GB10_SAMPLE: Sample = gb10Sample;
const RTX = 'NVIDIA RTX 6000 Ada Generation';
const noop = () => undefined;
const GPU_NUMBER = /GPU \d+(?![\d%])/;

function wsWith(utils: Record<number, number>): Sample {
  const s = wsSample as unknown as Sample;
  return { ...s, gpu: s.gpu.map((g) => (g.index in utils ? { ...g, util: utils[g.index] ?? null } : g)) };
}

function cluster(nodes: { info: NodeInfo; sample?: Sample; status?: NodeStatus }[]) {
  useConnection.setState({ status: 'live', everLive: true });
  useCluster.setState({
    clockOffset: 0,
    order: nodes.map((n) => n.info.node_id),
    nodes: Object.fromEntries(nodes.map(({ info, status = 'online' }) => [info.node_id, { node_id: info.node_id, url: '', status, since: 0, last_sample_ts: null, error: null, info, next_retry_ts: null }])),
  });
  act(() => {
    for (const { info, sample } of nodes) {
      liveStore.removeNode(info.node_id);
      if (sample) liveStore.pushSample({ ...sample, ts: Date.now() / 1000 - 1 });
    }
    liveStore.flush();
  });
}

const home = (path: string) => {
  const loc = memoryLocation({ path });
  return render(<Router hook={loc.hook} searchHook={loc.searchHook}><Home /></Router>);
};

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
    expect(screen.getByText('serving vllm-llama70b · GPU 2 at 3%').textContent).toMatch(/GPU\u00a02\u00a0at\u00a03%$/);
    review();
    expect(screen.getByText('Runs GPU matmul on ws1 GPU 2.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    expect(onRun).toHaveBeenCalledWith(['ws1'], MATMUL_DEFAULTS, { ws1: 2 });
  });

  it('names beside the picker the GPU memory a workload on the node holds, and keeps each option short', () => {
    cluster([{ info: WS1, sample: wsWith({ 2: 3 }) }]);
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={noop} initialNodes={['ws1']} initialGpuIndex={{ ws1: 2 }} />);
    const picker = screen.getByRole('combobox', { name: 'GPU on ws1' });
    expect(picker).toHaveAccessibleDescription('ws1 is serving vllm-llama70b, which holds 161.7\u00a0GiB of GPU memory. Sparkline cannot see which GPUs hold it.');
    expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(`GPU 2 · 3% busy · ${RTX}`);
    act(() => { useConnection.setState({ status: 'reconnecting' }); });
    expect(picker).toHaveAccessibleDescription('When ws1 last reported, it was serving vllm-llama70b, which held 161.7\u00a0GiB of GPU memory. Sparkline cannot see which GPUs hold it.');
  });

  it('names no GPU memory when no GPU process on the node holds any', () => {
    cluster([{ info: WS1, sample: { ...wsWith({ 2: 3 }), procs: [] } }]);
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={noop} initialNodes={['ws1']} initialGpuIndex={{ ws1: 2 }} />);
    expect(screen.getByRole('combobox', { name: 'GPU on ws1' })).toHaveAccessibleDescription('');
    expect(screen.queryByText(/GPU memory/)).toBeNull();
  });

  it('warns about a quiet GPU on a node serving a model, since Sparkline cannot tell which GPUs hold its memory', () => {
    cluster([{ info: WS1, sample: wsWith({ 2: 0 }) }]);
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={noop} initialNodes={['ws1']} initialGpuIndex={{ ws1: 2 }} />);
    review();
    expect(screen.getByRole('heading', { name: 'It will compete with running work' })).toBeInTheDocument();
    expect(screen.getByText('ws1 GPU 2 is 0% busy, but ws1 is serving vllm-llama70b, which holds 161.7 GiB of GPU memory; if it shares GPU 2, the run may run out of GPU memory.')).toBeInTheDocument();
    expect(screen.queryByText(/idle/)).toBeNull();
  });

  it('marks the load of a node that is not reporting as out of date, in the picker and the review', () => {
    cluster([{ info: WS1, sample: wsWith({ 2: 3 }), status: 'stale' }]);
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={noop} initialNodes={['ws1']} initialGpuIndex={{ ws1: 2 }} />);
    expect(within(screen.getByRole('combobox', { name: 'GPU on ws1' })).getByRole('option', { selected: true })).toHaveTextContent(`GPU 2 · was 3% busy · ${RTX}`);
    review();
    expect(screen.getByRole('heading', { name: 'Current load unknown' })).toBeInTheDocument();
    expect(screen.getByText('ws1 is not reporting; GPU 2 was 3% busy when it last reported, so its current load is unknown.')).toBeInTheDocument();
    expect(screen.queryByText(/idle/)).toBeNull();
  });

  it('reads a browser that lost the console like a node that is not reporting, in the node row, the picker and the review', () => {
    cluster([{ info: WS1, sample: wsWith({ 2: 3 }) }]);
    useConnection.setState({ status: 'reconnecting' });
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={noop} initialNodes={['ws1']} initialGpuIndex={{ ws1: 2 }} />);
    expect(screen.getByText(/^not reporting · serving vllm-llama70b · GPU.2.at.3%$/)).toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'GPU on ws1' })).getByRole('option', { selected: true })).toHaveTextContent(/^GPU 2 · was 3% busy · /);
    review();
    expect(screen.getByRole('heading', { name: 'Current load unknown' })).toBeInTheDocument();
    expect(screen.getByText('ws1 is not reporting; GPU 2 was 3% busy when it last reported, so its current load is unknown.')).toBeInTheDocument();
    expect(screen.queryByText(/idle/)).toBeNull();
  });

  it('turns a busy verdict stale when the browser loses the console while the review is open', () => {
    cluster([{ info: WS1, sample: wsWith({ 2: 40 }) }]);
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={noop} initialNodes={['ws1']} initialGpuIndex={{ ws1: 2 }} />);
    review();
    expect(screen.getByRole('heading', { name: 'It will compete with running work' })).toBeInTheDocument();
    act(() => { useConnection.setState({ status: 'reconnecting' }); });
    expect(screen.getByRole('heading', { name: 'Current load unknown' })).toBeInTheDocument();
    expect(screen.getByText('ws1 is not reporting; GPU 2 was 40% busy when it last reported, so its current load is unknown.')).toBeInTheDocument();
  });

  it('warns when the chosen GPU is busy, naming what runs on the node', () => {
    cluster([{ info: WS1, sample: wsWith({}) }]);
    render(<ConfigureDialog spec={WS_MATMUL} open onClose={noop} onRun={noop} initialNodes={['ws1']} />);
    review();
    expect(screen.getByRole('heading', { name: 'It will compete with running work' })).toBeInTheDocument();
    expect(screen.getByText('ws1 GPU 0 is 86% busy while ws1 is serving vllm-llama70b, which holds 161.7 GiB of GPU memory; results will be lower, the workload will slow down and the run may run out of GPU memory.')).toBeInTheDocument();
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

describe('the duration estimate of a benchmark timed on DGX Spark rates', () => {
  const footer = () => screen.getByText('Estimated').textContent.replace(/\s+/g, ' ');
  const fact = () => screen.getByText('Estimated duration').parentElement as HTMLElement;
  const WHY = 'Sparkline estimates this from DGX Spark rates, and ws1 is not a DGX Spark.';

  it('is shown as unknown on ws1, in the footer and the review, with why', () => {
    for (const spec of [{ ...LLM, availability: { spark1: null, ws1: null }, no_estimate: ['ws1'] }, { ...WS_MATMUL, no_estimate: ['ws1'] }]) {
      cluster([{ info: GB10, sample: GB10_SAMPLE }, { info: WS1, sample: wsWith({}) }]);
      const { unmount } = render(<ConfigureDialog spec={spec} open onClose={noop} onRun={noop} initialNodes={['ws1']} />);
      expect(footer()).toBe('Estimated —');
      expect(screen.getByText('ws1 is not a DGX Spark')).toBeInTheDocument();
      review();
      expect(within(fact()).getByText('—')).toBeInTheDocument();
      expect(within(fact()).getByText(WHY)).toBeInTheDocument();
      expect(screen.queryByText(/≈/)).toBeNull();
      unmount();
    }
  });

  it('is unknown for a run on spark1 and ws1 together, naming ws1 only', () => {
    cluster([{ info: GB10, sample: GB10_SAMPLE }, { info: WS1, sample: wsWith({}) }]);
    render(<ConfigureDialog spec={{ ...WS_MATMUL, no_estimate: ['ws1'] }} open onClose={noop} onRun={noop} initialNodes={['spark1', 'ws1']} />);
    expect(footer()).toBe('Estimated —');
    review();
    expect(within(fact()).getByText(WHY)).toBeInTheDocument();
  });

  it('keeps its estimate on a DGX Spark', () => {
    cluster([{ info: GB10, sample: GB10_SAMPLE }, { info: WS1, sample: wsWith({}) }]);
    render(<ConfigureDialog spec={{ ...WS_MATMUL, no_estimate: ['ws1'] }} open onClose={noop} onRun={noop} initialNodes={['spark1']} />);
    expect(footer()).toBe('Estimated ≈ 2 min');
    expect(screen.queryByText(/DGX Spark/)).toBeNull();
    review();
    expect(within(fact()).getByText('≈ 2 min')).toBeInTheDocument();
    expect(screen.queryByText(/DGX Spark/)).toBeNull();
  });
});

describe('measuring memory bandwidth from the CPU side of a multi-GPU node', () => {
  const side = (choice: string) => { fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Measure from' })).getByRole('radio', { name: choice })); };

  it('offers and names no GPU, and gives the GPU picked earlier back for the GPU side', () => {
    cluster([{ info: WS1, sample: wsWith({ 2: 3 }) }]);
    const onRun = vi.fn();
    const { baseElement } = render(<ConfigureDialog spec={WS_MEMBW} open onClose={noop} onRun={onRun} initialNodes={['ws1']} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'GPU on ws1' }), { target: { value: '2' } });

    side('CPU');
    expect(screen.queryByRole('combobox', { name: /GPU/ })).toBeNull();
    expect(baseElement.textContent).not.toMatch(GPU_NUMBER);
    side('GPU');
    expect(screen.getByRole('combobox', { name: 'GPU on ws1' })).toHaveValue('2');

    side('CPU');
    review();
    expect(screen.getByText('Runs Unified memory bandwidth on ws1.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nothing to compete with' })).toBeInTheDocument();
    expect(screen.getByText('ws1 CPUs are mostly idle (11%).')).toBeInTheDocument();
    expect(baseElement.textContent).not.toMatch(GPU_NUMBER);
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    expect(onRun).toHaveBeenCalledWith(['ws1'], { side: 'cpu', iterations: 20 }, {});
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
        if (url.startsWith('/api/v1/bench/catalog')) return reply([WS_MATMUL, WS_MEMBW]);
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

  it('sends no GPU for a run that measures only from the CPU', async () => {
    home('/benchmarks?configure=mem-bandwidth');
    fireEvent.click(await screen.findByRole('checkbox', { name: /^ws1/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^spark1/ }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Measure from' })).getByRole('radio', { name: 'CPU' }));
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await waitFor(() => { expect(posted).toHaveLength(1); });
    expect(posted[0]).toEqual({ bench_id: 'mem-bandwidth', nodes: ['ws1'], params: { side: 'cpu', iterations: 20 }, confirm: true });
  });
});

describe('a run on a chosen GPU', () => {
  const now = () => Date.now() / 1000;
  const urls: string[] = [];
  beforeEach(() => {
    urls.length = 0;
    charts.length = 0;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn((url: string) => { urls.push(url); return new Promise(() => undefined); }));
    cluster([{ info: GB10, sample: GB10_SAMPLE }, { info: WS1, sample: wsWith({ 2: 3 }) }]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useBench.setState({ runs: {} });
  });

  const show = (r: BenchRun) => {
    useBench.setState({ runs: { [r.id]: r } });
    return render(<RunView id={r.id} />);
  };
  const subLine = () => (document.querySelector('.bench-run__sub')?.textContent ?? '').split(/\s*·\s*/).filter(Boolean);
  const live = (p: Partial<BenchRun> & Pick<BenchRun, 'id'>) => run({ status: 'running', progress: 0.01, created_ts: now() - 30, started_ts: now() - 30, finished_ts: null, ...p });
  const metaOf = (node: string, metadata: Record<string, unknown>) => ({ [node]: nodeState({ node_id: node, bench_id: 'gpu-matmul', metadata }) });

  it('names the GPU in the header, from the run metadata, and lists its index with the metadata', () => {
    show(run({ id: 'r-ws1', nodes: ['ws1'], gpu_index: { ws1: 2 }, metadata: { nodes: { ws1: { gpu_index: 2, gpu_name: RTX } } } }));
    expect(subLine().slice(0, 4)).toEqual(['ws1', 'GPU 2', RTX, expect.stringMatching(/^Started /)]);
    const meta = screen.getByRole('region', { name: 'Metadata' });
    expect(within(meta).getByText('GPU index').nextElementSibling).toHaveTextContent(/^2$/);
  });

  it('names the GPU on the placeholder run before the console answers', () => {
    show(run({ id: 'pending-x', status: 'queued', nodes: ['ws1'], gpu_index: { ws1: 3 }, started_ts: null, finished_ts: null, progress: 0 }));
    expect(subLine().slice(0, 2)).toEqual(['ws1', 'GPU 3']);
  });

  it('adds nothing to the header of a GB10 run', () => {
    show(run({ id: 'r-spark1', metadata: { nodes: { spark1: { gpu_name: 'NVIDIA GB10' } } } }));
    expect(subLine().slice(0, 2)).toEqual(['spark1', expect.stringMatching(/^Started /)]);
    expect(document.querySelector('.bench-run__sub')?.textContent).not.toMatch(GPU_NUMBER);
  });

  it('gives no time left when the agent has no estimate for this machine, and keeps it on GB10', () => {
    const { unmount } = show(live({ id: 'r-ws1', nodes: ['ws1'], gpu_index: { ws1: 2 }, node_states: metaOf('ws1', { est_duration_s: null }) }));
    expect(screen.getByText('Remaining').nextElementSibling).toHaveTextContent(/^—$/);
    expect(screen.getByText('Expected total').nextElementSibling).toHaveTextContent(/^—$/);
    unmount();
    show(live({ id: 'r-spark1', node_states: metaOf('spark1', { est_duration_s: 120 }) }));
    expect(screen.getByText('Remaining').nextElementSibling).toHaveTextContent(/^≈ /);
    expect(screen.getByText('Expected total').nextElementSibling).toHaveTextContent(/^≈ /);
  });

  it('says why it gives no time left, naming only the nodes that are not DGX Sparks', () => {
    const progress = () => screen.getByRole('region', { name: 'Progress' });
    const { unmount } = show(live({ id: 'r-ws1', nodes: ['ws1'], gpu_index: { ws1: 2 }, node_states: metaOf('ws1', { est_duration_s: null }) }));
    expect(within(progress()).getByText('Sparkline estimates run time from DGX Spark rates, and ws1 is not a DGX Spark.')).toBeInTheDocument();
    unmount();
    const both = { ...metaOf('spark1', { est_duration_s: 120 }), ...metaOf('ws1', { est_duration_s: null }) };
    const second = show(live({ id: 'r-both', nodes: ['spark1', 'ws1'], gpu_index: { ws1: 2 }, node_states: both }));
    expect(within(progress()).getByText('Sparkline estimates run time from DGX Spark rates, and ws1 is not a DGX Spark.')).toBeInTheDocument();
    second.unmount();
    show(live({ id: 'r-spark1', node_states: metaOf('spark1', { est_duration_s: 120 }) }));
    expect(within(progress()).queryByText(/DGX Spark/)).toBeNull();
  });

  it('gives no time left in the list of runs in progress either', () => {
    useBench.setState({ runs: { a: live({ id: 'a', nodes: ['ws1'], gpu_index: { ws1: 2 }, node_states: metaOf('ws1', { est_duration_s: null }) }), b: live({ id: 'b', node_states: metaOf('spark1', { est_duration_s: 120 }) }) } });
    home('/benchmarks');
    const items = within(screen.getByRole('list', { name: 'Runs in progress' })).getAllByRole('link');
    const on = (node: string) => items.find((i) => i.textContent.includes(`on ${node}`));
    expect(on('ws1')).not.toHaveTextContent('left');
    expect(on('spark1')).toHaveTextContent(/ left/);
  });

  const utilSeries = () => charts.filter((c) => c.title === 'GPU utilisation').at(-1)?.series.map((x) => [x.label, x.values.filter((v) => v != null)]);

  it("charts the chosen GPU's live telemetry, and GPU 0 on a GB10 node", () => {
    render(<RunTelemetry run={live({ id: 'r', nodes: ['spark1', 'ws1'], gpu_index: { ws1: 2 } })} category="compute" expected={90} />);
    expect(utilSeries()).toEqual([['spark1', [62.4]], ['ws1', [3]]]);
  });

  it("asks the history for the chosen GPU's series once the run is over", () => {
    liveStore.removeNode('ws1');
    const done = run({ id: 'r', nodes: ['ws1'], gpu_index: { ws1: 2 }, started_ts: now() - 600, finished_ts: now() - 500 });
    render(<RunTelemetry run={done} category="compute" expected={100} />);
    const asked = urls.filter((u) => u.startsWith('/api/v1/history')).map((u) => new URLSearchParams(u.split('?')[1]).get('keys'));
    expect(asked).toEqual(['gpu2.util,gpu2.temp_c,gpu2.power_w,gpu2.sm_mhz']);
  });

  it("analyses a soak recorded on GPU 2 from its gpu2 series", () => {
    const t = Array.from({ length: 181 }, (_, i) => i);
    const soak = run({
      id: 'soak',
      bench_id: SOAK.id,
      nodes: ['ws1'],
      gpu_index: { ws1: 2 },
      params: { minutes: 10 },
      started_ts: 1_759_750_000,
      finished_ts: 1_759_750_180,
      series: {
        'ws1.t': t,
        'ws1.gpu2.sm_mhz': t.map((i) => (i % 2 ? 2400 : 2500)),
        'ws1.gpu2.temp_c': t.map((i) => 60 + Math.min(21, i / 5)),
        'ws1.gpu2.power_w': t.map(() => 290),
        'ws1.gpu2.throttle_mask': t.map(() => 0),
        'ws1.gpu2.util': t.map(() => 100),
        'ws1.tflops': t.map(() => 300),
      },
    });
    render(<SoakPanel run={soak} expected={180} />);
    const stats = screen.getByRole('region', { name: 'ws1 soak summary' });
    expect(within(stats).getByText('Peak temperature').nextElementSibling).toHaveTextContent(/^81\s°C$/);
    expect(within(stats).getByText('Clock variation').nextElementSibling).toHaveTextContent(/^2\.0%$/);
    expect(within(stats).getByText('Time throttled').nextElementSibling).toHaveTextContent(/^0(\.0)?%$/);
  });
});
