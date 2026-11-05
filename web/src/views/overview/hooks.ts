// Overview data hooks. Live values are read from the LiveStore's flattened rings (which also hold the history seeded
// on connect), so an offline node still shows its last known values after a reload. Each hook re-renders only its
// own leaf, and only when its (quantised) value changes.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { gapAcross, type NotReported } from '../../lib/capabilities';
import { gpuCountText, gpuSetGap, nodeGpuKey, nodeTotalGap, totalFrom } from '../../lib/gpu';
import type { HistoryResponse, NodeInfo, NodeState, NodeStatus } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import { energyKeys, sumCounters } from '../shared/energy';
import { loadSpan } from '../shared/live';
import { useShallow } from 'zustand/react/shallow';
import { useLiveConditions } from '../../store/attention';
import { openAlerts, useEvents } from '../../store/events';
import { breathLevel, clusterHealth, clusterTotals, openAlertCounts, type Health, type NodeNumbers } from './model';

const quantise = (v: number | null, q: number | undefined) => (v === null || !q ? v : Math.round(v / q) * q);

/** Latest value of one flattened metric key, optionally rounded to `quantum` (fewer renders for jittery values). */
export function useLiveValue(node: string, key: string, quantum?: number): number | null {
  const subscribe = useCallback((cb: () => void) => liveStore.subscribe(node, key, cb), [node, key]);
  const get = () => quantise(liveStore.latestValue(node, key), quantum);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * A value derived from several nodes' live data. `compute` runs at most once per store notification (and when
 * `depsKey` changes); the previous result is kept while `isEqual` says nothing visible changed.
 */
export function useAcross<T>(ids: readonly string[], compute: () => T, isEqual: (a: T, b: T) => boolean, depsKey = ''): T {
  const version = useRef(0);
  const cache = useRef<{ v: number; key: string; value: T } | null>(null);
  const idsKey = ids.join('\u0000');
  const subscribe = useCallback(
    (cb: () => void) => {
      const offs = idsKey
        .split('\u0000')
        .filter(Boolean)
        .map((id) =>
          liveStore.subscribeSample(id, () => {
            version.current++;
            cb();
          }),
        );
      return () => { offs.forEach((off) => { off(); }); };
    },
    [idsKey],
  );
  const key = `${idsKey}|${depsKey}`;
  const get = () => {
    const c = cache.current;
    if (c?.v === version.current && c.key === key) return c.value;
    const next = compute();
    const value = c && isEqual(c.value, next) ? c.value : next;
    cache.current = { v: version.current, key, value };
    return value;
  };
  return useSyncExternalStore(subscribe, get, get);
}

/** Shallow equality for plain objects of primitives. */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  const ka = Object.keys(a) as (keyof T)[];
  return ka.length === Object.keys(b).length && ka.every((k) => Object.is(a[k], b[k]));
}

export interface ClusterGpuNow {
  util: number | null;
  power: number | null;
  /** Nodes left out of `power` because `nodeTotalGap` explains their missing power, one per line. */
  dropped: string;
  utilFrom: string;
  /** How many of the nodes `util` averages. */
  utilNodes: number;
  /** Why there is no `util` or no `power` (gapAcross over the nodes' gaps), while no node has one. */
  utilGap: NotReported | null;
  powerGap: NotReported | null;
}

/** "4 of 5 GPUs": the GPUs the nodes' utilisation totals read, out of every GPU the nodes list, while any of them is
 *  missing (a node reads only some of its GPUs, or has no utilisation at all); '' when every GPU is read. */
export function utilGpusRead(ids: readonly string[], nodes: Readonly<Record<string, NodeState | undefined>>): string {
  let from = 0;
  let of = 0;
  for (const id of ids) {
    const info = nodes[id]?.info;
    const listed = info?.gpus.length ?? 0;
    const read = liveStore.latestValue(id, nodeGpuKey(info, 'util')) !== null;
    from += read ? (totalFrom(info, liveStore.latest(id), 'util')?.from ?? listed) : 0;
    of += listed;
  }
  return from < of ? gpuCountText({ from, of }) : '';
}

/** The node's GPU utilisation and how many GPUs it is the mean of. */
export function nodeUtil(id: string, info: NodeInfo | null | undefined): Pick<NodeNumbers, 'util' | 'utilGpus'> {
  return {
    util: liveStore.latestValue(id, nodeGpuKey(info, 'util')),
    utilGpus: totalFrom(info, liveStore.latest(id), 'util')?.from ?? Math.max(1, info?.gpus.length ?? 0),
  };
}

/** The live nodes' GPU load and power from each node's totals: utilisation averaged over GPUs, and summed power. */
export function clusterGpuNow(ids: readonly string[], nodes: Readonly<Record<string, NodeState | undefined>>): ClusterGpuNow {
  const utilGaps: [string, NotReported][] = [];
  const powerGaps: [string, NotReported][] = [];
  const numbers = ids.map((id) => {
    const info = nodes[id]?.info;
    const util = nodeUtil(id, info);
    const power = liveStore.latestValue(id, nodeGpuKey(info, 'power_w'));
    const utilGap = util.util === null ? nodeTotalGap(info, liveStore.latest(id), 'util') : null;
    const powerGap = power === null ? nodeTotalGap(info, liveStore.latest(id), 'power_w') : null;
    if (utilGap) utilGaps.push([id, utilGap]);
    if (powerGap) powerGaps.push([id, powerGap]);
    return { ...util, power, memUsed: null, memTotal: null, psi: null };
  });
  const t = clusterTotals(numbers);
  return {
    util: t.util,
    power: t.power,
    dropped: powerGaps.map(([id]) => id).join('\n'),
    utilFrom: utilGpusRead(ids, nodes),
    utilNodes: numbers.filter((n) => n.util !== null).length,
    utilGap: t.util === null ? gapAcross(utilGaps) : null,
    powerGap: t.power === null ? gapAcross(powerGaps) : null,
  };
}

/** True once the browser holds any sample for the node (live or seeded). */
export function useHasData(node: string): boolean {
  return useAcross([node], () => liveStore.lastTs(node) !== null, Object.is);
}

export type Freshness = 'live' | 'waiting' | 'stale' | 'down';

/** live: current data; waiting: nothing yet but expected (skeletons); stale: not live, last values shown dimmed;
 *  down: offline/error (last values dimmed, if any). */
export function useFreshness(node: string): { freshness: Freshness; status: NodeStatus | undefined } {
  const status = useCluster((s) => s.nodes[node]?.status);
  const consoleLive = useConnection((s) => s.status === 'live');
  const hasData = useHasData(node);
  let freshness: Freshness;
  if (status === 'offline' || status === 'error') freshness = 'down';
  else if (!hasData) freshness = 'waiting';
  else if (!consoleLive || status === 'stale') freshness = 'stale';
  else freshness = status === 'online' ? 'live' : 'stale';
  return { freshness, status };
}

/** Ids of the nodes whose data is current (online, and the browser is connected to the console). */
export function useOnlineIds(): string[] {
  const order = useCluster((s) => s.order);
  const nodes = useCluster((s) => s.nodes);
  const consoleLive = useConnection((s) => s.status === 'live');
  const key = consoleLive ? order.filter((id) => nodes[id]?.status === 'online').join('\u0000') : '';
  // Stable array identity while the membership is unchanged.
  return useMemo(() => (key ? key.split('\u0000') : []), [key]);
}

/** The cluster sentence and pill (Overview hero, Wall): node states, live GPU flags and open alerts. */
export function useClusterHealth(): Health {
  const order = useCluster((s) => s.order);
  const nodes = useCluster((s) => s.nodes);
  const consoleLive = useConnection((s) => s.status === 'live');
  const notLiveIds = order.filter((id) => nodes[id]?.status !== 'online');
  const alerts = useEvents(useShallow((s) => openAlertCounts(s.events, notLiveIds)));
  const open = useEvents(useShallow((s) => openAlerts(s.events)));
  const conditions = useLiveConditions(order);
  return clusterHealth(
    order.map((id) => ({ id, status: nodes[id]?.status, conditions: conditions[id] ?? null, alerts: open.filter((e) => e.node_id === id) })),
    alerts,
    consoleLive,
  );
}

// ------------------------------------------------------------------------------------------------ energy today

const ENERGY_REFRESH_MS = 60_000;

export interface EnergyToday {
  joules: number | null;
  /** Nodes whose history never loaded (left out of the total). */
  missing: string[];
  /** Nodes whose history since midnight loaded but holds no energy reading (left out of the total). */
  empty: string[];
  /** Nodes counted up to their last reading because they are not reporting now: id -> time of that reading. */
  until: Record<string, number>;
  loading: boolean;
}

/**
 * GPU (rail) energy since local midnight, summed over `ids` and each node's GPUs, computed exactly as the Thermals
 * tab does (sumCounters): the counters' history since midnight, refreshed every minute, extended with the live
 * readings. A node that stops reporting keeps its last good history, so the day's total never goes down; it counts
 * up to its last reading and is listed in `until`. Only a node whose history never loaded is left out (`missing`), a
 * node whose history holds no energy reading (`empty`), and a node with a GPU that has no energy counter (a partial
 * sum would understate).
 */
export function useEnergyToday(ids: readonly string[]): EnergyToday {
  const nodes = useCluster((s) => s.nodes);
  const keysOf = (id: string) => energyKeys(nodes[id]?.info);
  const idsKey = ids.map((id) => `${id}\u0001${keysOf(id).join('\u0001')}`).join('\u0000');
  // Per node: undefined = not loaded yet, null = history unavailable and nothing loaded before.
  const [bases, setBases] = useState<{ key: string; at: number; data: Record<string, HistoryResponse | null | undefined> }>({ key: '', at: 0, data: {} });

  useEffect(() => {
    const list = (idsKey ? idsKey.split('\u0000') : []).map((entry) => entry.split('\u0001'));
    let cancelled = false;
    const put = (id: string, v: HistoryResponse | null) => {
      if (cancelled) return;
      setBases((prev) => {
        const data = prev.key === idsKey ? prev.data : {};
        // A failed refresh keeps the last good history: energy already used does not disappear.
        if (v === null && data[id]) return prev;
        return { key: idsKey, at: Date.now(), data: { ...data, [id]: v } };
      });
    };
    const load = () => {
      for (const [id = '', ...keys] of list) {
        loadSpan(id, keys, 'today')
          .then((r) => { put(id, Array.isArray(r.ts) && typeof r.series === 'object' ? r : null); })
          .catch(() => { put(id, null); });
      }
    };
    load();
    const t = setInterval(load, ENERGY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [idsKey]);

  const data = bases.key === idsKey ? bases.data : {};
  const loaded = ids.some((id) => data[id] !== undefined);
  const sums = useAcross(
    ids,
    () => {
      let sum: number | null = null;
      const empty: string[] = [];
      for (const id of ids) {
        const r = data[id];
        if (!r || gpuSetGap(nodes[id]?.info, 'energy_j', 'every')) continue;
        const j = sumCounters(r, keysOf(id), (k, t) => liveStore.window(id, [k], t).values[0] ?? []);
        if (j === null) empty.push(id);
        else sum = (sum ?? 0) + j;
      }
      // 0.0001 kWh steps: the display has 3 significant figures, so finer changes are invisible.
      return { joules: sum === null ? null : Math.round(sum / 360) * 360, empty: empty.join('\n') };
    },
    shallowEqual,
    `${bases.key}|${String(bases.at)}`,
  );
  const missing = ids.filter((id) => data[id] === null);
  const empty = sums.empty ? sums.empty.split('\n') : [];
  const until: Record<string, number> = {};
  for (const id of ids) {
    const st = nodes[id]?.status;
    if (!data[id] || empty.includes(id) || st === 'online' || st === 'connecting' || st === undefined) continue;
    const last = liveStore.lastTs(id) ?? nodes[id]?.last_sample_ts ?? null;
    if (last !== null) until[id] = last;
  }
  return { joules: sums.joules, missing, empty, until, loading: !loaded };
}

// ------------------------------------------------------------------------------------------------ breathing glow

/**
 * Drive a card's ambient glow from GPU load without React renders: at most once a second, write `--glow` (0..1)
 * and `data-breath` (period bucket) on the element. CSS does the animation (and drops it under reduced motion).
 */
export function useBreath(ref: RefObject<HTMLElement | null>, node: string, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const util = active ? liveStore.latestValue(node, nodeGpuKey(useCluster.getState().nodes[node]?.info, 'util')) : null;
      el.style.setProperty('--glow', util === null ? '0' : (Math.round(Math.min(100, Math.max(0, util)) / 5) / 20).toFixed(2));
      el.dataset.breath = String(active ? breathLevel(util) : 0);
    };
    apply();
    if (!active) return;
    let last = performance.now();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const off = liveStore.subscribeSample(node, () => {
      const wait = 1000 - (performance.now() - last);
      if (wait <= 0) {
        last = performance.now();
        apply();
      } else {
        pending ??= setTimeout(() => {
          pending = null;
          last = performance.now();
          apply();
        }, wait);
      }
    });
    return () => {
      off();
      if (pending) clearTimeout(pending);
    };
  }, [ref, node, active]);
}
