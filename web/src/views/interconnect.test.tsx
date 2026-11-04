import { act, render, screen } from '@testing-library/react';
import type { ClusterState, NetIfInfo, NodeInfo, NodeState, Sample } from '../lib/types';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { useEvents } from '../store/events';
import { liveStore } from '../store/live';
import sampleJson from '../test/fixtures/sample.json';
import Summary from './node/Summary';
import Overview from './Overview';
import { WallTile } from './wall/WallTile';

vi.mock('../charts/TimeSeriesChart', async (importActual) => ({
  ...(await importActual<typeof import('../charts/TimeSeriesChart')>()),
  TimeSeriesChart: ({ title, series }: { title: string; series: readonly { label: string }[] }) => (
    <figure aria-label={title}>{series.map((s) => s.label).join(', ')}</figure>
  ),
}));

const now = Date.now() / 1000;
const NODES = ['spark1', 'spark2'] as const;
const peerOf = (id: string) => (id === 'spark1' ? 'spark2' : 'spark1');

const nif = (name: string, label: string, p: Partial<NetIfInfo> = {}): NetIfInfo => ({
  name, role: 'interconnect', label, mac: null, ipv4: [], speed_mbps: 200_000, rdma_device: null, counter_source: 'netdev_rdma', peer: null, ...p,
});
type Labels = readonly [string, string, string];
const NEW_LABELS: Labels = ['Interconnect A', 'Interconnect B', 'Interconnect port (no cable)'];
const OLD_LABELS: Labels = ['ConnectX-7 rail A', 'ConnectX-7 rail B', 'ConnectX-7 port (no cable)'];

function net(peer: string, labels: Labels, nic_model?: string | null): NetIfInfo[] {
  return [
    nif('enp1s0f1np1', labels[0], { peer, nic_model }),
    nif('enP2p1s0f1np1', labels[1], { peer, nic_model }),
    nif('enp1s0f0np0', labels[2], { speed_mbps: null, nic_model }),
    nif('enP7s7', 'LAN', { role: 'lan', counter_source: 'netdev' }),
  ];
}

const info = (id: string, n: NetIfInfo[]) => ({ node_id: id, gpus: [], cores: [], mem_total: 128e9, net: n, disks: [], sensors: [], unsupported: [] }) as unknown as NodeInfo;
const node = (id: string, n: NetIfInfo[]): NodeState => ({
  node_id: id, url: `http://${id}:9750`, status: 'online', since: now, last_sample_ts: now, error: null, info: info(id, n), next_retry_ts: null,
});
const hello = (nodes: NodeState[]): ClusterState => ({
  nodes,
  settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
  demo: true,
  version: 'test',
  server_time: now,
});

function cluster(netOf: (id: string) => NetIfInfo[]) {
  useCluster.getState().setHello(hello(NODES.map((id) => node(id, netOf(id)))));
  act(() => {
    for (const id of NODES) liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: id, ts: now });
    liveStore.flush();
  });
}

function renderAll() {
  return render(
    <>
      <Overview />
      <Summary nodeId="spark1" />
      <WallTile id="spark1" />
    </>,
  );
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  HTMLCanvasElement.prototype.getContext = () => null;
});
beforeEach(() => {
  for (const id of NODES) liveStore.removeNode(id);
  useConnection.setState({ status: 'live', everLive: true });
  useEvents.setState({ events: [] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('interconnect wording', () => {
  it('reads a GB10 on a new agent exactly as the ConnectX-7 labels did', () => {
    cluster((id) => net(peerOf(id), NEW_LABELS, 'ConnectX-7'));
    renderAll();
    expect(screen.getByText('ConnectX-7 direct links · live')).toBeInTheDocument();
    expect(screen.getAllByText('ConnectX-7')).toHaveLength(2);
    expect(screen.getAllByTitle('ConnectX-7').map((e) => e.textContent)).toEqual(['CX7', 'CX7']);
    expect(screen.getAllByText('Rail A')).toHaveLength(1);
    expect(screen.getAllByText('Rail B')).toHaveLength(1);
    expect(screen.getByText('ConnectX-7 in')).toBeInTheDocument();
    expect(screen.getByText('ConnectX-7 out')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ConnectX-7 throughput' })).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'ConnectX-7 throughput' })).toHaveTextContent('Rail A in, Rail A out, Rail B in, Rail B out');
    expect(screen.getByText('ConnectX-7 in + out')).toBeInTheDocument();
  });

  it('keeps an old agent’s rails reading Rail A and Rail B', () => {
    cluster((id) => net(peerOf(id), OLD_LABELS));
    renderAll();
    expect(screen.getByText('Rail A')).toBeInTheDocument();
    expect(screen.getByText('Rail B')).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'Interconnect throughput' })).toHaveTextContent('Rail A in, Rail A out, Rail B in, Rail B out');
  });

  it('names a non-ConnectX NIC by its model and never says ConnectX-7', () => {
    cluster((id) => net(peerOf(id), NEW_LABELS, 'Intel E810-C'));
    const { container } = renderAll();
    expect(screen.getByText('Intel E810-C direct links · live')).toBeInTheDocument();
    expect(screen.getByText('Intel E810-C in')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Intel E810-C throughput' })).toBeInTheDocument();
    expect(screen.getByText('Intel E810-C in + out')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/ConnectX|CX7/);
  });

  it('uses generic wording when the agent does not know the NIC', () => {
    cluster((id) => net(peerOf(id), NEW_LABELS, null));
    const { container } = renderAll();
    expect(screen.getByText('Direct links · live')).toBeInTheDocument();
    expect(screen.getByText('Interconnect in')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Interconnect throughput' })).toBeInTheDocument();
    expect(screen.getByText('Interconnect in + out')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/ConnectX|CX7/);
  });

  it('letters rails by position when the interfaces are relabelled', () => {
    cluster((id) => net(peerOf(id), ['Interconnect B', 'fabric', 'spare'], 'ConnectX-7'));
    renderAll();
    expect(screen.getByText('Rail A')).toBeInTheDocument();
    expect(screen.getByText('Rail B')).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'ConnectX-7 throughput' })).toHaveTextContent('Rail A in, Rail A out, Rail B in, Rail B out');
  });

  it('says why a node with no cabled rail has no figures, in its own NIC’s words', () => {
    cluster((id) => net(peerOf(id), NEW_LABELS, 'Intel E810-C').map((n) => ({ ...n, peer: null })));
    render(<Summary nodeId="spark1" />);
    expect(screen.getByText('No Intel E810-C link is cabled on spark1.')).toBeInTheDocument();
  });
});
