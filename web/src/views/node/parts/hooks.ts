// Shared node-page hooks: freshness of a node's data and range-level aggregates (peaks, energy, means).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { dataOf, LOADING, settleFor, type Tagged } from '../../../lib/loadable';
import type { TimeRange } from '../../../lib/prefs';
import type { NodeStatus, Sample } from '../../../lib/types';
import { serverNow, useCluster } from '../../../store/cluster';
import { useConnection } from '../../../store/connection';
import { joinHistoryRefresh, historyCache } from '../../../store/history';
import { liveStore, useLatest } from '../../../store/live';
import { usePrefs } from '../../../store/prefs';
import { notLive } from '../../shared/live';

/** In Live mode, range aggregates (peak, energy) cover the most recent samples held in the browser. */
export const LIVE_AGG_S = 900;

const hasSample = (s: Sample | null) => s !== null;

export interface Freshness {
  status: NodeStatus | undefined;
  /** Values on screen are not live: node stale/offline/error, or the browser lost the console. */
  stale: boolean;
  /** At least one sample has arrived since the page loaded. */
  hasData: boolean;
  /** Nothing to show yet, but data is expected soon: render skeletons. */
  waiting: boolean;
}

export function useFreshness(nodeId: string): Freshness {
  const status = useCluster((s) => s.nodes[nodeId]?.status);
  const consoleLive = useConnection((s) => s.status === 'live');
  const hasData = useLatest(nodeId, hasSample);
  const stale = notLive(status, consoleLive);
  return { status, stale, hasData, waiting: !hasData && !stale };
}

export interface RangeData {
  ts: number[];
  series: Record<string, (number | null)[]>;
  /** Per-bucket minima/maxima from history rollups (empty in live mode, where every sample is kept). */
  min: Record<string, (number | null)[]>;
  max: Record<string, (number | null)[]>;
}

/**
 * Aggregatable series for the global time range. Live: copied from the LiveStore every 5 s (not per tick).
 * Fixed ranges: the cached history loader, refreshed about 30 times per range.
 */
export function useRangeData(nodeId: string, keys: readonly string[]): { range: TimeRange; data: RangeData | null; error: boolean } {
  const range = usePrefs((s) => s.timeRange);
  const keysId = keys.join('|');
  const [tagged, setTagged] = useState<Tagged<RangeData>>({ id: '', value: LOADING });
  const id = `${nodeId}|${keysId}|${range}`;

  useEffect(() => {
    const ks = keysId.split('|');
    let cancelled = false;
    const done = (outcome: { data: RangeData } | { error: unknown }) => {
      if (!cancelled) setTagged(settleFor(id, outcome));
    };
    let tick: () => void;
    let stop: () => void;
    if (range === 'live') {
      tick = () => {
        const w = liveStore.window(nodeId, ks, serverNow() - LIVE_AGG_S);
        done({ data: { ts: w.ts, series: Object.fromEntries(ks.map((k, i) => [k, w.values[i] ?? []])), min: {}, max: {} } });
      };
      const t = setInterval(tick, 5_000);
      stop = () => { clearInterval(t); };
    } else {
      tick = () => {
        historyCache
          .load(nodeId, ks, range, serverNow())
          .then((r) => { done({ data: { ts: r.ts, series: r.series, min: r.min, max: r.max } }); })
          .catch((error: unknown) => { done({ error }); });
      };
      stop = joinHistoryRefresh(range, tick);
    }
    tick();
    return () => {
      cancelled = true;
      stop();
    };
  }, [nodeId, keysId, range, id]);

  const value = tagged.id === id ? tagged.value : LOADING;
  return { range, data: dataOf(value), error: value.state === 'error' };
}

const noop = () => () => undefined;

export function useRerenderOnBufferWrite(nodeId: string, enabled: boolean): void {
  const subscribe = useCallback((cb: () => void) => liveStore.subscribeSample(nodeId, cb), [nodeId]);
  const get = () => (enabled ? liveStore.revision(nodeId) : null);
  useSyncExternalStore(enabled ? subscribe : noop, get, get);
}
