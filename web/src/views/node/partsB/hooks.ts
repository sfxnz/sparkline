// Small live-data hooks for the CPU, Network and Storage tabs. Each returns a primitive (or a stable object) so a
// component re-renders only when its own value changes, never on every tick.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../../../lib/api';
import type { TimeRange } from '../../../lib/prefs';
import type { AlertRule, NodeInfo } from '../../../lib/types';
import { serverNow, useCluster } from '../../../store/cluster';
import { liveStore, type LiveStore } from '../../../store/live';
import { lastKnown, useRangeHistory } from '../../shared/live';
import { counterTotal } from './net';

export function useNodeInfo(node: string): NodeInfo | null {
  return useCluster((s) => s.nodes[node]?.info ?? null);
}

/** Whether the browser holds any data for this node: a live sample or seeded history (skeleton vs content). An
 *  offline node opened fresh still has its last minutes seeded from the console, shown dimmed. */
export function useHasData(node: string, store: LiveStore = liveStore): boolean {
  // The snapshot is the boolean itself: a snapshot of the timestamp would re-render the whole tab on every sample.
  const sub = useCallback((cb: () => void) => store.subscribeSample(node, cb), [store, node]);
  const get = () => store.lastTs(node) !== null;
  return useSyncExternalStore(sub, get, get);
}

export type KeyGetter = (key: string) => number | null;

/**
 * A number derived from last known values of flattened keys (see lastKnown). Works for live samples, for seeded
 * history of a node that is offline, and while one collector fails. Re-renders only when the result changes.
 */
export function useDerived<T extends number | string | boolean | null>(node: string, derive: (get: KeyGetter) => T, store: LiveStore = liveStore): T {
  const sub = useCallback((cb: () => void) => store.subscribeSample(node, cb), [store, node]);
  const get = () => derive((key) => lastKnown(store, node, key)?.value ?? null);
  return useSyncExternalStore(sub, get, get);
}

/** Last known value of a flattened key, optionally rounded to `step` (fewer re-renders for coarse displays). */
export function useLastKnown(node: string, key: string, step = 0, store: LiveStore = liveStore): number | null {
  return useDerived(node, (get) => {
    const v = get(key);
    return v === null || !step ? v : Math.round(v / step) * step;
  }, store);
}

/** Window used for counters in Live mode (the console seeds 15 min of history into the ring). */
export const LIVE_COUNTER_WINDOW_S = 900;

/**
 * Totals of per-interval counters (e.g. net.X.errors) over the selected time range: the ring buffer in Live mode,
 * downsampled history otherwise. Returns null per key until known.
 */
export function useCounterTotals(node: string, keys: readonly string[], range: TimeRange, store: LiveStore = liveStore): { totals: (number | null)[]; oldest: number | null } {
  const keysId = keys.join('|');
  const sub = useCallback((cb: () => void) => (range === 'live' ? store.subscribeSample(node, cb) : () => undefined), [store, node, range]);
  // Live: a string snapshot, so the component re-renders only when a total changes.
  const liveSnap = () => {
    if (range !== 'live') return '';
    const ks = keysId.split('|');
    const w = store.window(node, ks, serverNow() - LIVE_COUNTER_WINDOW_S);
    if (!w.ts.length) return '';
    // The oldest tick rides along (to the minute) so the wording can say how much time the totals cover.
    return `${Math.floor((w.ts[0] ?? 0) / 60) * 60}|${w.values.map((vs) => counterTotal(vs)).join('|')}`;
  };
  const live = useSyncExternalStore(sub, liveSnap, liveSnap);

  const hist = useRangeHistory(node, keys, range === 'live' ? null : range);

  if (range === 'live') {
    if (!live) return { totals: keys.map(() => null), oldest: null };
    const [oldest, ...totals] = live.split('|').map(Number);
    return { totals, oldest: oldest ?? null };
  }
  if (hist.state !== 'ready') return { totals: keys.map(() => null), oldest: null };
  return { totals: keys.map((k) => { const v = hist.data.series[k]; return v ? counterTotal(v) : null; }), oldest: hist.data.ts[0] ?? null };
}

// ---------------------------------------------------------------- alert rules (read-only, shared)

let rulesCache: { at: number; promise: Promise<AlertRule[]> } | null = null;
const RULES_TTL_MS = 30_000;

/** The console's alert rules, fetched once per 30 s across components. null while loading or unavailable. */
export function useAlertRules(): AlertRule[] | null | 'error' {
  const [rules, setRules] = useState<AlertRule[] | null | 'error'>(null);
  useEffect(() => {
    let cancelled = false;
    if (!rulesCache || Date.now() - rulesCache.at > RULES_TTL_MS) {
      const promise = api.rules();
      promise.catch(() => { rulesCache = null; });
      rulesCache = { at: Date.now(), promise };
    }
    rulesCache.promise.then((r) => { if (!cancelled) setRules(r); }).catch(() => { if (!cancelled) setRules('error'); });
    return () => { cancelled = true; };
  }, []);
  return rules;
}
