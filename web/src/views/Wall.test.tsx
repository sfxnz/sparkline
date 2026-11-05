import { act, render, screen, within } from '@testing-library/react';
import type { NodeInfo, NodeState, Sample } from '../lib/types';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { useEvents } from '../store/events';
import { liveStore } from '../store/live';
import gb10Info from '../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../test/fixtures/platforms/gb10/sample.json';
import wsInfo from '../test/fixtures/platforms/workstation/info.json';
import wsSample from '../test/fixtures/platforms/workstation/sample.json';
import Wall from './Wall';

const now = Date.now() / 1000;
const LOST = 'NVML could not open GPU 0 (NVML: GPU is lost)';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLCanvasElement.prototype.getContext = () => null;
});

const state = (info: NodeInfo): NodeState => ({ node_id: info.node_id, url: '', status: 'online', since: now, last_sample_ts: now, error: null, info, next_retry_ts: null });

it("names a four-GPU node beside the wall's GPU power while its GPU 0 is lost, and counts the GPUs its utilisation reads", () => {
  const ws = wsInfo as unknown as NodeInfo;
  const lost = { ...ws, unsupported: [{ metric: 'gpu0', reason: LOST, kind: 'hardware' }, { metric: 'gpu.power_w', reason: `GPU 0: ${LOST}`, kind: 'hardware' }] } as NodeInfo;
  const spark1 = gb10Info as unknown as NodeInfo;
  useConnection.setState({ status: 'live', everLive: true });
  useEvents.setState({ events: [] });
  useCluster.setState({ clockOffset: 0, order: ['spark1', 'ws1'], nodes: { spark1: state(spark1), ws1: state(lost) } });
  const reading = wsSample as unknown as Sample;
  act(() => {
    for (const id of ['spark1', 'ws1']) liveStore.removeNode(id);
    liveStore.pushSample({ ...(gb10Sample as unknown as Sample), node_id: 'spark1', ts: now });
    liveStore.pushSample({ ...reading, ts: now, gpu: reading.gpu.map((g) => (g.index === 0 ? { index: 0 } : g)) } as Sample);
    liveStore.flush();
  });
  render(<Wall />);
  expect(document.querySelector('.wall-hero__line')).toHaveTextContent(/ W GPU power · excl\. ws1$/);
  expect(document.querySelector('.wall-hero__line')).toHaveTextContent(/^GPU \d+% across 2 live nodes \(4 of 5 GPUs\)·/);
});

it("counts the GPUs under the wall's utilisation while every GPU of the second workstation is silent", () => {
  const ws = wsInfo as unknown as NodeInfo;
  const reading = wsSample as unknown as Sample;
  useConnection.setState({ status: 'live', everLive: true });
  useEvents.setState({ events: [] });
  useCluster.setState({ clockOffset: 0, order: ['ws1', 'ws2'], nodes: { ws1: state(ws), ws2: state({ ...ws, node_id: 'ws2' }) } });
  act(() => {
    for (const id of ['ws1', 'ws2']) liveStore.removeNode(id);
    liveStore.pushSample({ ...reading, ts: now });
    liveStore.pushSample({ ...reading, node_id: 'ws2', ts: now, gpu: reading.gpu.map((g) => ({ index: g.index })) } as Sample);
    liveStore.flush();
  });
  render(<Wall />);
  expect(document.querySelector('.wall-hero__line')).toHaveTextContent(/^GPU 86% across 2 live nodes \(4 of 8 GPUs\)·1069 W GPU power · excl\. ws2$/);
});

describe('the wall says why it cannot read a node', () => {
  const NVML_DOWN = 'NVMLError_Unknown: Unknown Error';
  const gb10 = (id: string) => ({ ...(gb10Info as unknown as NodeInfo), node_id: id, hostname: id });
  const gb10Reading = (id: string, over: Partial<Sample> = {}): Sample => ({ ...(gb10Sample as unknown as Sample), node_id: id, ts: now, ...over });
  const backendDown = (s: Sample): Sample => ({ ...s, gpu: [], errors: { ...s.errors, gpu: `nvml: ${NVML_DOWN}` } });
  const show = (nodes: readonly (readonly [NodeInfo, Sample])[]) => {
    useConnection.setState({ status: 'live', everLive: true });
    useEvents.setState({ events: [] });
    useCluster.setState({ clockOffset: 0, order: nodes.map(([info]) => info.node_id), nodes: Object.fromEntries(nodes.map(([info]) => [info.node_id, state(info)])) });
    act(() => {
      for (const [info, s] of nodes) {
        liveStore.removeNode(info.node_id);
        liveStore.pushSample(s);
      }
      liveStore.flush();
    });
    render(<Wall />);
  };
  const value = (id: string, label: string) => within(screen.getByRole('region', { name: `Node ${id}` })).getByText(label, { selector: '.wall-label' }).parentElement as HTMLElement;

  it('reads Not responding on the tile of a GB10 whose GPU sends nothing', () => {
    show([[gb10('spark1'), gb10Reading('spark1')], [gb10('spark2'), backendDown(gb10Reading('spark2'))]]);
    for (const label of ['GPU utilisation', 'GPU temperature', 'GPU power']) expect(value('spark2', label)).toHaveTextContent('Not responding');
  });

  it('names a GB10 whose GPU sends nothing beside the GPU power', () => {
    show([[gb10('spark1'), gb10Reading('spark1')], [gb10('spark2'), backendDown(gb10Reading('spark2'))]]);
    expect(document.querySelector('.wall-hero__line')).toHaveTextContent(/·24\.5 W GPU power · excl\. spark2$/);
  });
});
