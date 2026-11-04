import { act, render, screen, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../test/fixtures/platforms/gb10/sample.json';
import wsInfo from '../../test/fixtures/platforms/workstation/info.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
import type { SeriesSpec, Threshold } from '../../charts/TimeSeriesChart';
import { percentParts } from '../../lib/format';
import { gpuAt } from '../../lib/gpu';
import type { GpuInfo, GpuSample, NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import sampleJson from '../../test/fixtures/sample.json';
import type { ComponentType } from 'react';
import Gpu from './Gpu';
import Summary from './Summary';
import Thermals from './Thermals';

interface ChartProps { title: string; series: readonly SeriesSpec[]; thresholds?: readonly Threshold[] }
const charts: ChartProps[] = [];
vi.mock('../../charts/TimeSeriesChart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../charts/TimeSeriesChart')>()),
  TimeSeriesChart: (p: ChartProps) => {
    charts.push(p);
    return null;
  },
}));

interface Platform { info: NodeInfo; sample: Sample }
const platform = (info: unknown, sample: unknown): Platform => ({ info: info as NodeInfo, sample: sample as Sample });
const workstation = platform(wsInfo, wsSample);
const gb10 = platform(gb10Info, gb10Sample);

function show(p: Platform, { status = 'online', sample = p.sample, info = p.info }: { status?: NodeState['status']; sample?: Sample | null; info?: NodeInfo } = {}) {
  const id = info.node_id;
  liveStore.removeNode(id);
  useCluster.setState({ clockOffset: 0, nodes: { [id]: { node_id: id, url: '', status, since: 0, last_sample_ts: null, error: null, info, next_retry_ts: null } } });
  if (sample) {
    act(() => {
      liveStore.pushSample({ ...sample, ts: Date.now() / 1000 - 5 });
      liveStore.flush();
    });
  }
  return render(<Gpu nodeId={id} />);
}

const sections = () => screen.queryAllByRole('region', { name: /^GPU \d+$/ });
const section = (index: number) => screen.getByRole('region', { name: `GPU ${index}` });
const stat = (scope: HTMLElement, label: string) => {
  const el = within(scope).getByText(label, { selector: '.stat__label' }).closest('.stat');
  if (!(el instanceof HTMLElement)) throw new Error(`no stat ${label}`);
  return el;
};
const withGpu = (s: Sample, index: number, over: Partial<Sample['gpu'][number]>): Sample => ({ ...s, gpu: s.gpu.map((g) => (g.index === index ? { ...g, ...over } : g)) });

const NODE = 'gtest';
const TS = 1_800_000_000;
const NV_ERROR = 'RuntimeError: NVML read failed';

const gpuInfo = (index: number, name: string, vendor: string, backend: string) =>
  ({ index, name, vendor, backend, uuid: null, arch: null, compute_capability: null, cuda_cores: null, sm_mhz_max: 3000, temp_slowdown_c: 86, temp_shutdown_c: 90, temp_max_c: null, power_limit_w: null }) as GpuInfo;

const hybrid = {
  node_id: NODE, platform: 'linux', versions: {}, gpus: [
    gpuInfo(0, 'NVIDIA GB10', 'nvidia', 'nvml'),
    gpuInfo(1, 'Radeon 8060S', 'amd', 'amdgpu-sysfs'),
    gpuInfo(2, 'Radeon RX 7900 XTX', 'amd', 'amdgpu-sysfs'),
  ], cores: [], net: [], disks: [], sensors: [], unsupported: [],
} as unknown as NodeInfo;

const base = sampleJson as unknown as Sample;
const reading = (index: number, util: number, temp_c: number, power_w: number): GpuSample => ({ ...(gpuAt(base.gpu, 0) as GpuSample), index, util, temp_c, power_w });

const showHybrid = (sample: Sample, info: NodeInfo = hybrid, panel = 'GPU 0', View: ComponentType<{ nodeId: string }> = Gpu) => {
  const node: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: 0, last_sample_ts: TS, error: null, info, next_retry_ts: null };
  liveStore.removeNode(NODE);
  useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
  act(() => {
    liveStore.pushSample({ ...sample, node_id: NODE, ts: TS });
    liveStore.flush();
  });
  render(
    <Router hook={memoryLocation({ path: '/' }).hook}>
      <View nodeId={NODE} />
    </Router>,
  );
  return screen.getByRole('region', { name: panel });
};

beforeEach(() => {
  charts.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  usePrefs.setState({ timeRange: 'live' });
  useConnection.setState({ status: 'live', everLive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GPU tab on a multi-GPU node', () => {
  it('shows one section per GPU in index order, each with its name and live values', () => {
    show(workstation);
    expect(sections().map((s) => s.getAttribute('aria-label'))).toEqual(workstation.info.gpus.map((g) => `GPU ${g.index}`));
    for (const g of workstation.info.gpus) {
      const reading = workstation.sample.gpu.find((x) => x.index === g.index)?.util;
      if (reading == null) throw new Error(`fixture GPU ${g.index} has no utilisation`);
      const util = percentParts(reading);
      expect(within(section(g.index)).getByText(g.name)).toBeInTheDocument();
      expect(stat(section(g.index), 'Utilisation')).toHaveTextContent(`${util.value}${util.unit}`);
    }
    expect(screen.getByRole('heading', { name: 'All GPUs' })).toBeInTheDocument();
  });

  it('raises a GPU at its slowdown point in that GPU’s own section only', () => {
    const last = gpuAt(workstation.info.gpus, 3);
    if (!last?.temp_slowdown_c) throw new Error('fixture GPU has no slowdown point');
    show(workstation, { sample: withGpu(workstation.sample, last.index, { temp_c: last.temp_slowdown_c, throttle_mask: 0x20 }) });
    expect(stat(section(last.index), 'Temperature')).toHaveTextContent(/At slowdown/);
    expect(within(section(last.index)).getByText('Thermal limit', { selector: '.status__label' })).toBeInTheDocument();
    for (const g of workstation.info.gpus.filter((x) => x.index !== last.index)) expect(stat(section(g.index), 'Temperature')).not.toHaveTextContent(/At slowdown/);
  });

  it('badges each section with its clock-limit status', () => {
    const a = gpuAt(workstation.info.gpus, 0);
    const b = gpuAt(workstation.info.gpus, 1);
    if (!a || !b) throw new Error('fixture has fewer than two GPUs');
    show(workstation, { sample: withGpu(withGpu(workstation.sample, a.index, { throttle_mask: 0 }), b.index, { throttle_mask: 0x4 }) });
    expect(within(section(a.index)).getByText('Not limited')).toBeInTheDocument();
    expect(within(section(b.index)).getByText('Power cap', { selector: '.status__label' })).toBeInTheDocument();
  });

  it('lists a section’s warning and critical clock-limit reasons, leaving the informational ones to its headline', () => {
    const a = gpuAt(workstation.info.gpus, 0);
    const b = gpuAt(workstation.info.gpus, 1);
    if (!a || !b) throw new Error('fixture has fewer than two GPUs');
    show(workstation, { sample: withGpu(withGpu(workstation.sample, a.index, { throttle_mask: 0x4 }), b.index, { throttle_mask: 0x64 }) });
    const rows = (index: number) => within(section(index)).queryAllByRole('listitem').map((li) => li.querySelector('.throttle__title')?.textContent);
    expect(rows(a.index)).toEqual([]);
    expect(rows(b.index)).toEqual(['Overheating', 'Thermal limit']);
  });

  it('reads power against each GPU’s own limit, with no single-GPU rail wording', () => {
    show(workstation);
    for (const g of workstation.info.gpus) expect(stat(section(g.index), 'GPU power')).toHaveTextContent(/% of the .+ limit/);
    expect(screen.queryByText(/GPU rail/)).not.toBeInTheDocument();
  });

  it('shows skeletons in every section until the first sample, then values', () => {
    const { unmount } = show(workstation, { sample: null });
    for (const s of sections()) {
      expect(s).toHaveAttribute('aria-busy', 'true');
      expect(s.querySelector('.skeleton')).not.toBeNull();
    }
    unmount();
    show(workstation);
    for (const s of sections()) expect(s).not.toHaveAttribute('aria-busy');
  });

  it('replaces a section with a notice when the latest sample has no reading for that GPU', () => {
    const gone = gpuAt(workstation.info.gpus, 2);
    if (!gone) throw new Error('fixture has fewer than three GPUs');
    show(workstation, { sample: { ...workstation.sample, gpu: workstation.sample.gpu.filter((g) => g.index !== gone.index) } });
    const empty = section(gone.index);
    expect(within(empty).getByText(`GPU ${gone.index} not responding`)).toBeInTheDocument();
    expect(within(empty).queryByText('Utilisation')).not.toBeInTheDocument();
    for (const g of workstation.info.gpus.filter((x) => x.index !== gone.index)) {
      expect(within(section(g.index)).queryByText(/not responding/)).not.toBeInTheDocument();
      expect(stat(section(g.index), 'Utilisation')).not.toHaveTextContent('—');
    }
  });

  it('dims every section’s values and says how old they are once the node stops reporting', () => {
    show(workstation, { status: 'stale' });
    for (const s of sections()) {
      expect(within(s).getByText(/^Updated /)).toBeInTheDocument();
      expect(stat(s, 'Utilisation')).toHaveClass('stat--stale');
    }
  });

  it('shows "not reported" on the GPU an unsupported entry names, and on every GPU for a wildcard', () => {
    const target = gpuAt(workstation.info.gpus, 2);
    if (!target) throw new Error('fixture has fewer than three GPUs');
    const unsupported = [
      { metric: `gpu${target.index}.power_w`, reason: 'No power sensor on this board.' },
      { metric: 'gpu*.pstate', reason: 'No performance states.' },
    ];
    show(workstation, { info: { ...workstation.info, unsupported } });
    for (const g of workstation.info.gpus) {
      const power = stat(section(g.index), 'GPU power');
      if (g.index === target.index) expect(power).toHaveTextContent('Not reported by this hardware');
      else expect(power).not.toHaveTextContent('Not reported');
      expect(stat(section(g.index), 'Performance state')).toHaveTextContent('Not reported by this hardware');
    }
  });

  it('draws every comparison chart with one series per GPU, labelled and coloured by its index like its section', () => {
    show(workstation);
    const expected = workstation.info.gpus.map((g) => expect.objectContaining({ label: `GPU ${g.index}`, gpu: g.index }) as unknown);
    const comparison = ['GPU utilisation', 'SM clock', 'GPU temperature', 'GPU power'];
    for (const title of comparison) {
      const chart = charts.findLast((c) => c.title === title);
      expect(chart?.series, title).toEqual(expected);
    }
    for (const g of workstation.info.gpus) {
      const swatch = section(g.index).querySelector<HTMLElement>('.ngpu-section__swatch');
      expect(swatch?.style.background).toBe(`var(--gpu-${g.index})`);
    }
  });

  it('draws slowdown and shutdown lines on the temperature chart only when every GPU shares them', () => {
    const temps = () => charts.findLast((c) => c.title === 'GPU temperature')?.thresholds ?? [];
    const { unmount } = show(workstation);
    expect(temps().map((t) => t.tone)).toEqual(['warn', 'crit']);
    unmount();
    const first = gpuAt(workstation.info.gpus, 0);
    if (!first) throw new Error('fixture has no GPUs');
    const differs = { ...first, temp_slowdown_c: (first.temp_slowdown_c ?? 80) - 5 };
    show(workstation, { info: { ...workstation.info, gpus: workstation.info.gpus.map((g) => (g.index === first.index ? differs : g)) } });
    expect(temps()).toEqual([]);
  });
});

describe('GPU tab on a single-GPU node', () => {
  it('keeps the single-GPU layout: no per-GPU sections, the "now" panel and the GPU’s own charts', () => {
    show(gb10);
    const gpu = gpuAt(gb10.info.gpus, 0);
    expect(gb10.info.gpus).toHaveLength(1);
    expect(sections()).toEqual([]);
    expect(screen.getByRole('region', { name: `${gpu?.name ?? ''} now` })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Clock limits' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'All GPUs' })).not.toBeInTheDocument();
    expect(charts.findLast((c) => c.title === 'GPU utilisation')?.series).toEqual([{ key: `gpu${gpu?.index ?? 0}.util`, label: 'Utilisation' }]);
  });
});

describe('GPU tab on a node with two vendors', () => {
  it("shows GPU 0 as not responding when only GPUs 1 and 2 report, never another GPU's numbers", () => {
    const gpu0 = showHybrid({ ...base, gpu: [reading(1, 37, 61, 140), reading(2, 57, 64, 240)], errors: { gpu: `nvml: ${NV_ERROR}` } });

    expect(within(gpu0).queryByText('37')).not.toBeInTheDocument();
    expect(within(gpu0).queryByText('61')).not.toBeInTheDocument();
    expect(within(gpu0).queryByText('140')).not.toBeInTheDocument();
    expect(within(gpu0).getByText('GPU 0 not responding')).toBeInTheDocument();
    expect(gpu0).toHaveTextContent(NV_ERROR);
    expect(within(section(1)).getByText('37')).toBeInTheDocument();
  });

  it('names the failing backend and its GPU in the notice, and says the other GPUs still report', () => {
    showHybrid({ ...base, gpu: [reading(1, 37, 61, 140), reading(2, 57, 64, 240)], errors: { gpu: `nvml: ${NV_ERROR}` } });

    const note = screen.getByRole('list', { name: 'Metrics unavailable' });
    expect(note).toHaveTextContent(`GPU 0 (NVIDIA GB10) not responding: ${NV_ERROR}`);
    expect(note).toHaveTextContent('The nvml backend sent no reading this tick. GPUs 1 and 2 still report.');
    expect(note).not.toHaveTextContent('GPU metrics unavailable');
  });

  it('shows GPU 0 numbers when GPU 0 reports, wherever it sits in the sample', () => {
    const gpu0 = showHybrid({ ...base, gpu: [reading(2, 57, 64, 240), reading(0, 91, 71, 32.4)], errors: {} });

    expect(within(gpu0).getByText('91')).toBeInTheDocument();
    expect(within(gpu0).queryByText('57')).not.toBeInTheDocument();
    expect(within(gpu0).queryByText(/not responding/i)).not.toBeInTheDocument();
  });

  it('ends the error with a full stop before the note says what it means', () => {
    showHybrid({ ...base, gpu: [reading(1, 37, 61, 140), reading(2, 57, 64, 240)], errors: { gpu: `nvml: ${NV_ERROR}` } });

    expect(screen.getByRole('list', { name: 'Metrics unavailable' })).toHaveTextContent(`${NV_ERROR}. The nvml backend sent no reading this tick.`);
  });

  it.each([
    ['Summary', 'At a glance', Summary, ['GPU utilisation', 'GPU temperature', 'GPU power']],
    ['Thermals', `${NODE} thermals and power summary`, Thermals, ['GPU temperature', 'GPU power']],
  ] as const)('says GPU 0 is not responding on %s too when its backend misses a tick', (_, panel, View, labels) => {
    const now = showHybrid({ ...base, gpu: [reading(1, 37, 61, 140), reading(2, 57, 64, 240)], errors: { gpu: `nvml: ${NV_ERROR}` } }, hybrid, panel, View);

    for (const label of labels) {
      const stat = within(now).getByText(label).closest('.stat');
      expect(stat).toHaveTextContent('Not responding');
      expect(stat).not.toHaveTextContent('No data');
    }
  });

  it('does not count a lost GPU as still reporting when another backend misses a tick', () => {
    const lost = 'NVML could not open GPU 0 (NVML: GPU is lost)';
    showHybrid({ ...base, gpu: [{ index: 0 } as GpuSample], errors: { gpu: 'amdgpu-sysfs: RuntimeError: boom' } }, { ...hybrid, unsupported: [{ metric: 'gpu0', reason: lost, kind: 'hardware' }] });

    const note = screen.getByRole('list', { name: 'Metrics unavailable' });
    expect(note).not.toHaveTextContent('still report');
    expect(note).toHaveTextContent('GPU metrics unavailable: amdgpu-sysfs: RuntimeError: boom. Other panels are unaffected.');
  });

  it('shows GPU 0 as not responding when the agent declares it lost', () => {
    const lost = 'NVML could not open GPU 0 (NVML: GPU is lost)';
    const gpus = [gpuInfo(0, 'GPU 0', 'nvidia', 'nvml')];
    const fields = ['util', 'temp_c', 'power_w', 'sm_mhz'].map((f) => ({ metric: `gpu0.${f}`, reason: lost, kind: 'hardware' as const }));
    const now = showHybrid({ ...base, gpu: [{ index: 0 } as GpuSample], errors: {} }, { ...hybrid, gpus, unsupported: [{ metric: 'gpu0', reason: lost, kind: 'hardware' }, ...fields] }, 'GPU 0 now');

    expect(within(now).getAllByText('Not responding').length).toBeGreaterThanOrEqual(4);
    expect(within(now).queryByText('Not reported by this hardware')).not.toBeInTheDocument();
    expect(within(now).getAllByRole('button', { name: 'Why is this not reported?' })[0]).toHaveAccessibleDescription(lost);
  });
});
