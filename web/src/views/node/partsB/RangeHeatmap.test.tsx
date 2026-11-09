import { act, render, screen } from '@testing-library/react';
import { api } from '../../../lib/api';
import type { CoreInfo } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { historyCache, historyRefreshMs } from '../../../store/history';
import { usePrefs } from '../../../store/prefs';
import { RangeHeatmap } from './RangeHeatmap';

const NODE = 'hmtest';
const now = 1_800_000_000;
const cores: CoreInfo[] = [0, 1].map((id) => ({ id, kind: 'performance', model: null, max_mhz: null, cluster: null }));
const resp = { node_id: NODE, resolution_s: 60, ts: [now - 120, now - 60], series: { 'cpu.core0.util': [10, 20], 'cpu.core1.util': [30, 40] }, min: {}, max: {} };

describe('RangeHeatmap on a history range', () => {
  beforeAll(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
  afterAll(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    historyCache.clear();
    usePrefs.setState({ timeRange: '24h' });
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { node_id: NODE, url: '', status: 'online', since: 0, last_sample_ts: null, error: null, info: null, next_retry_ts: null } } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    usePrefs.setState({ timeRange: 'live' });
  });

  it('keeps the loaded heatmap with a quiet note when a refresh fails, until a refresh succeeds', async () => {
    vi.spyOn(api, 'history').mockResolvedValueOnce(resp).mockRejectedValueOnce(new Error('timed out')).mockResolvedValueOnce(resp);
    render(<RangeHeatmap node={NODE} cores={cores} cpuModel="" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('img')).toBeInTheDocument();

    historyCache.clear();
    await act(async () => { await vi.advanceTimersByTimeAsync(historyRefreshMs('24h')); });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Couldn’t refresh/ })).toBeInTheDocument();

    historyCache.clear();
    await act(async () => { await vi.advanceTimersByTimeAsync(historyRefreshMs('24h')); });
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Couldn’t refresh/ })).toBeNull();
  });

  it('offers Retry when the first load fails', async () => {
    vi.spyOn(api, 'history').mockRejectedValue(new Error('timed out'));
    render(<RangeHeatmap node={NODE} cores={cores} cpuModel="" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
