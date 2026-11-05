import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClusterState, NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { useEvents } from '../../store/events';
import { historyCache } from '../../store/history';
import { liveStore } from '../../store/live';
import sampleJson from '../../test/fixtures/sample.json';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../test/fixtures/platforms/gb10/sample.json';
import wsInfo from '../../test/fixtures/platforms/workstation/info.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
import Overview from '../Overview';

// uPlot needs a real canvas; the charts have their own tests.
vi.mock('../../charts/TimeSeriesChart', async (importActual) => ({
  ...(await importActual<typeof import('../../charts/TimeSeriesChart')>()),
  TimeSeriesChart: () => null,
}));

const now = Date.now() / 1000;
const node = (id: string, p: Partial<NodeState> = {}): NodeState => ({
  node_id: id, url: `http://${id}:9750`, status: 'online', since: now, last_sample_ts: now, error: null, info: null, next_retry_ts: null, ...p,
});
const cluster = (nodes: NodeState[]): ClusterState => ({
  nodes,
  settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
  demo: true,
  version: 'test',
  server_time: now,
});

beforeAll(() => {
  // jsdom: no layout observers.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  HTMLCanvasElement.prototype.getContext = () => null;
});

beforeEach(() => {
  useConnection.setState({ status: 'live', everLive: true });
  useEvents.setState({ events: [] });
  // History/events requests: empty answers.
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Overview', () => {
  it('shows a layout skeleton before the console says hello', () => {
    useCluster.setState({ cluster: null, order: [], nodes: {} });
    const { container } = render(<Overview />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('.ov-card')).toHaveLength(2);
  });

  it('explains how to add nodes when none are configured', () => {
    useCluster.getState().setHello(cluster([]));
    render(<Overview />);
    expect(screen.getByText('No nodes configured')).toBeInTheDocument();
    expect(screen.getAllByText('console.toml').length).toBeGreaterThan(0);
  });

  it('answers the health question and offers a retry for an offline node', async () => {
    useCluster.getState().setHello(
      cluster([
        node('spark1'),
        node('spark2', {
          status: 'offline',
          error: { message: 'Agent unreachable on spark2', cause: 'Connection refused', fix: 'Check `systemctl status sparkline-agent` on spark2' },
        }),
      ]),
    );
    const sample = { ...(sampleJson as unknown as Sample), node_id: 'spark1', ts: now };
    act(() => {
      liveStore.pushSample(sample);
      liveStore.flush();
    });
    render(<Overview />);
    expect(screen.getByRole('heading', { name: 'spark2 is offline' })).toBeInTheDocument();
    expect(screen.getByText('Agent unreachable on spark2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fetch).toHaveBeenCalledWith('/api/v1/nodes/spark2/retry', expect.objectContaining({ method: 'POST' }));
    // Each card links to its node page.
    expect(screen.getByRole('link', { name: /spark1, open node details/ })).toHaveAttribute('href', '/node/spark1');
  });

  it('shows the quiet empty state when there are no events', () => {
    useCluster.getState().setHello(cluster([node('spark1')]));
    render(<Overview />);
    expect(screen.getByText('No alerts. Everything’s quiet.')).toBeInTheDocument();
  });

  describe('unified memory tile', () => {
    const reason = 'The memory collector could not start: /proc/meminfo: No such file or directory';
    const info = (id: string, memTotal: number, unsupported: NodeInfo['unsupported'] = []) =>
      ({ node_id: id, hostname: id, gpus: [], net: [], cores: [], disks: [], sensors: [], mem_total: memTotal, unsupported }) as unknown as NodeInfo;
    const placeholder = { total: 0, available: 0, used: 0, free: 0, anon: 0, cache: 0, shmem: 0, kernel: 0, other: 0, swap_total: 0, swap_used: 0 } as Sample['mem'];
    const push = (id: string, mem?: Sample['mem']) => {
      liveStore.removeNode(id);
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: id, ts: now, ...(mem ? { mem } : {}) });
    };
    const tile = () => within(screen.getByRole('region', { name: 'Cluster totals' })).getByText('Unified memory in use').closest('.stat');

    it('says memory is not reported, not that every node is reporting, when the only node has no memory reading', () => {
      useCluster.getState().setHello(cluster([node('mem1', { info: info('mem1', 0, [{ metric: 'mem', reason, kind: 'hardware' }]) })]));
      act(() => {
        push('mem1', placeholder);
        liveStore.flush();
      });
      render(<Overview />);
      expect(tile()).toHaveTextContent('Not reported by this hardware');
      expect(tile()).not.toHaveTextContent('reporting');
    });

    it('names the node it leaves out of the total', () => {
      const memTotal = (sampleJson as unknown as Sample).mem.total;
      useCluster.getState().setHello(
        cluster([node('mem1', { info: info('mem1', memTotal) }), node('mem2', { info: info('mem2', 0, [{ metric: 'mem', reason, kind: 'hardware' }]) })]),
      );
      act(() => {
        push('mem1');
        push('mem2', placeholder);
        liveStore.flush();
      });
      render(<Overview />);
      expect(tile()).toHaveTextContent('of 121.7 GiB');
      expect(tile()).toHaveTextContent('excl. mem2');
    });
  });

  describe('GPU totals without NVML', () => {
    const reason = 'Install nvidia-ml-py to read NVIDIA GPU metrics';
    const gaps = [{ metric: 'gpu*', reason, kind: 'dependency' }, { metric: 'mem.gpu', reason, kind: 'dependency' }];
    const info = (id: string, unsupported: unknown[] = []) =>
      ({ node_id: id, hostname: id, gpus: [], net: [], cores: [], disks: [], sensors: [], mem_total: (sampleJson as unknown as Sample).mem.total, unsupported }) as unknown as NodeInfo;
    const full = sampleJson as unknown as Sample;
    const push = (id: string, nvml: boolean) => {
      liveStore.removeNode(id);
      const procs = [
        { pid: 41, name: 'python3', user: 'u', cmdline: 'python3 serve.py', state: 'S', cpu_pct: 3, rss: 2e9, gpu_mem: nvml ? 8e9 : null, gpu_util: null, container: 'vllm', model: null },
        { pid: 42, name: 'bash', user: 'u', cmdline: 'bash', state: 'S', cpu_pct: 0, rss: 4e6, gpu_mem: null, gpu_util: null, container: null, model: null },
      ];
      liveStore.pushSample({ ...full, node_id: id, ts: now, gpu: nvml ? full.gpu : [], procs });
    };
    const tile = (label: string) => within(screen.getByRole('region', { name: 'Cluster totals' })).getByText(label, { selector: '.stat__label' }).closest('.stat');

    it('says the GPU totals are not reported, not that every node is reporting, when the only node lacks NVML', () => {
      useCluster.getState().setHello(cluster([node('amd1', { info: info('amd1', gaps) })]));
      act(() => {
        push('amd1', false);
        liveStore.flush();
      });
      render(<Overview />);
      for (const label of ['Cluster compute', 'GPU power', 'Active GPU processes']) {
        expect(tile(label)).toHaveTextContent('Helper tool missing');
        expect(tile(label)).not.toHaveTextContent('reporting');
        expect(within(tile(label) as HTMLElement).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(reason);
      }
    });

    it('names the node without NVML that the GPU totals leave out', async () => {
      vi.mocked(globalThis.fetch).mockImplementation((url) => {
        const spark1 = typeof url === 'string' && new URL(url, 'http://x').searchParams.get('node') === 'spark1';
        const series = spark1 ? { 'gpu0.energy_j': [123_000_000, 123_100_000] } : {};
        return Promise.resolve(Response.json({ node_id: 'n', resolution_s: 60, ts: spark1 ? [now - 120, now - 60] : [], series, min: {}, max: {} }));
      });
      useCluster.getState().setHello(cluster([node('spark1', { info: info('spark1') }), node('amd1', { info: info('amd1', gaps) })]));
      act(() => {
        push('spark1', true);
        push('amd1', false);
        liveStore.flush();
      });
      render(<Overview />);
      expect(tile('Cluster compute')).toHaveTextContent('91%');
      expect(tile('Cluster compute')).toHaveTextContent('Mean GPU utilisation · excl. amd1');
      expect(tile('Active GPU processes')).toHaveTextContent(/^Active GPU processes1In 1 container · excl\. amd1$/);
      expect(tile('GPU power')).toHaveTextContent('32.4');
      expect(await within(tile('GPU power') as HTMLElement).findByText(/excl\. amd1/)).toBeInTheDocument();
    });

    const gpuGap = (reason: string, kind: string) => [{ metric: 'gpu*', reason, kind }, { metric: 'mem.gpu', reason, kind }];
    const showAll = (nodes: [string, unknown[]][]) => {
      useCluster.getState().setHello(cluster(nodes.map(([id, u]) => node(id, { info: info(id, u) }))));
      act(() => {
        for (const [id] of nodes) push(id, false);
        liveStore.flush();
      });
      render(<Overview />);
    };
    const why = (label: string) => within(tile(label) as HTMLElement).getByRole('button', { name: 'Why is this not reported?' });
    const lines: Record<string, string> = { nogpu: 'nogpu: NVML found no NVIDIA GPU', gpuaccess: 'gpuaccess: Needs permission to open /dev/nvidiactl' };
    const reasons: Record<string, unknown[]> = {
      nogpu: gpuGap('NVML found no NVIDIA GPU', 'hardware'),
      gpuaccess: gpuGap('Needs permission to open /dev/nvidiactl', 'access'),
    };

    it.each([
      ['nogpu', 'gpuaccess'],
      ['gpuaccess', 'nogpu'],
    ])('says what is true of both nodes when %s and %s lack the GPU totals for different reasons', (a, b) => {
      showAll([a, b].map((id) => [id, reasons[id] ?? []]));
      for (const label of ['Cluster compute', 'GPU power', 'Active GPU processes']) {
        expect(tile(label)).toHaveTextContent('Not reported on any node');
        expect(tile(label)).not.toHaveTextContent(/by this hardware|No access/);
        expect(why(label)).toHaveAccessibleDescription(`${lines[a] ?? ''}\n${lines[b] ?? ''}`);
      }
    });

    it('keeps the one shared gap when every node lacks the GPU totals for the same reason', () => {
      showAll([
        ['amd1', gaps],
        ['amd2', gaps],
      ]);
      for (const label of ['Cluster compute', 'GPU power', 'Active GPU processes']) {
        expect(tile(label)).toHaveTextContent('Helper tool missing');
        expect(why(label)).toHaveAccessibleDescription(reason);
      }
    });

    it('keeps the shared kind and names each node when the nodes share a kind but not a reason', () => {
      showAll([
        ['mac1', gpuGap('No NVIDIA GPU on Apple silicon', 'hardware')],
        ['nogpu', reasons.nogpu ?? []],
      ]);
      expect(tile('Cluster compute')).toHaveTextContent('Not reported by this hardware');
      expect(why('Cluster compute')).toHaveAccessibleDescription(`mac1: No NVIDIA GPU on Apple silicon\n${lines.nogpu ?? ''}`);
    });
  });

  it('reads a lost GPU as not responding in its ring, like the stats beside it', () => {
    const lost = 'NVML could not open GPU 0 (NVML: GPU is lost)';
    const gaps = ['gpu0', 'gpu0.util', 'gpu0.temp_c', 'gpu0.power_w'].map((metric) => ({ metric, reason: lost, kind: 'hardware' }));
    const info = { node_id: 'lost1', hostname: 'lost1', gpus: [{ index: 0, name: 'GPU 0', vendor: 'nvidia', backend: 'nvml' }], net: [], cores: [], disks: [], sensors: [], mem_total: 0, unsupported: gaps } as unknown as NodeInfo;
    useCluster.getState().setHello(cluster([node('lost1', { info })]));
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: 'lost1', ts: now, gpu: [{ index: 0 }] as Sample['gpu'] });
      liveStore.flush();
    });
    render(<Overview />);
    const card = screen.getByRole('region', { name: 'Node lost1' });
    const ring = within(card).getByRole('img', { name: /^GPU utilisation/ });
    expect(ring).toHaveAccessibleName('GPU utilisation not responding');
    expect(ring).toHaveTextContent('Not responding');
    expect(within(card).getByText('GPU temp').parentElement).toHaveTextContent('Not responding');
  });

  it('says a Wi-Fi-only node has no direct link, not that ConnectX-7 is not collected yet', () => {
    const reason = 'Only Wi-Fi or virtual interfaces (wlp2s0), which Sparkline skips unless include_virtual = true';
    const wifi = { name: 'wlp2s0', role: 'wireless', label: 'Wi-Fi', mac: null, ipv4: [], speed_mbps: null, rdma_device: null, counter_source: 'netdev', peer: null };
    const info = { node_id: 'wifi1', hostname: 'wifi1', gpus: [], net: [wifi], cores: [], disks: [], sensors: [], mem_total: 0, unsupported: [{ metric: 'net', reason, kind: 'agent' }] } as unknown as NodeInfo;
    useCluster.getState().setHello(cluster([node('wifi1', { info })]));
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: 'wifi1', ts: now, net: [] });
      liveStore.flush();
    });
    const { container } = render(<Overview />);
    const row = container.querySelector('.ov-cx');
    expect(row).toHaveTextContent('No direct link');
    expect(row).not.toHaveTextContent('Not collected yet');
  });
});

describe('a four-GPU workstation on the Overview (ws1, slowdown 93 °C)', () => {
  const ws1 = wsInfo as unknown as NodeInfo;
  const reading = wsSample as unknown as Sample;
  const withGpus = (over: Record<number, Partial<Sample['gpu'][number]>>): Sample => ({ ...reading, gpu: reading.gpu.map((g) => ({ ...g, ...over[g.index] })) });
  const show = (sample: Sample, info: NodeInfo = ws1) => {
    useCluster.getState().setHello(cluster([node('ws1', { info })]));
    act(() => {
      liveStore.removeNode('ws1');
      liveStore.pushSample({ ...sample, ts: now });
      liveStore.flush();
    });
    render(<Overview />);
    return screen.getByRole('region', { name: 'Node ws1' });
  };
  const pill = (scope: HTMLElement) => scope.querySelector('[data-status]')?.getAttribute('data-status');
  const stat = (scope: HTMLElement, label: string) => within(scope).getByText(label, { selector: '.ov-stat__label' }).parentElement as HTMLElement;
  const tile = (label: string) => within(screen.getByRole('region', { name: 'Cluster totals' })).getByText(label, { selector: '.stat__label' }).closest('.stat') as HTMLElement;
  const why = (scope: HTMLElement) => within(scope).getByRole('button', { name: 'Why is this not reported?' });
  const LOST = 'NVML could not open GPU 0 (NVML: GPU is lost)';
  const withSpark1 = (sample: Sample, info: NodeInfo = ws1) => {
    useCluster.getState().setHello(cluster([node('spark1', { info: gb10Info as unknown as NodeInfo }), node('ws1', { info })]));
    act(() => {
      for (const s of [{ ...(gb10Sample as unknown as Sample), ts: now }, { ...sample, ts: now }]) {
        liveStore.removeNode(s.node_id);
        liveStore.pushSample(s);
      }
      liveStore.flush();
    });
    render(<Overview />);
  };

  it('shows the node totals on the card, the hero and the cluster totals: mean utilisation, the hottest GPU, the four powers summed', () => {
    const card = show(reading);
    expect(within(card).getByRole('img', { name: /^GPU utilisation/ })).toHaveAccessibleName('GPU utilisation 86%');
    expect(stat(card, 'GPU temp')).toHaveTextContent(/^GPU temp77°C16\s°C headroom to the 93 °C slowdown threshold$/);
    expect(stat(card, 'GPU power')).toHaveTextContent(/^GPU power1069W/);
    expect(document.querySelector('.ov-hero__numbers')).toHaveTextContent(/GPU 86% at 1069 W$/);
    expect(tile('Cluster compute')).toHaveTextContent(/^Cluster compute86%Mean GPU utilisation · /);
    expect(tile('GPU power')).toHaveTextContent(/^GPU power1069W/);
  });

  it("says why there is no power total while GPU 2 sends no power reading, and leaves ws1 out of the cluster's", async () => {
    const counters = Object.fromEntries([0, 1, 2, 3].map((i) => [`gpu${i}.energy_j`, [40_000_000, 40_100_000]]));
    vi.mocked(globalThis.fetch).mockImplementation(() => Promise.resolve(Response.json({ node_id: 'n', resolution_s: 60, ts: [now - 120, now - 60], series: counters, min: {}, max: {} })));
    historyCache.clear();
    withSpark1(withGpus({ 2: { power_w: null } }));
    const card = screen.getByRole('region', { name: 'Node ws1' });
    expect(stat(card, 'GPU power')).toHaveTextContent('No total');
    expect(why(stat(card, 'GPU power'))).toHaveAccessibleDescription('GPU 2 sent no power reading this tick, so a sum would understate.');
    expect(stat(card, 'GPU temp')).toHaveTextContent(/^GPU temp77°C/);
    expect(document.querySelector('.ov-hero__numbers')).toHaveTextContent(/GPU 74% at 24\.5 W · excl\. ws1$/);
    expect(tile('GPU power')).toHaveTextContent(/^GPU power24\.5W/);
    expect(await within(tile('GPU power')).findByText(/^Now excl\. ws1 · Today \d/)).not.toHaveTextContent(/Today.*excl\./);
    expect(tile('Cluster compute')).not.toHaveTextContent('excl.');
  });

  it("reads utilisation and temperature from GPUs 1 to 3 while GPU 0 is lost, keeps counting ws1's processes and gives the lost GPU as the power gap", () => {
    const lost = { ...ws1, unsupported: [{ metric: 'gpu0', reason: LOST, kind: 'hardware' }, { metric: 'gpu.power_w', reason: `GPU 0: ${LOST}`, kind: 'hardware' }] } as NodeInfo;
    const card = show(withGpus({ 0: { util: null, temp_c: null, power_w: null, energy_j: null, sm_mhz: null, throttle_mask: null } }), lost);
    expect(within(card).getByRole('img', { name: /^GPU utilisation/ })).toHaveAccessibleName('GPU utilisation 87%, from 3 of 4 GPUs');
    expect(stat(card, 'GPU temp')).toHaveTextContent(/^GPU temp77°C/);
    expect(stat(card, 'GPU power')).toHaveTextContent('No total');
    expect(why(stat(card, 'GPU power'))).toHaveAccessibleDescription(`GPU 0: ${LOST}`);
    expect(tile('Active GPU processes')).toHaveTextContent(/^Active GPU processes4In 1 container$/);
  });

  it("names ws1 beside the hero's GPU power while GPU 0 is lost and ws1 has no power total", () => {
    const lost = { ...ws1, unsupported: [{ metric: 'gpu0', reason: LOST, kind: 'hardware' }, { metric: 'gpu.power_w', reason: `GPU 0: ${LOST}`, kind: 'hardware' }] } as NodeInfo;
    withSpark1(withGpus({ 0: { util: null, temp_c: null, power_w: null, energy_j: null, sm_mhz: null, throttle_mask: null } }), lost);
    expect(document.querySelector('.ov-hero__numbers')).toHaveTextContent(/ at 24\.5 W · excl\. ws1$/);
  });

  it('marks what it reads from 3 of 4 GPUs while GPU 0 is lost, and raises the pill and the cluster sentence', () => {
    const lost = { ...ws1, unsupported: [{ metric: 'gpu0', reason: LOST, kind: 'hardware' }, { metric: 'gpu.power_w', reason: `GPU 0: ${LOST}`, kind: 'hardware' }] } as NodeInfo;
    withSpark1(withGpus({ 0: { util: null, temp_c: null, power_w: null, energy_j: null, sm_mhz: null, throttle_mask: null } }), lost);
    const card = screen.getByRole('region', { name: 'Node ws1' });
    expect(pill(card)).toBe('warning');
    expect(screen.getByRole('heading', { name: 'ws1 has GPU 0 not responding' })).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: /^GPU utilisation/ })).toHaveAccessibleName('GPU utilisation 87%, from 3 of 4 GPUs');
    expect(within(card).getByRole('img', { name: /^ws1 GPU utilisation/ })).toHaveAccessibleName(/^ws1 GPU utilisation \(3 of 4 GPUs\)/);
    expect(stat(card, 'GPU temp')).toHaveTextContent(/headroom to the 93 °C slowdown threshold3 of 4 GPUs$/);
    expect(document.querySelector('.ov-hero__numbers')).toHaveTextContent(/GPU \d+% \(4 of 5 GPUs\) at 24\.5 W · excl\. ws1$/);
    expect(tile('Cluster compute')).toHaveTextContent('Mean GPU utilisation (4 of 5 GPUs) · ');
  });

  it('still counts the GPUs under the temperature of a node whose GPUs declare no slowdown', () => {
    const lost = { ...ws1, gpus: ws1.gpus.map((g) => ({ ...g, temp_slowdown_c: null })), unsupported: [{ metric: 'gpu0', reason: LOST, kind: 'hardware' }] } as NodeInfo;
    const card = show(withGpus({ 0: { util: null, temp_c: null, power_w: null, throttle_mask: null } }), lost);
    expect(stat(card, 'GPU temp')).toHaveTextContent(/^GPU temp77°C3 of 4 GPUs$/);
  });

  const ws2Lost = {
    ...ws1,
    node_id: 'ws2',
    unsupported: [
      ...[0, 1, 2, 3].map((i) => ({ metric: `gpu${String(i)}`, reason: LOST, kind: 'hardware' })),
      ...['util', 'temp_c', 'power_w'].map((f) => ({ metric: `gpu.${f}`, reason: `GPU 0: ${LOST}`, kind: 'hardware' })),
    ],
  } as NodeInfo;
  const silent = { ...reading, gpu: reading.gpu.map((g) => ({ index: g.index })) } as Sample;
  const failed: Sample = { ...reading, gpu: [], errors: { ...reading.errors, gpu: 'nvml: Unknown Error' } };
  it.each([
    ['sends no reading from any of its GPUs', silent, { ...ws1, node_id: 'ws2' }],
    ['has every GPU lost', silent, ws2Lost],
    ['has its GPU backend fail the tick', failed, { ...ws1, node_id: 'ws2' }],
  ])('counts the GPUs under the hero and the cluster compute total while ws2 %s', (_, b, info) => {
    useCluster.getState().setHello(cluster([node('ws1', { info: ws1 }), node('ws2', { info })]));
    act(() => {
      for (const s of [{ ...reading, ts: now }, { ...b, node_id: 'ws2', ts: now }]) {
        liveStore.removeNode(s.node_id);
        liveStore.pushSample(s);
      }
      liveStore.flush();
    });
    render(<Overview />);
    expect(document.querySelector('.ov-hero__numbers')).toHaveTextContent(/GPU 86% \(4 of 8 GPUs\) at 1069 W · excl\. ws2$/);
    expect(tile('Cluster compute')).toHaveTextContent(/^Cluster compute86%Mean GPU utilisation \(4 of 8 GPUs\) · excl\. ws2 · All 2 nodes reporting$/);
  });

  it('marks nothing on a calm ws1 beside a GB10', () => {
    withSpark1(reading);
    expect(document.querySelector('.ov-hero__numbers')).not.toHaveTextContent('GPUs');
    expect(tile('Cluster compute')).not.toHaveTextContent('GPUs');
    expect(within(screen.getByRole('region', { name: 'Node ws1' })).getByRole('img', { name: /^GPU utilisation/ })).toHaveAccessibleName('GPU utilisation 86%');
  });

  it.each([
    ['only GPU 3 is at its slowdown temperature', { 3: { temp_c: 94 } }, 'ws1 has GPU 3 at its slowdown temperature'],
    ['only GPU 3 has its clocks cut by overheating', { 3: { throttle_mask: 0x40 } }, 'ws1 has GPU 3 clocks limited by overheating'],
  ])('raises the card pill to critical and names ws1 in the cluster sentence when %s', (_, over, sentence) => {
    const card = show(withGpus(over));
    expect(pill(card)).toBe('critical');
    expect(screen.getByRole('heading', { name: sentence })).toBeInTheDocument();
  });

  it('flags the hottest GPU on the card and names it under the flag', () => {
    const card = show(withGpus({ 3: { temp_c: 94 } }));
    expect(stat(card, 'GPU temp')).toHaveTextContent(/^GPU temp94°CAt slowdown to the 93 °C slowdown thresholdGPU 3$/);
  });

  it('keeps the card pill healthy while every GPU is calm', () => {
    expect(pill(show(reading))).toBe('healthy');
    expect(screen.getByRole('heading', { name: 'ws1 is healthy' })).toBeInTheDocument();
  });

  it('still names GPU 3 at slowdown while GPU 0 has an open warning alert', () => {
    useEvents.setState({
      events: [{ id: 1, ts: now, node_id: 'ws1', severity: 'warning', kind: 'alert', rule_id: 'gpu_temp_high', title: 'GPU temperature high on ws1 · GPU 0', detail: '', metric: 'gpu0.temp_c', value: 88, resolved_ts: null, acked: false }],
    });
    show(withGpus({ 0: { temp_c: 88 }, 3: { temp_c: 94 } }));
    expect(screen.getByRole('heading', { name: 'ws1 has GPU 3 at its slowdown temperature · 1 warning' })).toBeInTheDocument();
  });

  const alert = (severity: 'warning' | 'critical', rule_id: string, metric: string) => ({
    id: 1, ts: now, node_id: 'ws1', severity, kind: 'alert' as const, rule_id, title: rule_id, detail: '', metric, value: 95, resolved_ts: null, acked: false,
  });
  const lostGpu0 = { ...ws1, unsupported: [{ metric: 'gpu0', reason: LOST, kind: 'hardware' }] } as NodeInfo;
  const gpu0Silent = { 0: { util: null, temp_c: null, power_w: null, throttle_mask: null } };

  it('still says GPU 0 is not responding while an unrelated warning is open on ws1', () => {
    useEvents.setState({ events: [alert('warning', 'disk_full', 'fs.root.used_pct')] });
    show(withGpus(gpu0Silent), lostGpu0);
    expect(screen.getByRole('heading', { name: 'ws1 has GPU 0 not responding · 1 warning' })).toBeInTheDocument();
  });

  it("still says GPU 0 is not responding while GPU 3's critical temperature alert is open", () => {
    useEvents.setState({ events: [alert('critical', 'gpu_temp_critical', 'gpu3.temp_c')] });
    show(withGpus({ ...gpu0Silent, 3: { temp_c: 94 } }), lostGpu0);
    expect(screen.getByRole('heading', { name: 'ws1 has GPU 0 not responding · 1 critical alert' })).toBeInTheDocument();
  });

  describe('memory, once the GPUs say they keep their own', () => {
    const olderAgent = { ...ws1, gpus: ws1.gpus.map((g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'memory' && k !== 'vram_total'))) } as unknown as NodeInfo;
    const memRow = (card: HTMLElement, label: string) => within(card).getByText(label, { selector: '.ov-label' }).closest('.ov-mem') as HTMLElement;

    it('shows system memory with no GPU segment, and a GPU memory row of the summed VRAM', () => {
      const card = show(reading);
      expect(within(memRow(card, 'System memory')).getByRole('img')).toHaveAccessibleName(/^System memory: .* in use \(\d+%\), .* available$/);
      expect(memRow(card, 'System memory')).not.toHaveTextContent('GPU');
      expect(within(memRow(card, 'GPU memory')).getByRole('img')).toHaveAccessibleName(/^GPU memory: 163\.8\sGiB of 192\.0\sGiB in use \(85%\)$/);
      expect(tile('System memory in use')).toBeInTheDocument();
    });

    it('says why there is no GPU memory total while GPU 2 sends no VRAM reading', () => {
      const card = show(withGpus({ 2: { vram_used: null } }));
      expect(memRow(card, 'GPU memory')).toHaveTextContent('No total');
      expect(why(memRow(card, 'GPU memory'))).toHaveAccessibleDescription('GPU 2 sent no memory reading this tick, so a sum would understate.');
    });

    it('keeps a GB10 beside it as unified memory, and calls the cluster total system memory', () => {
      withSpark1(reading);
      const spark1 = screen.getByRole('region', { name: 'Node spark1' });
      expect(within(memRow(spark1, 'Unified memory')).getByRole('img')).toHaveAccessibleName(/^Unified memory: .*, .* GPU-allocated, .* available$/);
      expect(within(spark1).queryByText('GPU memory', { selector: '.ov-label' })).not.toBeInTheDocument();
      expect(tile('System memory in use')).toBeInTheDocument();
    });

    it('calls the cluster total unified memory while every node is unified, as with an older ws1 agent', () => {
      withSpark1(reading, olderAgent);
      expect(tile('Unified memory in use')).toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: 'Node ws1' })).queryByText('GPU memory', { selector: '.ov-label' })).not.toBeInTheDocument();
    });
  });
});

describe('GPU processes a node cannot tell, on the Overview', () => {
  const NO_NVML = 'Install nvidia-ml-py to read NVIDIA GPU metrics';
  const NV_ERROR = 'RuntimeError: synthesized NVML read failure';
  const gb10 = gb10Sample as unknown as Sample;
  const amd1 = {
    node_id: 'amd1', hostname: 'amd1', gpus: [], net: [], cores: [], disks: [], sensors: [], mem_total: gb10.mem.total,
    unsupported: [{ metric: 'gpu*', reason: NO_NVML, kind: 'dependency' }, { metric: 'mem.gpu', reason: NO_NVML, kind: 'dependency' }],
  } as unknown as NodeInfo;
  const idle = gb10.procs?.filter((p) => !p.gpu_mem) ?? [];
  const show = (nodes: [NodeInfo, Partial<Sample>][], ticks = 1) => {
    useCluster.getState().setHello(cluster(nodes.map(([info]) => node(info.node_id, { info }))));
    act(() => {
      for (const [info, over] of nodes) {
        liveStore.removeNode(info.node_id);
        for (let i = 0; i < ticks; i++) liveStore.pushSample({ ...gb10, node_id: info.node_id, ts: now - ticks + 1 + i, ...over });
      }
      liveStore.flush();
    });
    render(<Overview />);
  };
  const subtitle = (id: string) => within(screen.getByRole('region', { name: `Node ${id}` })).getByText(/GPU processes$/).closest('p') as HTMLElement;
  const activity = () => document.querySelector('.ov-hero__activity') as HTMLElement;
  const workload = () => document.querySelector('.ov-hero__workload');

  it("says spark1 runs no GPU workload and amd1 cannot tell its GPU processes, when amd1 has no NVML", () => {
    show([[gb10Info as unknown as NodeInfo, { procs: idle }], [amd1, { gpu: [], procs: idle }]]);
    expect(workload()).toHaveTextContent(/^No GPU workloads on spark1$/);
    expect(subtitle('spark1')).toHaveTextContent(/^No GPU processes$/);
    expect(subtitle('amd1')).toHaveTextContent(/^GPU processes Helper tool missing/);
    expect(within(subtitle('amd1')).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(NO_NVML);
  });

  it.each([
    ['its process list', idle],
    ['its first process list arrives', null],
  ])('says GPU workloads are not reported, not a skeleton, when the only node has no NVML, before and after %s', (_, procs) => {
    show([[amd1, { gpu: [], procs }]]);
    expect(activity()).not.toHaveAttribute('aria-hidden');
    expect(workload()).toHaveTextContent(/^GPU workloads not reported$/);
    expect(subtitle('amd1')).toHaveTextContent(/^GPU processes Helper tool missing/);
  });

  it('says the GPU processes of a GB10 whose GPU has been missing from the samples for 5 s are not responding, not that it runs none', () => {
    show([[gb10Info as unknown as NodeInfo, { gpu: [], procs: idle, errors: { gpu: `nvml: ${NV_ERROR}` } }]], 6);
    expect(within(screen.getByRole('region', { name: 'Node spark1' })).queryByText('No GPU processes')).not.toBeInTheDocument();
    expect(subtitle('spark1')).toHaveTextContent(/^GPU processes Not responding/);
    expect(within(subtitle('spark1')).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(NV_ERROR);
    expect(workload()).toHaveTextContent(/^GPU workloads not reported$/);
  });

  it('says the GPU processes are not known, not a skeleton forever, on a node whose process collector could not start', () => {
    const why = 'The procs collector could not start: /proc: No such file or directory';
    const info = { ...(gb10Info as unknown as NodeInfo), unsupported: [...(gb10Info as unknown as NodeInfo).unsupported, { metric: 'procs', reason: why, kind: 'hardware' as const }] };
    show([[info, { procs: null }]]);
    expect(subtitle('spark1')).toHaveTextContent(/^GPU processes Not reported by this hardware/);
    expect(within(subtitle('spark1')).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(why);
    expect(workload()).toHaveTextContent(/^GPU workloads not reported$/);
  });

  it('keeps a healthy GB10 serving its model as before', () => {
    show([[gb10Info as unknown as NodeInfo, {}]]);
    expect(within(screen.getByRole('region', { name: 'Node spark1' })).getByText('DeepSeek-V4.1-Flash-EXL3 · c5-2B-r0')).toBeInTheDocument();
    expect(workload()).toHaveTextContent(/^Serving DeepSeek-V4\.1-Flash-EXL3 on spark1$/);
    expect(document.querySelector('.ov-hero__numbers')).toHaveTextContent(/^· GPU 62% at 24\.5 W$/);
  });
});

describe('the pill and the cluster sentence while GPUs send nothing', () => {
  const LOST = 'NVML could not open GPU 0 (NVML: GPU is lost)';
  const gb10 = gb10Info as unknown as NodeInfo;
  const gb10Reading = gb10Sample as unknown as Sample;
  const show = (info: NodeInfo, samples: Sample[]) => {
    useCluster.getState().setHello(cluster([node(info.node_id, { info })]));
    act(() => {
      liveStore.removeNode(info.node_id);
      samples.forEach((s, i) => { liveStore.pushSample({ ...s, node_id: info.node_id, ts: now - samples.length + 1 + i }); });
      liveStore.flush();
    });
    render(<Overview />);
  };
  const pill = (scope: Element | null) => scope?.querySelector('[data-status]');
  const heroPill = () => pill(document.querySelector('.ov-hero'));
  const cardPill = (id: string) => pill(screen.getByRole('region', { name: `Node ${id}` }));

  it('raises the pill and names a one-GPU node whose GPU is lost, at once', () => {
    show({ ...gb10, unsupported: [...gb10.unsupported, { metric: 'gpu0', reason: LOST, kind: 'hardware' }] }, [{ ...gb10Reading, gpu: [{ index: 0 }] as Sample['gpu'] }]);
    expect(screen.getByRole('heading', { name: 'spark1 has a GPU not responding' })).toBeInTheDocument();
    expect(heroPill()).toHaveTextContent('Needs attention');
    expect(cardPill('spark1')).toHaveAttribute('data-status', 'warning');
  });

  const ws1 = wsInfo as unknown as NodeInfo;
  const wsReading = wsSample as unknown as Sample;
  const gpu3At = (temp_c: number): Sample => ({ ...wsReading, gpu: wsReading.gpu.map((g) => (g.index === 3 ? { ...g, temp_c } : g)) });
  const openAlert = (node_id: string, severity: 'warning' | 'critical', rule_id: string, metric: string) => ({
    id: 1, ts: now, node_id, severity, kind: 'alert' as const, rule_id, title: rule_id, detail: '', metric, value: null, resolved_ts: null, acked: false,
  });

  it.each([
    ['memory', 'mem_low', 'mem.available'],
    ['GPU 0', 'gpu_temp_high', 'gpu0.temp_c'],
  ])('still says ws1 has GPU 3 heating up while a warning on %s is open', (_, rule, metric) => {
    useEvents.setState({ events: [openAlert('ws1', 'warning', rule, metric)] });
    show(ws1, [gpu3At(89)]);
    expect(screen.getByRole('heading', { name: 'ws1 has GPU 3 heating up · 1 warning' })).toBeInTheDocument();
  });

  it("lets GPU 3's own temperature warning say it is heating up, and still counts the warning", () => {
    useEvents.setState({ events: [openAlert('ws1', 'warning', 'gpu_temp_high', 'gpu3.temp_c')] });
    show(ws1, [gpu3At(89)]);
    expect(screen.getByRole('heading', { name: 'ws1 is online · 1 warning' })).toBeInTheDocument();
    expect(cardPill('ws1')).toHaveAttribute('data-status', 'warning');
  });

  it('lets a critical temperature alert say a GB10 is at its slowdown temperature, as before', () => {
    useEvents.setState({ events: [openAlert('spark1', 'critical', 'gpu_temp_critical', 'gpu0.temp_c')] });
    show(gb10, [{ ...gb10Reading, gpu: gb10Reading.gpu.map((g) => ({ ...g, temp_c: 87 })) }]);
    expect(screen.getByRole('heading', { name: 'spark1 is online · 1 critical alert' })).toBeInTheDocument();
    expect(heroPill()).toHaveAttribute('data-status', 'critical');
  });

  const nvmlFails = (s: Sample): Sample => ({ ...s, gpu: [], errors: { ...s.errors, gpu: 'nvml: Unknown Error' } });
  const failingFor = (seconds: number, s: Sample) => [s, ...Array.from({ length: seconds }, () => nvmlFails(s))];

  it.each([
    ['for 5 s after its last reading', failingFor(5, gb10Reading)],
    ['on all 6 samples this browser received', Array.from({ length: 6 }, () => nvmlFails(gb10Reading))],
  ])('says a GB10 whose NVML failed every tick %s has a GPU not responding', (_, samples) => {
    show(gb10, samples);
    expect(screen.getByRole('heading', { name: 'spark1 has a GPU not responding' })).toBeInTheDocument();
    expect(heroPill()).toHaveTextContent('Needs attention');
    expect(cardPill('spark1')).toHaveAttribute('data-status', 'warning');
  });

  it('keeps a GB10 healthy after one tick its NVML failed', () => {
    show(gb10, failingFor(1, gb10Reading));
    expect(screen.getByRole('heading', { name: 'spark1 is healthy' })).toBeInTheDocument();
    expect(cardPill('spark1')).toHaveAttribute('data-status', 'healthy');
  });

  it('names all four GPUs of ws1 once its NVML has failed for 5 s', () => {
    show(ws1, failingFor(5, wsReading));
    expect(screen.getByRole('heading', { name: 'ws1 has GPUs 0, 1, 2 and 3 not responding' })).toBeInTheDocument();
    expect(cardPill('ws1')).toHaveAttribute('data-status', 'warning');
  });

  const pushAt = (info: NodeInfo, samples: [number, Sample][]) => {
    useCluster.getState().setHello(cluster([node(info.node_id, { info })]));
    act(() => {
      liveStore.removeNode(info.node_id);
      for (const [ago, s] of samples) liveStore.pushSample({ ...s, node_id: info.node_id, ts: now - ago });
      liveStore.flush();
    });
    render(<Overview />);
  };

  it('keeps a GB10 healthy on its first sample back after 11 s without samples, though its GPU last reported before the gap', () => {
    pushAt(gb10, [[11, gb10Reading], [0, nvmlFails(gb10Reading)]]);
    expect(screen.getByRole('heading', { name: 'spark1 is healthy' })).toBeInTheDocument();
    expect(cardPill('spark1')).toHaveAttribute('data-status', 'healthy');
  });

  it("says a GB10's GPU processes are not known only once its NVML has failed as long as the pill waits", () => {
    const idle = gb10Reading.procs?.filter((p) => !p.gpu_mem) ?? [];
    const card = () => screen.getByRole('region', { name: 'Node spark1' });
    show(gb10, failingFor(1, { ...gb10Reading, procs: idle }));
    expect(within(card()).getByText('No GPU processes')).toBeInTheDocument();
    expect(document.querySelector('.ov-hero__workload')).toHaveTextContent(/^No GPU workloads$/);
    cleanup();
    show(gb10, failingFor(5, { ...gb10Reading, procs: idle }));
    expect(within(card()).queryByText('No GPU processes')).not.toBeInTheDocument();
    expect(within(card()).getByText(/^GPU processes/)).toHaveTextContent(/^GPU processes Not responding/);
    expect(document.querySelector('.ov-hero__workload')).toHaveTextContent(/^GPU workloads not reported$/);
  });
});
