import { act, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { useEvents } from '../store/events';
import { liveStore } from '../store/live';
import { usePrefs } from '../store/prefs';
import sampleJson from '../test/fixtures/sample.json';
import Thermals from '../views/node/Thermals';
import { NodeCard } from '../views/overview/NodeCard';
import { liveCondition, tempRoom } from './condition';
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

describe('liveCondition', () => {
  it('is null for a calm GPU and when nothing is known', () => {
    expect(liveCondition({ temp_c: 60, throttle_mask: 0 }, 86)).toBeNull();
    expect(liveCondition(null, 86)).toBeNull();
    expect(liveCondition({ temp_c: null, throttle_mask: null }, null)).toBeNull();
  });

  it('flags the slowdown temperature as critical, and closing in on it as a warning', () => {
    expect(liveCondition({ temp_c: 86, throttle_mask: 0 }, 86)).toEqual({ level: 'critical', text: 'is at its GPU slowdown temperature' });
    expect(liveCondition({ temp_c: 81, throttle_mask: 0 }, 86)).toEqual({ level: 'warning', text: 'is heating up' });
    expect(liveCondition({ temp_c: 79, throttle_mask: 0 }, 86)).toBeNull();
  });

  it('raises on hardware and thermal clock limits, never on idle or the power cap', () => {
    expect(liveCondition({ temp_c: 70, throttle_mask: 0x1 | 0x4 }, 86)).toBeNull();
    expect(liveCondition({ temp_c: 70, throttle_mask: 0x20 }, 86)).toEqual({ level: 'warning', text: 'has GPU clocks limited by thermal limit' });
    expect(liveCondition({ temp_c: 70, throttle_mask: 0x24 | 0x40 }, 86)).toEqual({ level: 'critical', text: 'has GPU clocks limited by overheating' });
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
