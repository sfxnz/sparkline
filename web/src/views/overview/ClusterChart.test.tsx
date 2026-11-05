import { act, render, screen } from '@testing-library/react';
import type { NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { liveStore } from '../../store/live';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../test/fixtures/platforms/gb10/sample.json';
import wsInfo from '../../test/fixtures/platforms/workstation/info.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
import { ClusterChart } from './ClusterChart';

vi.mock('uplot', () => ({
  default: class {
    static pxRatio = 1;
    static fmtDate = () => () => '';
    static rangeNum = (lo: number, hi: number) => [lo, hi];
    bbox = { left: 0, top: 0, width: 600, height: 200 };
    cursor = { idx: null };
    scales = { x: { min: 0, max: 1 } };
    select = { width: 0 };
    setData() {}
    setScale() {}
    setSize() {}
    valToPos() { return 0; }
    destroy() {}
  },
}));

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
});
afterAll(() => { vi.unstubAllGlobals(); });

const now = Date.now() / 1000;
const state = (info: NodeInfo): NodeState => ({ node_id: info.node_id, url: '', status: 'online', since: now, last_sample_ts: now, error: null, info, next_retry_ts: null });
const ws1 = wsInfo as unknown as NodeInfo;
const reading = wsSample as unknown as Sample;
const LOST = 'NVML could not open GPU 0 (NVML: GPU is lost)';

function show(info: NodeInfo, sample: Sample) {
  useCluster.setState({ clockOffset: 0, order: [info.node_id], nodes: { [info.node_id]: state(info) } });
  act(() => {
    liveStore.removeNode(info.node_id);
    liveStore.pushSample({ ...sample, ts: now });
    liveStore.flush();
  });
  render(<ClusterChart nodes={[info.node_id]} />);
}
const legend = (title: string) => screen.findByRole('list', { name: `${title} series` });

it("marks ws1's utilisation legend while it reads 3 of its 4 GPUs", async () => {
  const lost = { ...ws1, unsupported: [{ metric: 'gpu0', reason: LOST, kind: 'hardware' }] } as NodeInfo;
  show(lost, { ...reading, gpu: reading.gpu.map((g) => (g.index === 0 ? { index: 0 } : g)) } as Sample);
  expect(await legend('ws1 GPU utilisation')).toHaveTextContent(/^ws1 \(3 of 4 GPUs\)/);
});

it('names only the node in the legends while every GPU reports', async () => {
  show(ws1, reading);
  expect(await legend('ws1 GPU utilisation')).toHaveTextContent(/^ws1(?!\s*\()/);
  show(gb10Info as unknown as NodeInfo, { ...(gb10Sample as unknown as Sample), node_id: 'spark1' });
  expect(await legend('spark1 GPU utilisation')).toHaveTextContent(/^spark1(?!\s*\()/);
});
