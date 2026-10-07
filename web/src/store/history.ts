// History loader: /api/v1/live seeds the LiveStore on connect; /api/v1/history serves the fixed ranges.
// Responses are cached per node + keys + range for a range-appropriate time, and the cache is bounded: expired
// entries are dropped on every load (a 24 h per-core response is hundreds of KB, and an expired one is never reused),
// and at most MAX_ENTRIES fresh ones are kept.
import { api } from '../lib/api';
import type { TimeRange } from '../lib/prefs';
import type { HistoryResponse } from '../lib/types';
import { liveStore, type LiveStore } from './live';

export type HistoryRange = Exclude<TimeRange, 'live'>;

export const RANGE_SECONDS: Record<HistoryRange, number> = { '5m': 300, '1h': 3600, '24h': 86400, '7d': 604800 };
/** How long a cached response stays fresh (roughly one bucket of the downsampled series). */
const CACHE_TTL_MS: Record<HistoryRange, number> = { '5m': 5_000, '1h': 30_000, '24h': 300_000, '7d': 900_000 };
const MAX_ENTRIES = 64;

/** How often a view showing a fixed range re-fetches it: about 30 times per range, at most every 10 s. */
export const historyRefreshMs = (range: HistoryRange) => Math.max(10_000, (RANGE_SECONDS[range] / 30) * 1000);

type Fetcher = (node: string, keys: readonly string[], from: number, to: number) => Promise<HistoryResponse>;

export class HistoryCache {
  private readonly entries = new Map<string, { at: number; ttl: number; promise: Promise<HistoryResponse> }>();

  constructor(
    private readonly fetcher: Fetcher = (n, k, f, t) => api.history(n, k, f, t),
    private readonly now: () => number = Date.now,
  ) {}

  load(node: string, keys: readonly string[], range: HistoryRange, serverNow = this.now() / 1000): Promise<HistoryResponse> {
    const id = `${node}|${[...keys].sort().join(',')}|${range}`;
    const now = this.now();
    for (const [k, e] of this.entries) if (now - e.at >= e.ttl) this.entries.delete(k);
    const hit = this.entries.get(id);
    if (hit) return hit.promise;
    const promise = this.fetcher(node, keys, serverNow - RANGE_SECONDS[range], serverNow);
    promise.catch(() => this.entries.delete(id)); // never cache failures
    this.entries.delete(id);
    this.entries.set(id, { at: now, ttl: CACHE_TTL_MS[range], promise });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return promise;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const historyCache = new HistoryCache();

/** Fill each node's ring buffer with the console's recent in-memory history (fast bootstrap after connect). */
export async function seedLive(nodes: readonly string[], store: LiveStore = liveStore, seconds = 900): Promise<void> {
  await Promise.all(
    nodes.map(async (n) => {
      try {
        store.seed(await api.live(n, seconds));
      } catch {
        /* optional: live samples still stream in */
      }
    }),
  );
}
