// Data hooks for the Thermals & Power and Processes tabs.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../../../lib/api';
import type { HistoryResponse } from '../../../lib/types';
import { serverNow, useCluster } from '../../../store/cluster';
import { liveStore, type LiveStore } from '../../../store/live';
import { historyPlusLive, startOfDay } from '../../shared/energy';
import { useNodeStale, type Loadable } from '../../shared/live';

/**
 * A value derived from a node's LiveStore buffers (e.g. min/max over the live window). Recomputed once per
 * sample notification; the component re-renders only when `isEqual` says the derived value changed.
 */
export function useLiveDerived<T>(node: string, compute: (store: LiveStore) => T, isEqual: (a: T, b: T) => boolean, store: LiveStore = liveStore): T {
  const cache = useRef<{ ts: number | null; compute: (s: LiveStore) => T; value: T } | null>(null);
  const subscribe = useCallback((cb: () => void) => store.subscribeSample(node, cb), [store, node]);
  const get = () => {
    const ts = store.lastTs(node);
    const prev = cache.current;
    if (prev && prev.ts === ts && prev.compute === compute) return prev.value;
    const next = compute(store);
    const value = prev && isEqual(prev.value, next) ? prev.value : next;
    cache.current = { ts, compute, value };
    return value;
  };
  return useSyncExternalStore(subscribe, get, get);
}

/** Whether a node's numbers are not live, and the time of its newest data (for "Updated 12 s ago"). */
export function useStaleSince(node: string): { stale: boolean; updatedAt: number | null } {
  const stale = useNodeStale(node);
  const lastSample = useCluster((s) => s.nodes[node]?.last_sample_ts ?? null);
  return { stale, updatedAt: liveStore.lastTs(node) ?? lastSample };
}

export type Span = 'today' | '7d';
const SPAN_REFRESH_MS: Record<Span, number> = { today: 60_000, '7d': 300_000 };
const spanFrom = (span: Span, now: number) => (span === 'today' ? startOfDay(now) : now - 7 * 86400);
/** Shared between the header and the energy panel so one span is fetched once per refresh, not per component. */
const spanCache = new Map<string, { at: number; promise: Promise<HistoryResponse> }>();

function loadSpan(node: string, key: string, span: Span): Promise<HistoryResponse> {
  const id = `${node}|${key}|${span}`;
  const hit = spanCache.get(id);
  if (hit && Date.now() - hit.at < SPAN_REFRESH_MS[span] / 2) return hit.promise;
  const now = serverNow();
  const promise = api.history(node, [key], spanFrom(span, now), now, 600);
  promise.catch(() => spanCache.delete(id));
  spanCache.set(id, { at: Date.now(), promise });
  if (spanCache.size > 32) spanCache.delete(spanCache.keys().next().value ?? '');
  return promise;
}

/** History for one key from local midnight (or 7 days ago) to now, refreshed every minute (5 min for 7 days). */
export function useSpanHistory(node: string, key: string, span: Span): Loadable<HistoryResponse> {
  const [tagged, setTagged] = useState<{ id: string; value: Loadable<HistoryResponse> }>({ id: '', value: { state: 'loading' } });
  const id = `${node}|${key}|${span}`;
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      loadSpan(node, key, span)
        .then((data) => { if (!cancelled) setTagged({ id, value: { state: 'ready', data } }); })
        // Keep showing the last good total if a refresh fails.
        .catch((e: unknown) => { if (!cancelled) setTagged((prev) => (prev.id === id && prev.value.state === 'ready' ? prev : { id, value: { state: 'error', message: e instanceof Error ? e.message : String(e) } })); });
    };
    fetchOnce();
    const t = setInterval(fetchOnce, SPAN_REFRESH_MS[span]);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [node, key, span, id]);
  return tagged.id === id ? tagged.value : { state: 'loading' };
}

/** GPU energy over a span (today / 7 days): the span's history extended with the live readings after it, so it
 *  never trails the live view by a history bucket. Re-renders when the total changes by 0.01 Wh or more. */
export function useSpanEnergy(node: string, key: string, span: Span, store: LiveStore = liveStore): Loadable<number | null> {
  const hist = useSpanHistory(node, key, span);
  const data = hist.state === 'ready' ? hist.data : null;
  const compute = useCallback(
    (st: LiveStore) => (data ? historyPlusLive(data, key, (t) => st.window(node, [key], t).values[0] ?? []) : null),
    [data, node, key],
  );
  const joules = useLiveDerived(node, compute, (a, b) => (a === null ? b === null : b !== null && Math.round(a / 36) === Math.round(b / 36)), store);
  return hist.state === 'ready' ? { state: 'ready', data: joules } : hist;
}
