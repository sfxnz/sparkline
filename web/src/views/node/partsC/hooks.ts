// Data hooks for the Thermals & Power and Processes tabs.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HistoryResponse } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { liveStore, type LiveStore } from '../../../store/live';
import { sumCounters } from '../../shared/energy';
import { loadSpan, SPAN_REFRESH_MS, useNodeStale, type Loadable, type Span } from '../../shared/live';

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

const keyList = (key: string | readonly string[]) => (typeof key === 'string' ? [key] : key);

/** History for one key or several from local midnight (or 7 days ago) to now, refreshed every minute (5 min for
 *  7 days). */
export function useSpanHistory(node: string, key: string | readonly string[], span: Span): Loadable<HistoryResponse> {
  const [tagged, setTagged] = useState<{ id: string; value: Loadable<HistoryResponse> }>({ id: '', value: { state: 'loading' } });
  const keysId = keyList(key).join('|');
  const id = `${node}|${keysId}|${span}`;
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      loadSpan(node, keysId.split('|'), span)
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
  }, [node, keysId, span, id]);
  return tagged.id === id ? tagged.value : { state: 'loading' };
}

/** GPU energy over a span (today / 7 days), summed over the counters in `key`: the span's history extended with the
 *  live readings after it, so it never trails the live view by a history bucket. Re-renders when the total changes
 *  by 0.01 Wh or more. */
export function useSpanEnergy(node: string, key: string | readonly string[], span: Span, store: LiveStore = liveStore): Loadable<number | null> {
  const hist = useSpanHistory(node, key, span);
  const data = hist.state === 'ready' ? hist.data : null;
  const keysId = keyList(key).join('|');
  const compute = useCallback(
    (st: LiveStore) => (data ? sumCounters(data, keysId.split('|'), (k, t) => st.window(node, [k], t).values[0] ?? []) : null),
    [data, node, keysId],
  );
  const joules = useLiveDerived(node, compute, (a, b) => (a === null ? b === null : b !== null && Math.round(a / 36) === Math.round(b / 36)), store);
  return hist.state === 'ready' ? { state: 'ready', data: joules } : hist;
}
