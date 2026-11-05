import { act, render, screen, within } from '@testing-library/react';
import type { NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import sampleJson from '../../test/fixtures/sample.json';
import wsInfo from '../../test/fixtures/platforms/workstation/info.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
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

describe('a four-GPU workstation on the wall (ws1)', () => {
  const reading = wsSample as unknown as Sample;
  const show = (sample: Sample) => {
    const state: NodeState = { node_id: 'ws1', url: '', status: 'online', since: now, last_sample_ts: now, error: null, info: wsInfo as unknown as NodeInfo, next_retry_ts: null };
    useConnection.setState({ status: 'live', everLive: true });
    useCluster.setState({ clockOffset: 0, nodes: { ws1: state } });
    act(() => {
      liveStore.removeNode('ws1');
      liveStore.pushSample({ ...sample, ts: now });
      liveStore.flush();
    });
    render(<WallTile id="ws1" />);
  };
  const value = (label: string) => screen.getByText(label, { selector: '.wall-label' }).parentElement as HTMLElement;

  it('shows the mean utilisation, the hottest GPU and the four powers summed', () => {
    show(reading);
    expect(value('GPU utilisation')).toHaveTextContent(/^GPU utilisation86%/);
    expect(value('GPU temperature')).toHaveTextContent(/^GPU temperature77°C$/);
    expect(value('GPU power')).toHaveTextContent(/^GPU power1069W$/);
  });

  it('marks the utilisation and temperature it reads from 3 of 4 GPUs while GPU 0 is lost, and raises the pill', () => {
    const LOST = 'NVML could not open GPU 0 (NVML: GPU is lost)';
    const info = { ...(wsInfo as unknown as NodeInfo), unsupported: [{ metric: 'gpu0', reason: LOST, kind: 'hardware' }, { metric: 'gpu.power_w', reason: `GPU 0: ${LOST}`, kind: 'hardware' }] } as NodeInfo;
    const state: NodeState = { node_id: 'ws1', url: '', status: 'online', since: now, last_sample_ts: now, error: null, info, next_retry_ts: null };
    useConnection.setState({ status: 'live', everLive: true });
    useCluster.setState({ clockOffset: 0, nodes: { ws1: state } });
    act(() => {
      liveStore.removeNode('ws1');
      liveStore.pushSample({ ...reading, ts: now, gpu: reading.gpu.map((g) => (g.index === 0 ? ({ index: 0 } as Sample['gpu'][number]) : g)) });
      liveStore.flush();
    });
    render(<WallTile id="ws1" />);
    expect(value('GPU utilisation')).toHaveTextContent(/^GPU utilisation87%3 of 4 GPUs$/);
    expect(value('GPU temperature')).toHaveTextContent(/^GPU temperature77°C3 of 4 GPUs$/);
    expect(screen.getByRole('region', { name: 'Node ws1' }).querySelector('[data-status]')?.getAttribute('data-status')).toBe('warning');
    expect(screen.getByRole('img', { name: /^ws1 GPU utilisation/ })).toHaveAccessibleName(/^ws1 GPU utilisation \(3 of 4 GPUs\), last 5 minutes/);
  });

  it('says there is no power total, naming GPU 2, while GPU 2 sends no power reading', () => {
    show({ ...reading, gpu: reading.gpu.map((g) => (g.index === 2 ? { ...g, power_w: null } : g)) });
    expect(value('GPU power')).toHaveTextContent('No total');
    expect(within(value('GPU power')).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription('GPU 2 sent no power reading this tick, so a sum would understate.');
  });
});
