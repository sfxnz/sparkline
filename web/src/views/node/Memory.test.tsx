import { act, render, screen, within } from '@testing-library/react';
import type { NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import Memory from './Memory';

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

const NODE = 'mtest';
const TS = 1_800_000_000;
const GiB = 1024 ** 3;
const PSI_REASON = 'Pressure stall information is not exposed: /proc/pressure/memory is missing (kernel without CONFIG_PSI, or psi=0)';

const info = (unsupported: NodeInfo['unsupported']) =>
  ({ node_id: NODE, mem_total: 128 * GiB, swap_total: 16 * GiB, gpus: [], cores: [], net: [], disks: [], sensors: [], unsupported }) as unknown as NodeInfo;

const sample = (psi: number | null): Sample => ({
  node_id: NODE, ts: TS, seq: 1, interval_ms: 1000, gpu: [],
  mem: { total: 128 * GiB, available: 110 * GiB, used: 12 * GiB, free: 100 * GiB, gpu: null, anon: 5 * GiB, cache: 2 * GiB, shmem: 1 * GiB, kernel: 2 * GiB, other: 2 * GiB, swap_total: 16 * GiB, swap_used: 3 * GiB, psi_some: psi, psi_full: psi },
  cpu: { util: 0, perf_util: null, eff_util: null, per_core: [], freq_mhz: [], load1: 0, load5: 0, load15: 0, psi_some: null },
  net: [], disk: [], fs: [], temps: [], procs: null, errors: {},
});

const show = (unsupported: NodeInfo['unsupported'], psi: number | null) => {
  const node: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: 0, last_sample_ts: TS, error: null, info: info(unsupported), next_retry_ts: null };
  useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
  act(() => {
    liveStore.pushSample(sample(psi));
    liveStore.flush();
  });
  render(<Memory nodeId={NODE} />);
  return screen.getByRole('region', { name: 'Memory pressure' });
};

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

describe('Memory pressure panel', () => {
  it('says once why pressure is not reported when the kernel exposes no PSI', () => {
    const psi = show([
      { metric: 'mem.psi_some', reason: PSI_REASON, kind: 'hardware' },
      { metric: 'mem.psi_full', reason: PSI_REASON, kind: 'hardware' },
    ], null);
    expect(within(psi).getAllByText('Not reported by this hardware')).toHaveLength(1);
    expect(within(psi).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(PSI_REASON);
  });

  it('says how much processes waited when PSI is reported', () => {
    const psi = show([], 0);
    expect(within(psi).queryByText('Not reported by this hardware')).not.toBeInTheDocument();
    expect(within(psi).getByText('No memory pressure')).toBeInTheDocument();
  });
});
