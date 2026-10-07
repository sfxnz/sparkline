import type { HistoryResponse } from '../lib/types';
import { HistoryCache } from './history';

const resp = (node: string): HistoryResponse => ({ node_id: node, resolution_s: 10, ts: [1], series: {}, min: {}, max: {} });

describe('HistoryCache', () => {
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
