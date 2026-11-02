// History loader: /api/v1/live seeds the LiveStore on connect; /api/v1/history serves the fixed ranges.
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
const historyRefreshMs = (range: HistoryRange) => Math.max(10_000, (RANGE_SECONDS[range] / 30) * 1000);

const tickers = new Map<HistoryRange, { timer: ReturnType<typeof setInterval>; views: Set<() => void> }>();

export function joinHistoryRefresh(range: HistoryRange, refresh: () => void): () => void {
  let ticker = tickers.get(range);
  if (!ticker) {
    const views = new Set<() => void>();
    ticker = { views, timer: setInterval(() => { views.forEach((f) => { f(); }); }, historyRefreshMs(range)) };
    tickers.set(range, ticker);
  }
  const { views, timer } = ticker;
  views.add(refresh);
  return () => {
    views.delete(refresh);
    if (views.size) return;
    clearInterval(timer);
    if (tickers.get(range) === ticker) tickers.delete(range);
  };
}

type Fetcher = (node: string, keys: readonly string[], from: number, to: number) => Promise<HistoryResponse>;

interface HistoryRequest {
  node: string;
  range: HistoryRange;
  keys: Set<string>;
  sent: boolean;
  at: number;
  response: Promise<HistoryResponse>;
}

function only<T>(byKey: Record<string, T>, keys: readonly string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of keys) {
    const v = byKey[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export class HistoryCache {
  private requests: HistoryRequest[] = [];
  /** loadSpan's responses (views/shared/live.ts), held here so clear() drops them too. */
  readonly spans = new Map<string, { at: number; promise: Promise<HistoryResponse> }>();

  constructor(
    private readonly fetcher: Fetcher = (n, k, f, t) => api.history(n, k, f, t),
    private readonly now: () => number = Date.now,
  ) {}

  load(node: string, keys: readonly string[], range: HistoryRange, serverNow = this.now() / 1000): Promise<HistoryResponse> {
    const now = this.now();
    this.requests = this.requests.filter((r) => now - r.at < CACHE_TTL_MS[r.range]);
    const req =
      this.requests.find((r) => r.node === node && r.range === range && (!r.sent || keys.every((k) => r.keys.has(k)))) ??
      this.openUntilNextMicrotask(node, range, serverNow, now);
    for (const k of keys) req.keys.add(k);
    return req.response.then((r) => ({ ...r, series: only(r.series, keys), min: only(r.min, keys), max: only(r.max, keys) }));
  }

  private openUntilNextMicrotask(node: string, range: HistoryRange, serverNow: number, now: number): HistoryRequest {
    const req: HistoryRequest = {
      node,
      range,
      keys: new Set(),
      sent: false,
      at: now,
      response: new Promise((resolve) => {
        queueMicrotask(() => {
          req.sent = true;
          resolve(this.fetcher(node, [...req.keys], serverNow - RANGE_SECONDS[range], serverNow));
        });
      }),
    };
    req.response.catch(() => { this.requests = this.requests.filter((r) => r !== req); });
    this.requests.push(req);
    if (this.requests.length > MAX_ENTRIES) this.requests.shift();
    return req;
  }

  get size(): number {
    return this.requests.length;
  }

  clear(): void {
    this.requests = [];
    this.spans.clear();
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
