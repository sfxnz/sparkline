import { act, render, screen, within } from '@testing-library/react';
import sampleJson from '../../../test/fixtures/sample.json';
import type { NodeInfo, NodeState, Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useConnection } from '../../../store/connection';
import { liveStore } from '../../../store/live';
import { usePrefs } from '../../../store/prefs';
import Thermals from '../Thermals';

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
});
