import { act, render, screen, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { GpuInfo, NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import sampleJson from '../../test/fixtures/sample.json';
import Gpu from './Gpu';

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

const NODE = 'gtest';
const TS = 1_800_000_000;
const NV_ERROR = 'RuntimeError: NVML read failed';

const gpuInfo = (index: number, name: string, vendor: string, backend: string) =>
  ({ index, name, vendor, backend, uuid: null, arch: null, compute_capability: null, cuda_cores: null, sm_mhz_max: 3000, temp_slowdown_c: 86, temp_shutdown_c: 90, temp_max_c: null, power_limit_w: null }) as GpuInfo;

const hybrid = {
  node_id: NODE, platform: 'linux', versions: {}, gpus: [
    gpuInfo(0, 'NVIDIA GB10', 'nvidia', 'nvml'),
    gpuInfo(1, 'Radeon 8060S', 'amd', 'amdgpu-sysfs'),
    gpuInfo(2, 'Radeon RX 7900 XTX', 'amd', 'amdgpu-sysfs'),
  ], cores: [], net: [], disks: [], sensors: [], unsupported: [],
} as unknown as NodeInfo;

const base = sampleJson as unknown as Sample;
const reading = (index: number, util: number, temp_c: number, power_w: number) => ({ ...base.gpu[0], index, util, temp_c, power_w });

const show = (sample: Sample) => {
  const node: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: 0, last_sample_ts: TS, error: null, info: hybrid, next_retry_ts: null };
  useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
  act(() => {
    liveStore.pushSample({ ...sample, node_id: NODE, ts: TS });
    liveStore.flush();
  });
  render(
    <Router hook={memoryLocation({ path: '/' }).hook}>
      <Gpu nodeId={NODE} />
    </Router>,
  );
  return screen.getByRole('region', { name: 'NVIDIA GB10 now' });
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  liveStore.removeNode(NODE);
  usePrefs.setState({ timeRange: 'live' });
  useConnection.setState({ status: 'live', everLive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GPU tab on a node with two vendors', () => {
  it("shows GPU 0 as not responding when only GPUs 1 and 2 report, never another GPU's numbers", () => {
    const now = show({ ...base, gpu: [reading(1, 37, 61, 140), reading(2, 57, 64, 240)], errors: { gpu: `nvml: ${NV_ERROR}` } });

    expect(within(now).queryByText('37')).not.toBeInTheDocument();
    expect(within(now).queryByText('61')).not.toBeInTheDocument();
    expect(within(now).queryByText('140')).not.toBeInTheDocument();
    expect(within(now).getAllByText('Not responding').length).toBeGreaterThanOrEqual(3);
    expect(within(now).getAllByRole('button', { name: 'Why is this not reported?' })[0]).toHaveAccessibleDescription(NV_ERROR);
  });

  it('names the failing backend and its GPU in the notice, and says the other GPUs still report', () => {
    show({ ...base, gpu: [reading(1, 37, 61, 140), reading(2, 57, 64, 240)], errors: { gpu: `nvml: ${NV_ERROR}` } });

    const note = screen.getByRole('list', { name: 'Metrics unavailable' });
    expect(note).toHaveTextContent(`GPU 0 (NVIDIA GB10) not responding: ${NV_ERROR}`);
    expect(note).toHaveTextContent('The nvml backend sent no reading this tick. GPUs 1 and 2 still report.');
    expect(note).not.toHaveTextContent('GPU metrics unavailable');
  });

  it('shows GPU 0 numbers when GPU 0 reports, wherever it sits in the sample', () => {
    const now = show({ ...base, gpu: [reading(2, 57, 64, 240), reading(0, 91, 71, 32.4)], errors: {} });

    expect(within(now).getByText('91')).toBeInTheDocument();
    expect(within(now).queryByText('57')).not.toBeInTheDocument();
    expect(within(now).queryByText('Not responding')).not.toBeInTheDocument();
  });
});
