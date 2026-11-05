import { act, render, screen, within } from '@testing-library/react';
import type { NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import sampleJson from '../../test/fixtures/sample.json';
import { WallTile } from './WallTile';

const now = Date.now() / 1000;

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLCanvasElement.prototype.getContext = () => null;
});

it('says a Wi-Fi-only node has no direct link, not that ConnectX-7 is not collected yet', () => {
  const reason = 'Only Wi-Fi or virtual interfaces (wlp2s0), which Sparkline skips unless include_virtual = true';
  const wifi = { name: 'wlp2s0', role: 'wireless', label: 'Wi-Fi', mac: null, ipv4: [], speed_mbps: null, rdma_device: null, counter_source: 'netdev', peer: null };
  const info = { node_id: 'wifi1', hostname: 'wifi1', gpus: [], net: [wifi], cores: [], disks: [], sensors: [], mem_total: 0, unsupported: [{ metric: 'net', reason, kind: 'agent' }] } as unknown as NodeInfo;
  const state: NodeState = { node_id: 'wifi1', url: '', status: 'online', since: now, last_sample_ts: now, error: null, info, next_retry_ts: null };
  useConnection.setState({ status: 'live', everLive: true });
  useCluster.setState({ clockOffset: 0, nodes: { wifi1: state } });
  act(() => {
    liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: 'wifi1', ts: now, net: [] });
    liveStore.flush();
  });
  render(<WallTile id="wifi1" />);
  const cx7 = screen.getByText('ConnectX-7 in + out').closest('div') as HTMLElement;
  expect(within(cx7).getByText('No direct link')).toBeInTheDocument();
  expect(cx7).not.toHaveTextContent('Not collected yet');
});
