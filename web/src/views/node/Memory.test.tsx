import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { GpuInfo, NodeInfo, NodeState, Sample } from '../../lib/types';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../test/fixtures/platforms/gb10/sample.json';
import wsInfo from '../../test/fixtures/platforms/workstation/info.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import Memory from './Memory';

vi.mock('uplot', () => {
  class FakePlot {
    static pxRatio = 1;
    static fmtDate = () => () => '';
    bbox = { left: 0, top: 0, width: 600, height: 120 };
    setData() {}
    setScale() {}
    setSize() {}
    destroy() {}
  }
  return { default: FakePlot };
});

const NODE = 'mtest';
const TS = 1_800_000_000;
const GiB = 1024 ** 3;
const PSI_REASON = 'Pressure stall information is not exposed: /proc/pressure/memory is missing (kernel without CONFIG_PSI, or psi=0)';

const info = (unsupported: NodeInfo['unsupported']) =>
  ({ node_id: NODE, mem_total: 128 * GiB, swap_total: 16 * GiB, gpus: [], cores: [], net: [], disks: [], sensors: [], unsupported }) as unknown as NodeInfo;

const sample = (psi: number | null): Sample => ({
  node_id: NODE, ts: TS, seq: 1, interval_ms: 1000, gpu: [],
  mem: { total: 128 * GiB, available: 110 * GiB, used: 12 * GiB, free: 100 * GiB, gpu: null, anon: 5 * GiB, cache: 2 * GiB, shmem: 1 * GiB, kernel: 2 * GiB, other: 2 * GiB, swap_total: 16 * GiB, swap_used: 3 * GiB, psi_some: psi, psi_full: psi },
  cpu: { util: 0, perf_util: null, eff_util: null, per_core: [], freq_mhz: [], load1: 0, load5: 0, load15: 0, psi_some: null },
  net: [], disk: [], fs: [], temps: [], procs: null, errors: {},
});

const show = (unsupported: NodeInfo['unsupported'], psi: number | null) => {
  const node: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: 0, last_sample_ts: TS, error: null, info: info(unsupported), next_retry_ts: null };
  useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
  act(() => {
    liveStore.pushSample(sample(psi));
    liveStore.flush();
  });
  render(<Memory nodeId={NODE} />);
  return screen.getByRole('region', { name: 'Memory pressure' });
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  liveStore.removeNode(NODE);
  usePrefs.setState({ timeRange: 'live' });
  useConnection.setState({ status: 'live', everLive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Memory pressure panel', () => {
  it('says once why pressure is not reported when the kernel exposes no PSI', () => {
    const psi = show([
      { metric: 'mem.psi_some', reason: PSI_REASON, kind: 'hardware' },
      { metric: 'mem.psi_full', reason: PSI_REASON, kind: 'hardware' },
    ], null);
    expect(within(psi).getAllByText('Not reported by this hardware')).toHaveLength(1);
    expect(within(psi).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(PSI_REASON);
  });

  it('says how much processes waited when PSI is reported', () => {
    const psi = show([], 0);
    expect(within(psi).queryByText('Not reported by this hardware')).not.toBeInTheDocument();
    expect(within(psi).getByText('No memory pressure')).toBeInTheDocument();
  });
});

describe('Memory tab by memory model', () => {
  const LOST = 'NVML could not open GPU 2 (NVML: GPU is lost)';
  const dedicated = (info: NodeInfo, over: (g: GpuInfo) => Partial<GpuInfo> = () => ({})): NodeInfo => ({
    ...info,
    node_id: NODE,
    gpus: info.gpus.map((g) => ({ ...g, memory: 'dedicated', vram_total: 48 * GiB, ...over(g) })),
  });
  const ws1 = (unsupported: NodeInfo['unsupported'] = [], over?: (g: GpuInfo) => Partial<GpuInfo>) =>
    dedicated({ ...(wsInfo as unknown as NodeInfo), unsupported: [...(wsInfo as unknown as NodeInfo).unsupported, ...unsupported] }, over);
  const ws1Sample = (gpu: (g: Sample['gpu'][number]) => Sample['gpu'][number] | null = (g) => g): Sample => {
    const s = wsSample as unknown as Sample;
    return { ...s, node_id: NODE, ts: TS, gpu: s.gpu.map((g) => gpu({ ...g, vram_used: (40 + g.index) * GiB })).filter((g) => g !== null) };
  };
  const open = (info: NodeInfo, s: Sample | null, status: NodeState['status'] = 'online') => {
    const node: NodeState = { node_id: NODE, url: 'http://x:9750', status, since: 0, last_sample_ts: TS, error: null, info, next_retry_ts: null };
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
    if (s) {
      act(() => {
        liveStore.pushSample({ ...s, node_id: NODE, ts: TS });
        liveStore.flush();
      });
    }
    render(<Memory nodeId={NODE} />);
  };
  const vram = () => within(screen.getByRole('region', { name: 'GPU memory' })).getAllByRole('listitem');
  const bar = (i: number) => vram()[i] as HTMLElement;

  it('shows a discrete workstation as system memory with no GPU segment, and one VRAM bar per GPU', () => {
    open(ws1(), ws1Sample());
    expect(screen.getByText('System memory', { selector: '.t-eyebrow' })).toBeInTheDocument();
    expect(screen.queryByText(/shared by CPU and GPU/)).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Memory breakdown' })).not.toHaveTextContent('GPU-allocated');
    expect(screen.getByRole('list', { name: 'System memory breakdown series' })).not.toHaveTextContent('GPU-allocated');
    expect(screen.getByText(/Each GPU has its own memory, shown under GPU memory/)).toBeInTheDocument();
    expect(vram().map((li) => li.querySelector('.visually-hidden')?.textContent.replaceAll('\u00a0', ' '))).toEqual([
      'GPU 0: 40.0 GiB of 48.0 GiB in use (83%).',
      'GPU 1: 41.0 GiB of 48.0 GiB in use (85%).',
      'GPU 2: 42.0 GiB of 48.0 GiB in use (88%).',
      'GPU 3: 43.0 GiB of 48.0 GiB in use (90%).',
    ]);
    expect(screen.getByRole('region', { name: 'GPU memory' })).toHaveTextContent('Each NVIDIA RTX 6000 Ada Generation’s own memory (VRAM), apart from system memory');
    expect(bar(0)).not.toHaveTextContent('NVIDIA');
  });

  it('names each card on its bar when the GPUs are different models', () => {
    open(ws1([], (g) => (g.index === 3 ? { name: 'NVIDIA RTX A4000' } : {})), ws1Sample());
    expect(screen.getByRole('region', { name: 'GPU memory' })).toHaveTextContent('Each GPU’s own memory (VRAM)');
    expect(bar(0)).toHaveTextContent('NVIDIA RTX 6000 Ada Generation');
    expect(bar(3)).toHaveTextContent('NVIDIA RTX A4000');
  });

  it('ranks top consumers by resident memory alone, with no total that adds VRAM', () => {
    open(ws1(), ws1Sample());
    const table = screen.getByRole('table', { name: `Top memory consumers on ${NODE}` });
    expect(within(table).queryByRole('columnheader', { name: /^Total/ })).not.toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /Resident \(RSS\)/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('region', { name: 'Top memory consumers' })).toHaveTextContent('GPU memory sits on each card');
  });

  it('holds a skeleton for each VRAM bar until the first sample', () => {
    open(ws1(), null);
    expect(vram()).toHaveLength(4);
    for (const li of vram()) expect(li).toHaveAttribute('aria-busy', 'true');
  });

  it('dims the VRAM bars with their age when the node stops reporting', () => {
    open(ws1(), ws1Sample(), 'stale');
    const panel = screen.getByRole('region', { name: 'GPU memory' });
    expect(panel).toHaveTextContent(/Updated (just now|.* ago)/);
    expect(panel.querySelector('.nvram--stale')).not.toBeNull();
    expect(bar(3)).toHaveTextContent('43.0 GiB');
  });

  it('says why a GPU sends no VRAM reading: declared, lost, silent this tick, or no data', () => {
    const access = 'NVML denied the memory query (MIG mode needs root)';
    const info = ws1([
      { metric: 'gpu1.vram_used', reason: access, kind: 'access' },
      { metric: 'gpu2', reason: LOST, kind: 'hardware' },
    ]);
    open(info, ws1Sample((g) => (g.index === 1 || g.index === 2 ? { ...g, vram_used: null } : g.index === 3 ? null : g)));
    expect(bar(1)).toHaveTextContent('No access');
    expect(within(bar(1)).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(access);
    expect(bar(2)).toHaveTextContent('GPU 2');
    expect(bar(2)).toHaveTextContent('Not responding');
    expect(bar(3)).toHaveTextContent('Not responding');
    cleanupAndOpen(info, ws1Sample((g) => (g.index === 0 ? { ...g, vram_used: null } : g)));
    expect(bar(0)).toHaveTextContent('No data');
  });

  it('shows the used figure alone when a GPU reports no VRAM total', () => {
    open(ws1([], (g) => (g.index === 0 ? { vram_total: null } : {})), ws1Sample());
    expect(bar(0)).toHaveTextContent('40.0 GiB');
    expect(bar(0)).toHaveTextContent('total not reported');
    expect(bar(0).querySelector('.nvram__bar > span')).toBeNull();
    expect(bar(1).querySelector('.nvram__bar > span')).not.toBeNull();
  });

  const gb10Strings = () => {
    expect(screen.getByText('Unified memory · shared by CPU and GPU')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Unified memory' })).toHaveTextContent('CPU and GPU share one pool of memory, so GPU allocations come out of the same 121.7 GiB. Page cache is file data the kernel keeps for speed and gives back when programs need it, which is why it counts toward available.');
    expect(screen.getByRole('list', { name: 'Memory breakdown' })).toHaveTextContent('GPU-allocated');
    expect(screen.getByRole('list', { name: 'Unified memory breakdown series' })).toHaveTextContent('GPU-allocated');
    expect(screen.getByRole('region', { name: 'Top memory consumers' })).toHaveTextContent('Resident memory plus GPU allocations, which share the same pool');
    expect(screen.getByRole('columnheader', { name: /^Total/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.queryByRole('region', { name: 'GPU memory' })).not.toBeInTheDocument();
  };

  it('reads a GB10 exactly as before', () => {
    open({ ...(gb10Info as unknown as NodeInfo), node_id: NODE }, gb10Sample);
    gb10Strings();
  });

  it('reads an older GB10 agent, with no memory model or shared memory, exactly as before', () => {
    const info = gb10Info as unknown as NodeInfo;
    const old = { ...info, node_id: NODE, gpus: info.gpus.map((g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'memory' && k !== 'vram_total')) as unknown as GpuInfo) };
    const s = gb10Sample as unknown as Sample;
    open(old, { ...s, gpu: s.gpu.map((g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'shared_used' && k !== 'vram_used')) as unknown as Sample['gpu'][number]) });
    gb10Strings();
  });
});

function cleanupAndOpen(info: NodeInfo, s: Sample) {
  cleanup();
  liveStore.removeNode(NODE);
  useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { node_id: NODE, url: 'http://x:9750', status: 'online', since: 0, last_sample_ts: TS, error: null, info, next_retry_ts: null } } });
  act(() => {
    liveStore.pushSample({ ...s, node_id: NODE, ts: TS });
    liveStore.flush();
  });
  render(<Memory nodeId={NODE} />);
}
