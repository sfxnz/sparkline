import { act, renderHook, waitFor } from '@testing-library/react';
import { api } from '../../lib/api';
import { historyCache, historyRefreshMs } from '../../store/history';
import { LiveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import { useRangeData } from '../node/parts/hooks';
import { useSpanHistory } from '../node/partsC/hooks';
import { useEnergyToday } from '../overview/hooks';
import { lastKnown, lastKnownValue, notLive, spanPhrase, useRangeHistory } from './live';

describe('notLive', () => {
  it('is true for stale/offline/error nodes and whenever the console is lost', () => {
    expect(notLive('online', true)).toBe(false);
    expect(notLive('connecting', true)).toBe(false);
    expect(notLive('stale', true)).toBe(true);
    expect(notLive('offline', true)).toBe(true);
    expect(notLive('error', true)).toBe(true);
    expect(notLive('online', false)).toBe(true);
  });
});

describe('lastKnown', () => {
  it('returns the newest value of a key even after it stops being reported', () => {
    const store = new LiveStore(16, () => undefined);
    store.seed({ node_id: 'n', resolution_s: 1, ts: [1, 2, 3, 4], series: { 'disk.x.busy_pct': [10, 12, null, null], other: [1, 1, 1, 1] }, min: {}, max: {} });
    expect(lastKnown(store, 'n', 'disk.x.busy_pct')).toEqual({ value: 12, ts: 2 });
    expect(lastKnown(store, 'n', 'disk.x.busy_pct', 2)).toBeNull(); // only looks this far back
    expect(lastKnown(store, 'n', 'missing')).toBeNull();
    expect(lastKnown(store, 'nope', 'disk.x.busy_pct')).toBeNull();
  });

  it('lastKnownValue looks back past trailing gaps and sums several keys', () => {
    const store = new LiveStore(16, () => undefined);
    store.seed({ node_id: 'n', resolution_s: 1, ts: [1, 2, 3, 4], series: { 'net.a.rx_bps': [10, 20, null, null], 'net.b.rx_bps': [1, 2, 3, null] }, min: {}, max: {} });
    expect(lastKnownValue('n', 'net.a.rx_bps', store)).toBe(20);
    expect(lastKnownValue('n', ['net.a.rx_bps', 'net.b.rx_bps'], store)).toBe(23);
    expect(lastKnownValue('n', ['net.a.rx_bps', 'missing'], store)).toBeNull();
    expect(lastKnownValue('nope', 'net.a.rx_bps', store)).toBeNull();
  });
});

describe('spanPhrase', () => {
  const now = 1_800_000_000;
  it('uses the range wording when the data covers the range', () => {
    expect(spanPhrase('live', now - 900, now)).toBe('last 15 min');
    expect(spanPhrase('5m', now - 290, now)).toBe('last 5 min');
    expect(spanPhrase('1h', null, now)).toBe('last hour');
  });
  it('says the real span when the data is shorter (a console or agent that just started)', () => {
    expect(spanPhrase('live', now - 155, now)).toBe('last 3 min');
    expect(spanPhrase('5m', now - 88, now)).toBe('last 1 min');
    expect(spanPhrase('24h', now - 2 * 3600, now)).toMatch(/^since \d\d:\d\d$/);
  });
});

describe('energy since midnight', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('is fetched once for the Overview total and the Thermals tab', async () => {
    const history = vi.spyOn(api, 'history').mockResolvedValue({ node_id: 'spark1', resolution_s: 60, ts: [1], series: { 'gpu0.energy_j': [1] }, min: {}, max: {} });
    renderHook(() => useEnergyToday(['spark1']));
    const thermals = renderHook(() => useSpanHistory('spark1', 'gpu0.energy_j', 'today'));
    await waitFor(() => { expect(thermals.result.current.state).toBe('ready'); });
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('is fetched anew after the history is cleared', async () => {
    const before = { node_id: 'spark2', resolution_s: 60, ts: [1], series: { 'gpu0.energy_j': [5] }, min: {}, max: {} };
    const after = { node_id: 'spark2', resolution_s: 60, ts: [], series: {}, min: {}, max: {} };
    const history = vi.spyOn(api, 'history').mockResolvedValueOnce(before).mockResolvedValue(after);
    renderHook(() => useEnergyToday(['spark2']));
    await waitFor(() => { expect(history).toHaveBeenCalledTimes(1); });
    historyCache.clear();
    const thermals = renderHook(() => useSpanHistory('spark2', 'gpu0.energy_j', 'today'));
    await waitFor(() => { expect(thermals.result.current.state).toBe('ready'); });
    expect(thermals.result.current).toEqual({ state: 'ready', data: after });
  });
});

describe('range figures whose refresh fails', () => {
  const resp = (node: string, v: number) => ({ node_id: node, resolution_s: 60, ts: [1, 2], series: { 'gpu0.energy_j': [v, v + 10] }, min: {}, max: {} });
  const refresh = async () => {
    historyCache.clear(); // the cached response has expired by the next refresh
    await act(async () => { await vi.advanceTimersByTimeAsync(historyRefreshMs('24h')); });
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    historyCache.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    usePrefs.setState({ timeRange: 'live' });
  });

  it('keep the last good history, marked as not refreshed, until a refresh succeeds', async () => {
    vi.spyOn(api, 'history').mockResolvedValueOnce(resp('r1', 5)).mockRejectedValueOnce(new Error('timed out')).mockResolvedValueOnce(resp('r1', 7));
    const hist = renderHook(() => useRangeHistory('r1', ['gpu0.energy_j'], '24h'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hist.result.current).toEqual({ state: 'ready', data: resp('r1', 5) });
    await refresh();
    expect(hist.result.current).toMatchObject({ state: 'refresh-failed', data: resp('r1', 5) });
    await refresh();
    expect(hist.result.current).toEqual({ state: 'ready', data: resp('r1', 7) });
  });

  it('keep the GPU tab range total instead of "unavailable"', async () => {
    usePrefs.setState({ timeRange: '24h' });
    vi.spyOn(api, 'history').mockResolvedValueOnce(resp('r2', 5)).mockRejectedValueOnce(new Error('timed out'));
    const range = renderHook(() => useRangeData('r2', ['gpu0.energy_j']));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(range.result.current.data?.series['gpu0.energy_j']).toEqual([5, 15]);
    await refresh();
    expect(range.result.current.error).toBe(false);
    expect(range.result.current.data?.series['gpu0.energy_j']).toEqual([5, 15]);
  });
});
