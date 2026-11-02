import type { HistoryResponse } from '../lib/types';
import { joinHistoryRefresh, HistoryCache } from './history';

const resp = (node: string): HistoryResponse => ({ node_id: node, resolution_s: 10, ts: [1], series: {}, min: {}, max: {} });
const agent = (node: string, keys: readonly string[]): Promise<HistoryResponse> => {
  const per = (v: number) => Object.fromEntries(keys.map((k) => [k, [v]]));
  return Promise.resolve({ node_id: node, resolution_s: 10, ts: [1], series: per(5), min: per(1), max: per(9) });
};

describe('HistoryCache', () => {
  it('sends one request per node and range for the loads made in one task, and gives each caller its keys', async () => {
    const fetcher = vi.fn(agent);
    const c = new HistoryCache(fetcher, () => 0);
    const [a, b, other, longer] = await Promise.all([
      c.load('spark1', ['gpu0.util', 'gpu0.power_w'], '24h', 90_000),
      c.load('spark1', ['gpu0.power_w', 'gpu0.temp_c'], '24h', 90_000),
      c.load('spark2', ['gpu0.util'], '24h', 90_000),
      c.load('spark1', ['gpu0.util'], '7d', 90_000),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledWith('spark1', ['gpu0.util', 'gpu0.power_w', 'gpu0.temp_c'], 90_000 - 86400, 90_000);
    expect(a).toEqual({ node_id: 'spark1', resolution_s: 10, ts: [1], series: { 'gpu0.util': [5], 'gpu0.power_w': [5] }, min: { 'gpu0.util': [1], 'gpu0.power_w': [1] }, max: { 'gpu0.util': [9], 'gpu0.power_w': [9] } });
    expect(Object.keys(b.series).sort()).toEqual(['gpu0.power_w', 'gpu0.temp_c']);
    expect(other.node_id).toBe('spark2');
    expect(Object.keys(longer.series)).toEqual(['gpu0.util']);
  });

  it('serves later loads of keys it already fetched from that request, and fetches only new key sets anew', async () => {
    const fetcher = vi.fn(agent);
    const c = new HistoryCache(fetcher, () => 0);
    await Promise.all([c.load('spark1', ['a', 'b'], '1h'), c.load('spark1', ['c'], '1h')]);
    expect(Object.keys((await c.load('spark1', ['c', 'a'], '1h')).series).sort()).toEqual(['a', 'c']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Object.keys((await c.load('spark1', ['a', 'd'], '1h')).series).sort()).toEqual(['a', 'd']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith('spark1', ['a', 'd'], expect.any(Number), expect.any(Number));
  });

  it('fails every load that shared a failed request, and retries it on the next load', async () => {
    const fetcher = vi.fn(agent).mockRejectedValueOnce(new Error('boom'));
    const c = new HistoryCache(fetcher, () => 0);
    const both = [c.load('spark1', ['a'], '5m'), c.load('spark1', ['b'], '5m')];
    await expect(both[0]).rejects.toThrow('boom');
    await expect(both[1]).rejects.toThrow('boom');
    await expect(c.load('spark1', ['a'], '5m')).resolves.toMatchObject({ series: { a: [5] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches per node + keys (order-insensitive) + range, for the range TTL', async () => {
    let t = 0;
    const fetcher = vi.fn((n: string) => Promise.resolve(resp(n)));
    const c = new HistoryCache(fetcher, () => t);
    await c.load('spark1', ['b', 'a'], '1h', 5000);
    await c.load('spark1', ['a', 'b'], '1h', 5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('spark1', ['b', 'a'], 5000 - 3600, 5000);
    await c.load('spark2', ['a', 'b'], '1h');
    await c.load('spark1', ['a', 'b'], '24h');
    expect(fetcher).toHaveBeenCalledTimes(3);
    t = 31_000; // 1h TTL is 30 s
    await c.load('spark1', ['a', 'b'], '1h');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not cache failures', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(resp('spark1'));
    const c = new HistoryCache(fetcher, () => 0);
    await expect(c.load('spark1', ['a'], '5m')).rejects.toThrow('boom');
    await expect(c.load('spark1', ['a'], '5m')).resolves.toMatchObject({ node_id: 'spark1' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is bounded', async () => {
    const c = new HistoryCache((n) => Promise.resolve(resp(n)), () => 0);
    for (let i = 0; i < 200; i++) await c.load(`n${i}`, ['a'], '7d');
    expect(c.size).toBeLessThanOrEqual(64);
  });

  it('drops expired responses instead of holding them until evicted', async () => {
    let t = 0;
    const c = new HistoryCache((n) => Promise.resolve(resp(n)), () => t);
    for (let i = 0; i < 10; i++) await c.load(`n${i}`, ['a'], '1h');
    await c.load('n0', ['a'], '24h');
    expect(c.size).toBe(11);
    t = 31_000; // past the 1 h TTL (30 s), within the 24 h one (5 min)
    await c.load('n1', ['a'], '5m');
    expect(c.size).toBe(2);
  });
});

describe('joinHistoryRefresh', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('refreshes every view showing a range in one task, so their loads share one request', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(agent);
    const c = new HistoryCache(fetcher, () => Date.now());
    const stopA = joinHistoryRefresh('5m', () => void c.load('spark1', ['a'], '5m'));
    vi.advanceTimersByTime(3_000);
    const stopB = joinHistoryRefresh('5m', () => void c.load('spark1', ['b'], '5m'));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('spark1', ['a', 'b'], expect.any(Number), expect.any(Number));
    stopA();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenLastCalledWith('spark1', ['b'], expect.any(Number), expect.any(Number));
    stopB();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps one timer per range when a view stops twice across a restart of that range', () => {
    vi.useFakeTimers();
    const stopA = joinHistoryRefresh('1h', () => undefined);
    stopA();
    const stopB = joinHistoryRefresh('1h', () => undefined);
    stopA();
    const stopC = joinHistoryRefresh('1h', () => undefined);
    expect(vi.getTimerCount()).toBe(1);
    stopB();
    stopC();
    expect(vi.getTimerCount()).toBe(0);
  });
});
