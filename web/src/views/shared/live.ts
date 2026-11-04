// Freshness and history helpers shared by the Overview, the node tabs and Wall mode, so every screen agrees on
// when values are "not live", what the last known value is, and how a range is worded and refreshed.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { LOADING, settleFor, type Loadable, type Tagged } from '../../lib/loadable';
import type { TimeRange } from '../../lib/prefs';
import type { HistoryResponse, NodeStatus } from '../../lib/types';
import { serverNow, useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { joinHistoryRefresh, historyCache, type HistoryRange } from '../../store/history';
import { liveStore, type LiveStore } from '../../store/live';
import { startOfDay } from './energy';

/** Values on screen are not live: the node is stale/offline/errored, or the browser lost the console. */
export const notLive = (status: NodeStatus | undefined, consoleLive: boolean): boolean =>
  !consoleLive || status === 'stale' || status === 'offline' || status === 'error';

/** True while a node's values are not live (see notLive). */
export function useNodeStale(node: string): boolean {
  const status = useCluster((s) => s.nodes[node]?.status);
  const consoleLive = useConnection((s) => s.status === 'live');
  return notLive(status, consoleLive);
}

/**
 * Newest non-missing value of a flattened key and its timestamp, searching back through the ring buffer. The newest
 * ticks can be gaps (a node going quiet, one collector failing), so this looks back past them.
 */
export function lastKnown(store: LiveStore, node: string, key: string, maxBack = Infinity): { value: number; ts: number } | null {
  const b = store.buffer(node);
  const ring = b?.values.get(key);
  if (!b || !ring) return null;
  for (let n = b.length - 1; n >= 0 && n >= b.length - maxBack; n--) {
    const i = b.index(n);
    const v = ring[i];
    if (v !== undefined && !Number.isNaN(v)) return { value: v, ts: b.ts[i] ?? 0 };
  }
  return null;
}

/** Last known value of one key, or the sum over several (null if any of them has none). */
export function lastKnownValue(node: string, metric: string | readonly string[], store: LiveStore = liveStore): number | null {
  const keys = typeof metric === 'string' ? [metric] : metric;
  if (!keys.length) return null;
  let total = 0;
  for (const k of keys) {
    const v = lastKnown(store, node, k)?.value;
    if (v === undefined) return null;
    total += v;
  }
  return total;
}

/** How a range is worded next to a figure that covers it ("Peak 41 W · last hour"). In Live mode, range figures
 *  cover the 15 minutes the console seeds into the browser. */
export const RANGE_PHRASE: Record<TimeRange, string> = {
  live: 'last 15 min',
  '5m': 'last 5 min',
  '1h': 'last hour',
  '24h': 'last 24 h',
  '7d': 'last 7 days',
};

/** The span each range's figures are meant to cover (Live: the 15 minutes seeded into the browser). */
export const RANGE_WINDOW_S: Record<TimeRange, number> = { live: 900, '5m': 300, '1h': 3600, '24h': 86400, '7d': 604800 };

/**
 * How a range figure is worded from the data actually held: RANGE_PHRASE when the data covers (90% of) the range,
 * else the real span ("last 3 min", "since 09:12"), so a peak over 3 minutes of data never claims 15.
 */
export function spanPhrase(range: TimeRange, oldestTs: number | null | undefined, now: number): string {
  if (oldestTs == null || !Number.isFinite(oldestTs)) return RANGE_PHRASE[range];
  const span = Math.max(0, now - oldestTs);
  if (span >= 0.9 * RANGE_WINDOW_S[range]) return RANGE_PHRASE[range];
  if (span < 3600) return `last ${Math.max(1, Math.round(span / 60))} min`;
  const d = new Date(oldestTs * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date(now * 1000).toDateString() ? `since ${hm}` : `since ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${hm}`;
}

export type Span = 'today' | '7d';
export const SPAN_REFRESH_MS: Record<Span, number> = { today: 60_000, '7d': 300_000 };
const spanFrom = (span: Span, now: number) => (span === 'today' ? startOfDay(now) : now - 7 * 86400);
const spanCache = historyCache.spans;

export function loadSpan(node: string, keys: readonly string[], span: Span): Promise<HistoryResponse> {
  const id = `${node}|${keys.join('|')}|${span}`;
  const hit = spanCache.get(id);
  if (hit && Date.now() - hit.at < SPAN_REFRESH_MS[span] / 2) return hit.promise;
  const now = serverNow();
  const promise = api.history(node, [...keys], spanFrom(span, now), now, 600);
  promise.catch(() => spanCache.delete(id));
  spanCache.set(id, { at: Date.now(), promise });
  if (spanCache.size > 32) spanCache.delete(spanCache.keys().next().value ?? '');
  return promise;
}

/** History for `keys` over a fixed range (the cache the charts share), refreshed as often as the charts refresh.
 *  `range` null = not needed (e.g. Live mode): stays 'loading' and fetches nothing. */
export function useRangeHistory(node: string, keys: readonly string[], range: HistoryRange | null): Loadable<HistoryResponse> {
  const keysId = keys.join('|');
  const id = `${node}|${keysId}|${range ?? ''}`;
  const [tagged, setTagged] = useState<Tagged<HistoryResponse>>({ id: '', value: LOADING });
  useEffect(() => {
    if (!range || !keysId) return;
    let cancelled = false;
    const list = keysId.split('|');
    const fetchOnce = () => {
      historyCache
        .load(node, list, range, serverNow())
        .then((data) => { if (!cancelled) setTagged(settleFor(id, { data })); })
        .catch((error: unknown) => { if (!cancelled) setTagged(settleFor(id, { error })); });
    };
    fetchOnce();
    const stop = joinHistoryRefresh(range, fetchOnce);
    return () => {
      cancelled = true;
      stop();
    };
  }, [node, keysId, range, id]);
  return tagged.id === id ? tagged.value : LOADING;
}
