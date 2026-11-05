import { act, render, screen, within } from '@testing-library/react';
import { memoryLayout } from '../../lib/memoryLayout';
import type { NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../test/fixtures/platforms/gb10/sample.json';
import wsInfo from '../../test/fixtures/platforms/workstation/info.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
import { SummarySkeleton } from './parts/SummarySkeleton';
import Summary from './Summary';

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

const NODE = 'stest';
const TS = 1_800_000_000;
const ws1 = (): NodeInfo => ({ ...(wsInfo as unknown as NodeInfo), node_id: NODE });
const gb10 = (): NodeInfo => ({ ...(gb10Info as unknown as NodeInfo), node_id: NODE });

const open = (info: NodeInfo, s: Sample) => {
  const node: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: 0, last_sample_ts: TS, error: null, info, next_retry_ts: null };
  useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
  act(() => {
    liveStore.pushSample({ ...s, node_id: NODE, ts: TS });
    liveStore.flush();
  });
  render(<Summary nodeId={NODE} />);
};
const memoryStat = () => screen.getByText('Memory available').closest('.stat');

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

describe('Summary memory', () => {
  it('reads a discrete workstation as system memory, charting what is used without a GPU series', () => {
    open(ws1(), wsSample);
    expect(memoryStat()).toHaveTextContent('of 251.4 GiB system');
    const panel = screen.getByRole('region', { name: 'System memory' });
    expect(panel).toHaveTextContent('Host RAM; VRAM is on the Memory tab');
    expect(within(panel).getByRole('list', { name: 'System memory used series' })).not.toHaveTextContent('GPU-allocated');
  });

  it('reads a GB10 as unified memory, as before', () => {
    open(gb10(), gb10Sample);
    expect(memoryStat()).toHaveTextContent('of 121.7 GiB unified');
    const panel = screen.getByRole('region', { name: 'Unified memory' });
    expect(panel).toHaveTextContent('Shared by CPU and GPU');
    expect(within(panel).getByRole('list', { name: 'Unified memory used series' })).toHaveTextContent('GPU-allocated');
  });

  it('titles the loading memory panel by the same layout', () => {
    const { unmount } = render(<SummarySkeleton memory={memoryLayout(ws1()).name} />);
    expect(screen.getByRole('region', { name: 'System memory' })).toHaveAttribute('aria-busy', 'true');
    unmount();
    render(<SummarySkeleton memory={memoryLayout(gb10()).name} />);
    expect(screen.getByRole('region', { name: 'Unified memory' })).toHaveAttribute('aria-busy', 'true');
  });
});

describe('Summary GPU stats while a GPU sends nothing', () => {
  it('says how long GPU 2 has sent no reading, as the GPU tab banner does', () => {
    const ws = wsSample as unknown as Sample;
    const node: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: 0, last_sample_ts: TS, error: null, info: ws1(), next_retry_ts: null };
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
    act(() => {
      liveStore.pushSample({ ...ws, node_id: NODE, ts: TS - 40 });
      for (let ago = 39; ago >= 0; ago--) liveStore.pushSample({ ...ws, node_id: NODE, gpu: ws.gpu.map((g) => (g.index === 2 ? { ...g, util: null, sm_mhz: null, gr_mhz: null, video_mhz: null, temp_c: null, power_w: null, pstate: null, throttle_mask: null, vram_used: null, shared_used: null } : g)), ts: TS - ago });
      liveStore.flush();
    });
    render(<Summary nodeId={NODE} />);
    const stat = screen.getByText('GPU power', { selector: '.stat__label' }).closest('.stat') as HTMLElement;
    expect(within(stat).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription('GPU 2 has sent no reading for 40\u00a0s, so a sum would understate.');
  });
});
