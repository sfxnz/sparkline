import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClusterState, NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { useEvents } from '../../store/events';
import { liveStore } from '../../store/live';
import sampleJson from '../../test/fixtures/sample.json';
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
});
