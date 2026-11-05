import { act, render, screen, within } from '@testing-library/react';
import sampleJson from '../../../test/fixtures/sample.json';
import type { GpuInfo, NodeInfo, NodeState, Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useConnection } from '../../../store/connection';
import { liveStore } from '../../../store/live';
import { usePrefs } from '../../../store/prefs';
import Thermals from '../Thermals';
import { gpuAt } from '../../../lib/gpu';

vi.mock('../../../charts/TimeSeriesChart', async (importActual) => ({
  ...(await importActual<typeof import('../../../charts/TimeSeriesChart')>()),
  TimeSeriesChart: () => null,
}));

const NODE = 'ttest';
const info = {
  node_id: NODE,
  gpus: [{ index: 0, name: 'NVIDIA GB10', temp_slowdown_c: 86, temp_shutdown_c: 90, power_limit_w: null }],
  sensors: [
    { id: 'acpitz.0', label: 'ACPI zone 0', group: 'soc', crit_c: null },
    { id: 'nvme.composite', label: 'NVMe Composite', group: 'nvme', crit_c: 84.85 },
    { id: 'mlx5.0', label: 'ConnectX-7 ASIC', group: 'nic', crit_c: 105 },
  ],
  unsupported: [
    { metric: 'fan', reason: 'No fan sensors exposed by this hardware (hwmon)' },
    { metric: 'system.power_w', reason: 'Whole-system power is not exposed; only the GPU rail (NVML) is' },
    { metric: 'gpu0.power_limit_w', reason: 'Power limit not reported by NVIDIA GB10 (NVML: Not Supported)' },
  ],
} as unknown as NodeInfo;
const state = (status: NodeState['status']): NodeState => ({ node_id: NODE, url: 'http://x:9750', status, since: 0, last_sample_ts: 1_800_000_000, error: null, info, next_retry_ts: null });

describe('Thermals tab', () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver (used by the sparklines) or canvas; neither matters for these assertions.
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    liveStore.removeNode(NODE);
    usePrefs.setState({ timeRange: 'live' });
    useConnection.setState({ status: 'live', everLive: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ node_id: NODE, resolution_s: 10, ts: [], series: {}, min: {}, max: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('groups sensors, shows headroom, and states what the hardware does not report', () => {
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: state('online') } });
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: NODE, ts: 1_800_000_000 });
      liveStore.flush();
    });
    render(<Thermals nodeId={NODE} />);
    for (const name of ['GPU', 'SoC · ACPI zones', 'NVMe', 'ConnectX-7', 'GPU power', 'GPU energy']) expect(screen.getByRole('region', { name })).toBeInTheDocument();

    const gpu = within(screen.getByRole('region', { name: 'GPU' }));
    expect(gpu.getByRole('rowheader', { name: 'NVIDIA GB10' }).closest('tr')).toHaveTextContent(/15\s°C to slowdown/); // 86 - 71
    // A sensor with no reading shows a dash, never 0.
    expect(within(screen.getByRole('region', { name: 'NVMe' })).getByRole('rowheader', { name: 'NVMe Composite' }).closest('tr')).not.toHaveTextContent(/\b0\s°C/);

    expect(screen.getByText('Fans')).toBeInTheDocument();
    expect(screen.getByText('Whole-system power')).toBeInTheDocument();
    expect(screen.getByText(/GPU rail only, measured by NVML/)).toBeInTheDocument();
    expect(screen.getByText('Power limit')).toBeInTheDocument();
    expect(screen.getAllByText('Not reported by this hardware').length).toBeGreaterThanOrEqual(3);
  });

  it('shows the GPU power limit whenever the GPU reports one', () => {
    const withLimit = { ...info, gpus: [{ ...(gpuAt(info.gpus, 0) as GpuInfo), power_limit_w: 140 }], unsupported: info.unsupported.filter((u) => u.metric !== 'gpu0.power_limit_w') } as NodeInfo;
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { ...state('online'), info: withLimit } } });
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: NODE, ts: 1_800_000_000 });
      liveStore.flush();
    });
    render(<Thermals nodeId={NODE} />);
    const limit = within(screen.getByRole('region', { name: 'GPU power' })).getByText('Power limit').closest('.stat');
    expect(limit).toHaveTextContent('140');
    expect(limit).not.toHaveTextContent('Not reported');
  });

  it('says "No data" for fans and whole-system power from an agent that declares neither', () => {
    const older = { ...info, unsupported: [] };
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { ...state('online'), info: older } } });
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: NODE, ts: 1_800_000_000 });
      liveStore.flush();
    });
    render(<Thermals nodeId={NODE} />);
    expect(screen.getByText('Fans').closest('.stat')).toHaveTextContent('No data');
    expect(screen.getByText('Whole-system power').parentElement).toHaveTextContent('No data');
    expect(screen.queryByText('Not reported by this hardware')).not.toBeInTheDocument();
  });

  it('keeps last known values when the node is offline, from history seeded into the buffer', () => {
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: state('offline') } });
    act(() => {
      liveStore.seed({ node_id: NODE, resolution_s: 1, ts: [1_799_999_999], series: { 'gpu0.temp_c': [74], 'temp.acpitz.0': [66] }, min: {}, max: {} });
      liveStore.flush();
    });
    render(<Thermals nodeId={NODE} />);
    expect(screen.getByRole('region', { name: 'GPU' })).toHaveClass('is-stale');
    expect(within(screen.getByRole('region', { name: 'GPU' })).getByRole('rowheader', { name: 'NVIDIA GB10' }).closest('tr')).toHaveTextContent('74');
  });

  it('keeps the GPU temperature, power and energy from NVML when the board sensors could not be read', () => {
    const reason = 'The thermal collector could not start: /sys/class/hwmon: No such file or directory';
    const failed = { ...info, sensors: [], unsupported: ['temp', 'cpu.temp', 'fan', 'system.power_w'].map((metric) => ({ metric, reason, kind: 'hardware' })) } as unknown as NodeInfo;
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { ...state('online'), info: failed } } });
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: NODE, ts: 1_800_000_000, temps: [] });
      liveStore.flush();
    });
    render(<Thermals nodeId={NODE} />);

    expect(within(screen.getByRole('region', { name: 'GPU' })).getByRole('rowheader', { name: 'NVIDIA GB10' }).closest('tr')).toHaveTextContent(/15\s°C to slowdown/);
    expect(screen.getByText('GPU temperature').closest('.stat')).toHaveTextContent('71');
    expect(screen.getByText('GPU power', { selector: '.stat__label' }).closest('.stat')).toHaveTextContent('32.4');
    for (const name of ['GPU power', 'GPU energy']) expect(screen.getByRole('region', { name })).toBeInTheDocument();

    expect(screen.getByRole('region', { name: 'Board sensors' })).toHaveTextContent(reason);
    expect(screen.getByText('Hottest sensor').closest('.stat')).toHaveTextContent(/71\s?°C\s*NVIDIA GB10/);
    expect(screen.getByText('Hottest sensor').closest('.stat')).not.toHaveTextContent('Not reported');
    expect(screen.queryByRole('region', { name: 'SoC · ACPI zones' })).not.toBeInTheDocument();
  });

  it('says the hottest sensor is not reported when neither hwmon nor NVML reads a temperature', () => {
    const reason = 'No temperature sensors exposed (hwmon)';
    const nothing = {
      ...info,
      gpus: [],
      sensors: [],
      unsupported: [
        { metric: 'gpu*', reason: 'NVIDIA driver library (NVML) not found', kind: 'dependency' },
        ...['temp', 'cpu.temp'].map((metric) => ({ metric, reason, kind: 'hardware' })),
      ],
    } as unknown as NodeInfo;
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { ...state('online'), info: nothing } } });
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: NODE, ts: 1_800_000_000, gpu: [], temps: [] });
      liveStore.flush();
    });
    render(<Thermals nodeId={NODE} />);
    const hot = screen.getByText('Hottest sensor').closest('.stat');
    expect(hot).toHaveTextContent('Not reported by this hardware');
    expect(within(hot as HTMLElement).getByRole('button', { name: 'Why is this not reported?' })).toBeInTheDocument();
  });
});

describe('Thermals tab while the GPU backend fails a tick', () => {
  const NV_ERROR = 'RuntimeError: synthesized NVML read failure';
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    usePrefs.setState({ timeRange: 'live' });
    useConnection.setState({ status: 'live', everLive: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(Response.json({ node_id: NODE, resolution_s: 10, ts: [], series: {}, min: {}, max: {} })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const show = (sample: Partial<Sample>, nodeInfo: NodeInfo = info) => {
    liveStore.removeNode(nodeInfo.node_id);
    useCluster.setState({ clockOffset: 0, nodes: { [nodeInfo.node_id]: { ...state('online'), node_id: nodeInfo.node_id, info: nodeInfo } } });
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: nodeInfo.node_id, ts: 1_800_000_000, ...sample });
      liveStore.flush();
    });
    render(<Thermals nodeId={nodeInfo.node_id} />);
  };
  const energy = () => screen.getByText('GPU energy today').closest('.stat') as HTMLElement;
  const notes = () => screen.getByRole('list', { name: 'Metrics unavailable' });

  it("says today's GPU energy is not responding, like the temperature and power beside it, and names the silent GPU", () => {
    show({ gpu: [], errors: { gpu: `nvml: ${NV_ERROR}` } });
    expect(energy()).toHaveTextContent(/^GPU energy todayNot responding/);
    expect(energy()).not.toHaveTextContent('kWh');
    expect(within(energy()).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(`GPU 0 not responding (${NV_ERROR}).`);
    expect(notes()).toHaveTextContent(`GPU 0 (NVIDIA GB10) not responding: ${NV_ERROR}.`);
  });

  it('names the first silent GPU in the energy gap on a node with several', () => {
    const gpus = [0, 1].map((index) => ({ ...(gpuAt(info.gpus, 0) as GpuInfo), index, name: 'NVIDIA RTX 6000 Ada Generation' }));
    show({ gpu: [], errors: { gpu: `nvml: ${NV_ERROR}` } }, { ...info, node_id: 'ttest2', gpus });
    expect(energy()).toHaveTextContent(/^GPU energy todayNot responding/);
    expect(within(energy()).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(`GPU 0 not responding (${NV_ERROR}).`);
    expect(notes()).toHaveTextContent('GPUs 0 and 1 (NVIDIA RTX 6000 Ada Generation) not responding');
  });

  it('says when the temperature sensors fail a tick', () => {
    show({ errors: { thermal: 'OSError: hwmon vanished' } });
    expect(notes()).toHaveTextContent('Temperature sensors unavailable: OSError: hwmon vanished. Other panels are unaffected.');
  });

  it('shows no notice and no energy gap on a healthy GB10', () => {
    show({});
    expect(screen.queryByRole('list', { name: 'Metrics unavailable' })).not.toBeInTheDocument();
    expect(energy()).not.toHaveTextContent('Not responding');
  });
});
