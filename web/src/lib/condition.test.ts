import { act, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { useEvents } from '../store/events';
import { liveStore } from '../store/live';
import { usePrefs } from '../store/prefs';
import sampleJson from '../test/fixtures/sample.json';
import wsInfo from '../test/fixtures/platforms/workstation/info.json';
import wsSample from '../test/fixtures/platforms/workstation/sample.json';
import Thermals from '../views/node/Thermals';
import { NodeCard } from '../views/overview/NodeCard';
import { gpuConditions, nodeCondition, tempRoom } from './condition';
import type { GpuSample, NodeInfo, NodeState, Sample } from './types';
import { gpuAt } from './gpu';

vi.mock('../charts/TimeSeriesChart', async (importActual) => ({
  ...(await importActual<typeof import('../charts/TimeSeriesChart')>()),
  TimeSeriesChart: () => null,
}));

describe('tempRoom', () => {
  it('counts the whole degrees between the temperature and the limit as displayed', () => {
    expect(tempRoom(70, 86)).toEqual({ degrees: 16, level: 'ok' });
    expect(tempRoom(79.4, 86)).toEqual({ degrees: 7, level: 'ok' });
    expect(tempRoom(79.5, 86)).toEqual({ degrees: 6, level: 'warn' });
    expect(tempRoom(85.6, 86)).toEqual({ degrees: 0, level: 'crit' });
    expect(tempRoom(87, 86)).toEqual({ degrees: -1, level: 'crit' });
  });

  it('warns within 6 °C of a sensor limit too (NVMe critical at 84.85 °C, shown as 85 °C)', () => {
    expect(tempRoom(79, 84.85)).toEqual({ degrees: 6, level: 'warn' });
    expect(tempRoom(78, 84.85)).toEqual({ degrees: 7, level: 'ok' });
  });

  it('is null without a reading or a limit', () => {
    expect(tempRoom(70, null)).toBeNull();
    expect(tempRoom(null, 86)).toBeNull();
    expect(tempRoom(Number.NaN, 86)).toBeNull();
  });
});

type Reading = { temp_c: number | null; throttle_mask: number | null };
const oneGpu = (gpu: Reading | null, slowdown: number | null) =>
  nodeCondition({ gpus: [{ index: 0, temp_slowdown_c: slowdown }], unsupported: [] } as unknown as NodeInfo, { gpu: gpu ? [{ index: 0, ...gpu }] : [] } as unknown as Sample);

describe('nodeCondition on a one-GPU node', () => {
  it('is null for a calm GPU and when nothing is known', () => {
    expect(oneGpu({ temp_c: 60, throttle_mask: 0 }, 86)).toBeNull();
    expect(oneGpu(null, 86)).toBeNull();
    expect(oneGpu({ temp_c: null, throttle_mask: null }, null)).toBeNull();
  });

  it('flags the slowdown temperature as critical, and closing in on it as a warning', () => {
    expect(oneGpu({ temp_c: 86, throttle_mask: 0 }, 86)).toEqual({ level: 'critical', text: 'is at its GPU slowdown temperature' });
    expect(oneGpu({ temp_c: 81, throttle_mask: 0 }, 86)).toEqual({ level: 'warning', text: 'is heating up' });
    expect(oneGpu({ temp_c: 79, throttle_mask: 0 }, 86)).toBeNull();
  });

  it('raises on hardware and thermal clock limits, never on idle or the power cap', () => {
    expect(oneGpu({ temp_c: 70, throttle_mask: 0x1 | 0x4 }, 86)).toBeNull();
    expect(oneGpu({ temp_c: 70, throttle_mask: 0x20 }, 86)).toEqual({ level: 'warning', text: 'has GPU clocks limited by thermal limit' });
    expect(oneGpu({ temp_c: 70, throttle_mask: 0x24 | 0x40 }, 86)).toEqual({ level: 'critical', text: 'has GPU clocks limited by overheating' });
  });

  it('raises a warning for its one lost GPU at once', () => {
    const info = { gpus: [{ index: 0, temp_slowdown_c: 86 }], unsupported: [{ metric: 'gpu0', reason: 'NVML could not open GPU 0 (NVML: GPU is lost)', kind: 'hardware' }] } as unknown as NodeInfo;
    expect(nodeCondition(info, { gpu: [{ index: 0 }] } as unknown as Sample)).toMatchObject({ level: 'warning', text: 'has a GPU not responding' });
  });
});

const ws1 = wsInfo as unknown as NodeInfo;
const wsReading = wsSample as unknown as Sample;
const withGpus = (over: Record<number, Partial<GpuSample>>): Sample => ({ ...wsReading, gpu: wsReading.gpu.map((g) => ({ ...g, ...over[g.index] })) });

describe('nodeCondition on a multi-GPU node (ws1, slowdown 93 °C)', () => {
  it('is null while every GPU is calm', () => {
    expect(nodeCondition(ws1, wsReading)).toBeNull();
  });

  it('names the one GPU at its slowdown temperature, judged against its own slowdown', () => {
    expect(nodeCondition(ws1, withGpus({ 3: { temp_c: 94 } }))).toEqual({ level: 'critical', text: 'has GPU 3 at its slowdown temperature' });
    expect(nodeCondition(ws1, withGpus({ 3: { temp_c: 89 } }))).toEqual({ level: 'warning', text: 'has GPU 3 heating up' });
  });

  it('names the one GPU whose clocks are limited', () => {
    expect(nodeCondition(ws1, withGpus({ 3: { throttle_mask: 0x40 } }))).toEqual({ level: 'critical', text: 'has GPU 3 clocks limited by overheating' });
  });

  it('says only the worst level, grouping the GPUs that share a clause', () => {
    expect(nodeCondition(ws1, withGpus({ 1: { temp_c: 89 }, 2: { temp_c: 93 }, 3: { temp_c: 95 } }))).toEqual({ level: 'critical', text: 'has GPUs 2 and 3 at their slowdown temperature' });
    expect(nodeCondition(ws1, withGpus({ 1: { temp_c: 93 }, 2: { throttle_mask: 0x8 } }))).toEqual({ level: 'critical', text: 'has GPU 1 at its slowdown temperature and GPU 2 clocks limited by hardware slowdown' });
    expect(nodeCondition(ws1, withGpus({ 0: { temp_c: 93 }, 1: { throttle_mask: 0x8 }, 2: { throttle_mask: 0x40 } }))).toEqual({ level: 'critical', text: 'has 3 GPUs needing attention' });
  });

  const lost = (index: number) => ({ ...ws1, unsupported: [{ metric: `gpu${String(index)}`, reason: `NVML could not open GPU ${String(index)} (NVML: GPU is lost)`, kind: 'hardware' }] }) as NodeInfo;
  const empty = { util: null, temp_c: null, power_w: null, throttle_mask: null };

  it('raises a warning naming a lost GPU, which a GPU at its slowdown temperature outranks', () => {
    const outsideAlertRules = { level: 'warning', text: 'has GPU 0 not responding' };
    expect(nodeCondition(lost(0), withGpus({ 0: empty }))).toEqual({ level: 'warning', text: 'has GPU 0 not responding', outsideAlertRules });
    expect(nodeCondition(lost(0), withGpus({ 0: empty, 3: { temp_c: 89 } }))).toEqual({ level: 'warning', text: 'has GPU 0 not responding and GPU 3 heating up', outsideAlertRules });
    expect(nodeCondition(lost(0), withGpus({ 0: empty, 3: { temp_c: 94 } }))).toEqual({ level: 'critical', text: 'has GPU 3 at its slowdown temperature', outsideAlertRules });
  });

  it('still names the GPU before the node info arrives, from the clock limit the sample shows', () => {
    expect(nodeCondition(null, withGpus({ 3: { temp_c: 99, throttle_mask: 0x40 } }))).toEqual({ level: 'critical', text: 'has GPU 3 clocks limited by overheating' });
  });
});

describe('gpuConditions', () => {
  it('lists each GPU that needs attention in index order, with what its reading shows', () => {
    const shuffled = withGpus({ 1: { throttle_mask: 0x20 }, 3: { temp_c: 94.2 } });
    expect(gpuConditions(ws1, { ...shuffled, gpu: shuffled.gpu.toReversed() }).map((c) => [c.index, c.level, c.reading])).toEqual([
      [1, 'warning', 'Clocks limited by thermal limit'],
      [3, 'critical', 'At slowdown, 94\u00a0°C (slows at 93\u00a0°C)'],
    ]);
  });
});

type Level = 'ok' | 'warn' | 'crit';
const NODE = 'trule';
const info = {
  node_id: NODE,
  gpus: [{ index: 0, name: 'NVIDIA GB10', temp_slowdown_c: 86, temp_shutdown_c: 90, power_limit_w: null }],
  sensors: [],
  unsupported: [],
} as unknown as NodeInfo;
const now = Date.now() / 1000;
const online: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: now, last_sample_ts: now, error: null, info, next_retry_ts: null };

const toneOf = (el: Element | null | undefined, crit: string, warn: string): Level => (el?.classList.contains(crit) ? 'crit' : el?.classList.contains(warn) ? 'warn' : 'ok');
const PILL: Record<string, Level> = { critical: 'crit', warning: 'warn', healthy: 'ok' };

describe('one GPU temperature rule on every surface (slowdown 86 °C, shutdown 90 °C)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    usePrefs.setState({ timeRange: 'live' });
    useConnection.setState({ status: 'live', everLive: true });
    useEvents.setState({ events: [] });
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: online } });
    liveStore.removeNode(NODE);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each<[number, Level]>([
    [80.6, 'warn'],
    [81, 'warn'],
    [85.4, 'warn'],
    [85.6, 'crit'],
    [86, 'crit'],
    [90, 'crit'],
  ])('%s °C reads %s on the overview card, its status pill, the Thermals header and the GPU sensor row', (temp, level) => {
    const sample = sampleJson as unknown as Sample;
    act(() => {
      liveStore.pushSample({ ...sample, node_id: NODE, ts: now, gpu: [{ ...(gpuAt(sample.gpu, 0) as GpuSample), temp_c: temp }] });
      liveStore.flush();
    });

    const card = render(createElement(NodeCard, { id: NODE })).container;
    const cardFlag = screen.getByText('GPU temp').closest('.ov-stat')?.querySelector('.ov-flag');
    const pill = card.querySelector('[data-status]')?.getAttribute('data-status') ?? '';

    render(createElement(Thermals, { nodeId: NODE }));
    const header = within(screen.getByRole('region', { name: `${NODE} thermals and power summary` })).getByText(/slowdown|shutdown/);
    const row = within(screen.getByRole('region', { name: 'GPU' })).getByRole('rowheader', { name: 'NVIDIA GB10' }).closest('tr')?.querySelector('.tp-room');

    expect({
      card: toneOf(cardFlag, 'tone-crit', 'tone-warn'),
      pill: PILL[pill],
      header: toneOf(header, 'nlevel-crit', 'nlevel-warn'),
      row: toneOf(row, 'tone-crit', 'tone-warn'),
    }).toEqual({ card: level, pill: level, header: level, row: level });
  });
});
