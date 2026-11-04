import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CoreInfo, NetIfInfo, NodeInfo, NodeState, Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useConnection } from '../../../store/connection';
import { liveStore } from '../../../store/live';
import { usePrefs } from '../../../store/prefs';
import Cpu from '../Cpu';
import Gpu from '../Gpu';
import Network from '../Network';
import Storage from '../Storage';
import Summary from '../Summary';

vi.mock('../../../charts/TimeSeriesChart', async (importActual) => ({
  ...(await importActual<typeof import('../../../charts/TimeSeriesChart')>()),
  TimeSeriesChart: () => null,
}));

const NODE = 'btest';
const TS = 1_800_000_000;
const TiB = 1024 ** 4;
const nif = (name: string, role: NetIfInfo['role'], label: string, extra: Partial<NetIfInfo> = {}): NetIfInfo => ({ name, role, label, mac: null, ipv4: [], speed_mbps: null, rdma_device: null, counter_source: 'netdev', peer: null, ...extra });
const cores: CoreInfo[] = [
  { id: 0, kind: 'efficiency', model: 'Cortex-A725', max_mhz: 2808, cluster: 0 },
  { id: 1, kind: 'performance', model: 'Cortex-X925', max_mhz: 3900, cluster: 0 },
  { id: 2, kind: 'efficiency', model: 'Cortex-A725', max_mhz: 2808, cluster: 1 },
  { id: 3, kind: 'performance', model: 'Cortex-X925', max_mhz: 3900, cluster: 1 },
];
const info = {
  node_id: NODE,
  cores,
  net: [
    nif('railA', 'interconnect', 'ConnectX-7 rail A', { peer: 'spark2', speed_mbps: 200_000, rdma_device: 'rocep1s0f1', counter_source: 'netdev_rdma' }),
    nif('spare0', 'interconnect', 'ConnectX-7 port (no cable)', { rdma_device: 'rocep1s0f0' }),
    nif('lan0', 'lan', 'LAN', { speed_mbps: 10_000 }),
    nif('docker0', 'virtual', 'Docker bridge'),
    nif('wlan0', 'wireless', 'Wi-Fi'),
  ],
  disks: [{ name: 'nvme0n1', model: 'Samsung MZALC4T0HBL1-00B07', size_bytes: 4e12, mounts: ['/', '/data'] }],
  sensors: [
    { id: 'nvme.composite', label: 'NVMe Composite', group: 'nvme', crit_c: 84.85 },
    { id: 'nvme.sensor_1', label: 'NVMe Sensor 1', group: 'nvme', crit_c: null },
  ],
  unsupported: [],
} as unknown as NodeInfo;

function sample(over: Partial<Sample> = {}): Sample {
  return {
    node_id: NODE, ts: TS, seq: 1, interval_ms: 1000, gpu: [],
    mem: { total: 1, available: 1, used: 0, free: 1, gpu: null, anon: 0, cache: 0, shmem: 0, kernel: 0, other: 0, swap_total: 0, swap_used: 0, psi_some: null, psi_full: null },
    cpu: { util: 40, perf_util: 70, eff_util: 10, per_core: [10, 80, 10, 60], freq_mhz: [2100, 3880, 2100, 3850], load1: 4.2, load5: 3.1, load15: 2.9, psi_some: 0.4 },
    net: [
      { name: 'railA', up: true, speed_mbps: 200_000, rx_bps: 12.5e9, tx_bps: 1e9, errors: 0, drops: 0, rdma_state: 'ACTIVE', rdma_rate: '200 Gb/sec (4X HDR)' },
      { name: 'spare0', up: false, speed_mbps: null, rx_bps: 0, tx_bps: 0, errors: 0, drops: 0, rdma_state: 'DOWN', rdma_rate: null },
      { name: 'lan0', up: true, speed_mbps: 10_000, rx_bps: 125e3, tx_bps: 250e3, errors: 0, drops: 0, rdma_state: null, rdma_rate: null },
      { name: 'docker0', up: true, speed_mbps: null, rx_bps: 0, tx_bps: 0, errors: 0, drops: 0, rdma_state: null, rdma_rate: null },
      { name: 'wlan0', up: false, speed_mbps: null, rx_bps: 0, tx_bps: 0, errors: 0, drops: 0, rdma_state: null, rdma_rate: null },
    ],
    disk: [{ name: 'nvme0n1', read_bps: 2.05e9, write_bps: 16e6, read_iops: 16_200, write_iops: 980, busy_pct: 56 }],
    fs: [
      { mount: '/', key: 'root', device: '/dev/nvme0n1p2', total: 4 * TiB, used: 3.6 * TiB, free: 0.4 * TiB },
      { mount: '/data', key: 'data', device: '/dev/nvme0n1p3', total: 1 * TiB, used: 0.96 * TiB, free: 0.04 * TiB },
    ],
    temps: [{ id: 'nvme.composite', c: 51 }, { id: 'nvme.sensor_1', c: 60 }],
    procs: null,
    errors: {},
    ...over,
  };
}

const state = (status: NodeState['status']): NodeState => ({ node_id: NODE, url: 'http://x:9750', status, since: 0, last_sample_ts: TS, error: null, info, next_retry_ts: null });
const push = (s: Sample) => {
  act(() => {
    liveStore.pushSample(s);
    liveStore.flush();
  });
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  liveStore.removeNode(NODE);
  usePrefs.setState({ timeRange: 'live' });
  useConnection.setState({ status: 'live', everLive: true });
  useCluster.setState({ clockOffset: 0, nodes: { [NODE]: state('online') } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Network tab', () => {
  it('shows the interconnect first, lists cable-less ports compactly and hides virtual interfaces', async () => {
    push(sample());
    render(<Network nodeId={NODE} />);
    const rail = screen.getByRole('region', { name: 'ConnectX-7 rail A to spark2' });
    expect(within(rail).getByText('Link up')).toBeInTheDocument();
    expect(within(rail).getByText('RDMA active')).toBeInTheDocument();
    expect(within(rail).getByText('200 Gb/s (4X HDR)')).toBeInTheDocument();
    expect(within(rail).getByText('No errors or drops')).toBeInTheDocument();
    // 12.5 GB/s receive = 100 Gb/s = half of the 200 Gb/s line rate.
    expect(within(rail).getByText('Line rate used').parentElement).toHaveTextContent('50%');

    const spare = screen.getByRole('group', { name: 'Ports without a link' });
    expect(spare).toHaveTextContent('Not connected');
    expect(spare).toHaveTextContent('spare0');
    expect(screen.queryByRole('region', { name: /no cable/ })).not.toBeInTheDocument();

    expect(screen.getByRole('region', { name: 'LAN' })).toBeInTheDocument();
    expect(screen.queryByText('Docker bridge')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Show virtual interfaces/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Docker bridge')).toBeInTheDocument();
    expect(screen.getByText('Wi-Fi')).toBeInTheDocument();
  });

  it('keeps a peered rail as a card with Link down when it loses its link', () => {
    push(sample({ net: sample().net.map((n) => (n.name === 'railA' ? { ...n, up: false, rdma_state: 'DOWN' } : n)) }));
    render(<Network nodeId={NODE} />);
    const rail = screen.getByRole('region', { name: 'ConnectX-7 rail A to spark2' });
    expect(within(rail).getByText('Link down')).toBeInTheDocument();
    expect(within(rail).getByText('RDMA down')).toBeInTheDocument();
  });
});

describe('Storage tab', () => {
  it('flags filling filesystems with icon and label, not colour alone, at the alert rules\' thresholds', async () => {
    const rule = { enabled: true, kind: 'threshold', op: '>', for_s: 60, nodes: null };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { ...rule, id: 'disk_full', name: 'Disk almost full', metric: 'fs.root.used_pct', threshold: 85, severity: 'warning' },
        { ...rule, id: 'data_full', name: 'Data disk full', metric: 'fs.data.used_pct', threshold: 95, severity: 'critical' },
      ]), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    push(sample());
    render(<Storage nodeId={NODE} />);
    expect(await screen.findByText('Getting full')).toBeInTheDocument(); // / at 90%, above its 85% warning rule
    expect(screen.getByText('Alerts at 85% used on / (Disk almost full)')).toBeInTheDocument();
    const meters = screen.getAllByRole('meter');
    expect(meters[0]).toHaveAttribute('aria-valuenow', '90');
    expect(meters[0]).toHaveAccessibleName('/ used');
    expect(screen.getByText('Getting full')).toBeInTheDocument(); // / at 90%
    expect(screen.getByText('Almost full')).toBeInTheDocument(); // /data at 96%
    expect(screen.getByText('Samsung MZALC4T0HBL1-00B07')).toBeInTheDocument();
    const disk = screen.getByRole('region', { name: 'Samsung MZALC4T0HBL1-00B07' });
    expect(within(disk).getByText('Read').parentElement).toHaveTextContent('2.05GB/s');
    // The tab opens with the same stat row as every other tab.
    expect(within(screen.getByRole('region', { name: 'Storage now' })).getByText('Root disk used').parentElement).toHaveTextContent('90%');
    expect(screen.getByText('Drive reports critical at 85 °C')).toBeInTheDocument();
  });

  it('shows filesystem capacity and says why disks are not reported when the agent declares only disk', () => {
    const reason = 'Disk I/O is not collected yet for mmcblk0 (Sparkline reads NVMe, SATA/SAS and virtio disks)';
    useCluster.setState({ nodes: { [NODE]: { ...state('online'), info: { ...info, disks: [], unsupported: [{ metric: 'disk', reason, kind: 'agent' }] } } } });
    push(sample({ disk: [] }));
    render(<Storage nodeId={NODE} />);
    expect(within(screen.getByRole('region', { name: 'Capacity' })).getAllByRole('meter')[0]).toHaveAttribute('aria-valuenow', '90');
    const disks = screen.getByRole('region', { name: 'Disks' });
    expect(disks).toHaveTextContent('Not collected yet');
    expect(disks).toHaveTextContent(reason);
    expect(screen.queryByText('No disks reported')).not.toBeInTheDocument();
    const now = screen.getByRole('region', { name: 'Storage now' });
    expect(within(now).getByText('Root disk used').parentElement).toHaveTextContent('90%');
    expect(within(now).getByText('Read').parentElement).toHaveTextContent('Not collected yet');
  });

  it('keeps the last disk values, dimmed, and explains a failing storage collector', () => {
    push(sample());
    push(sample({ ts: TS + 1, seq: 2, disk: [], errors: { storage: 'Failed to read /proc/diskstats: [Errno 5] Input/output error' } }));
    render(<Storage nodeId={NODE} />);
    expect(screen.getByText('Disk activity is not updating')).toBeInTheDocument();
    expect(screen.getByText(/Input\/output error/)).toBeInTheDocument();
    const disk = screen.getByRole('region', { name: 'Samsung MZALC4T0HBL1-00B07' });
    const busy = within(disk).getByText('Busy').parentElement;
    expect(busy).toHaveTextContent('56%');
    expect(busy).toHaveClass('stat--stale'); // dimmed, keeps its caption
    expect(within(disk).getByText('Read').parentElement).toHaveTextContent(/Updated/); // no caption: says its age
  });
});

describe('CPU tab', () => {
  it('derives core groups from NodeInfo, performance above efficiency', () => {
    push(sample());
    render(<Cpu nodeId={NODE} />);
    const perf = screen.getByRole('region', { name: 'Performance cores' });
    const eff = screen.getByRole('region', { name: 'Efficiency cores' });
    expect(perf.compareDocumentPosition(eff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(perf).getAllByRole('img').map((c) => c.getAttribute('aria-label')?.replace(/\u00a0/g, ' '))).toEqual([
      'Core 1 · Cortex-X925: 80% busy, 3.88 GHz of 3.90 GHz max',
      'Core 3 · Cortex-X925: 60% busy, 3.85 GHz of 3.90 GHz max',
    ]);
    expect(within(eff).getAllByRole('img')).toHaveLength(2);
    expect(screen.getByText('Load average · 1 min').parentElement).toHaveTextContent('4.20on 4 cores');
  });

  it('shows last known values (not skeletons) for an offline node opened fresh', () => {
    useCluster.setState({ nodes: { [NODE]: state('offline') } });
    // Only seeded history, no live sample: what the browser has right after loading for an offline node.
    act(() => {
      liveStore.seed({ node_id: NODE, resolution_s: 1, ts: [TS - 1, TS], series: { 'cpu.util': [30, 33], 'cpu.perf_util': [50, 55] }, min: {}, max: {} });
    });
    render(<Cpu nodeId={NODE} />);
    const util = screen.getByText('CPU utilisation').parentElement;
    expect(util).toHaveTextContent('33%');
    expect(util).toHaveClass('stat--stale'); // dimmed; the page banner says "last known values" once
    expect(util).toHaveTextContent('Average of 4 cores');
  });
});

describe('GPU tab', () => {
  const gpuInfo = (...unsupported: NodeInfo['unsupported']) =>
    ({ ...info, gpus: [{ index: 0, name: 'NVIDIA GB10', sm_mhz_max: 3003, power_limit_w: null }], unsupported }) as unknown as NodeInfo;
  const gpuSample = (throttle_mask: number | null, util: number | null = 12) =>
    sample({ gpu: [{ index: 0, util, sm_mhz: 2100, gr_mhz: null, video_mhz: null, temp_c: 50, power_w: 10, energy_j: null, pstate: 0, throttle_mask, power_capped_pct: null, thermal_capped_pct: null }] });
  const clockLimits = () => screen.getByRole('region', { name: 'Clock limits' });

  it('shows the Clock limits skeleton only until the first sample', () => {
    useCluster.setState({ nodes: { [NODE]: { ...state('online'), info: gpuInfo() } } });
    render(<Gpu nodeId={NODE} />);
    expect(clockLimits().querySelector('.skeleton')).toBeInTheDocument();
    push(gpuSample(null));
    expect(clockLimits().querySelector('.skeleton')).not.toBeInTheDocument();
    expect(within(clockLimits()).getAllByText('No data')).toHaveLength(3); // the reasons, and both capped shares
  });

  it('says why the clock limits are not reported when the agent declares it', () => {
    const gap = { metric: 'gpu0.throttle_mask', reason: 'Clock event reasons not reported by NVIDIA GB10 (NVML: Not Supported)', kind: 'hardware' as const };
    useCluster.setState({ nodes: { [NODE]: { ...state('online'), info: gpuInfo(gap) } } });
    push(gpuSample(null));
    render(<Gpu nodeId={NODE} />);
    expect(within(clockLimits()).getByText('Not reported by this hardware')).toBeInTheDocument();
    expect(clockLimits().querySelector('.skeleton')).not.toBeInTheDocument();
  });

  it('says "No data" for a stat whose value never arrives, rather than a skeleton or a bare dash', () => {
    useCluster.setState({ nodes: { [NODE]: { ...state('online'), info: gpuInfo() } } });
    push(gpuSample(0, null));
    render(<Gpu nodeId={NODE} />);
    const util = screen.getByText('Utilisation', { selector: '.stat__label' }).closest('.stat');
    expect(util).toHaveTextContent('No data');
    expect(util?.querySelector('.skeleton')).toBeNull();
  });
});

describe('Summary tab', () => {
  it('shows memory and network as not reported, not as 0 or "no link", when their collectors could not start', () => {
    const unsupported = [
      { metric: 'mem', reason: 'The memory collector could not start: /proc/meminfo: No such file or directory', kind: 'hardware' as const },
      { metric: 'net', reason: 'The net collector could not start: /sys/class/net: No such file or directory', kind: 'hardware' as const },
    ];
    useCluster.setState({ nodes: { [NODE]: { ...state('online'), info: { ...info, gpus: [], net: [], mem_total: 0, unsupported } } } });
    const zeros = { total: 0, available: 0, used: 0, free: 0, gpu: null, anon: 0, cache: 0, shmem: 0, kernel: 0, other: 0, swap_total: 0, swap_used: 0, psi_some: null, psi_full: null };
    push(sample({ mem: zeros, errors: { mem: 'no data', thermal: 'OSError: hwmon vanished' } }));
    render(<Summary nodeId={NODE} />);
    const memory = screen.getByText('Memory available', { selector: '.stat__label' }).closest('.stat');
    expect(memory).toHaveTextContent('Not reported by this hardware');
    expect(memory).not.toHaveTextContent('0 B');
    expect(screen.getByText('ConnectX-7 in', { selector: '.stat__label' }).closest('.stat')).toHaveTextContent('Not reported by this hardware');
    expect(screen.queryByText(/No ConnectX-7 link is cabled/)).not.toBeInTheDocument();
    expect(screen.getByText('CPU utilisation', { selector: '.stat__label' }).closest('.stat')).toHaveTextContent('40%');
    const notes = screen.getByRole('list', { name: 'Metrics unavailable' });
    expect(notes).toHaveTextContent('Temperature sensors unavailable: OSError: hwmon vanished');
    expect(notes).not.toHaveTextContent('no data');
  });

  it('says why GPU utilisation and temperature are missing, not "No data", when the agent lacks NVML', () => {
    const reason = 'Install nvidia-ml-py to read NVIDIA GPU metrics';
    const unsupported = [{ metric: 'gpu*', reason, kind: 'dependency' as const }, { metric: 'mem.gpu', reason, kind: 'dependency' as const }];
    useCluster.setState({ nodes: { [NODE]: { ...state('online'), info: { ...info, gpus: [], unsupported } } } });
    push(sample());
    render(<Summary nodeId={NODE} />);
    for (const label of ['GPU utilisation', 'GPU temperature', 'GPU power']) {
      const stat = screen.getByText(label, { selector: '.stat__label' }).closest('.stat');
      expect(stat).toHaveTextContent('Helper tool missing');
      expect(stat).not.toHaveTextContent('No data');
      expect(within(stat as HTMLElement).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(reason);
    }
    expect(screen.getByText('GPU utilisation', { selector: '.stat__label' }).closest('.stat')).not.toHaveTextContent('Time the GPU was busy');
  });
});
