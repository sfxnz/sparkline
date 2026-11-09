import { act, render, screen } from '@testing-library/react';
import { percentParts } from '../../../lib/format';
import { gpuAt } from '../../../lib/gpu';
import type { Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useConnection } from '../../../store/connection';
import { liveStore } from '../../../store/live';
import { LiveStat } from './LiveStat';

const NODE = 'lstest';
const T = 1_800_000_000;
const gpuUtil = (s: Sample | null) => gpuAt(s?.gpu, 0)?.util ?? null;

describe('LiveStat fallback', () => {
  beforeEach(() => {
    liveStore.removeNode(NODE);
    vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: q.includes('reduce'), media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }));
    useConnection.setState({ status: 'live', everLive: true });
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { node_id: NODE, url: 'http://x:9750', status: 'offline', since: 0, last_sample_ts: T, error: null, info: null, next_retry_ts: null } } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a last known value that a reconnect gap fill adds behind the newest tick', () => {
    act(() => {
      liveStore.seed({ node_id: NODE, resolution_s: 1, ts: [T, T + 10], series: { 'gpu0.util': [30, null] }, min: {}, max: {} });
      liveStore.flush();
    });
    render(<LiveStat nodeId={NODE} label="Utilisation" select={gpuUtil} metric="gpu0.util" format={percentParts} />);
    expect(screen.getByText('Utilisation').closest('.stat')).toHaveTextContent(/30\s*%/);

    act(() => {
      liveStore.seed({ node_id: NODE, resolution_s: 1, ts: [T + 5], series: { 'gpu0.util': [60] }, min: {}, max: {} });
      liveStore.flush();
    });
    expect(liveStore.lastTs(NODE)).toBe(T + 10);
    expect(screen.getByText('Utilisation').closest('.stat')).toHaveTextContent(/60\s*%/);
  });
});
