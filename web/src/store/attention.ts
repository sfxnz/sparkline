// What a node's status pill says: console status, raised by open alerts AND by live conditions the screen is already
// flagging (temperature at slowdown, hardware/thermal clock limits), so a pill is never green beside a red flag.
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { nodeDisplayStatus, type Status } from '../design/components/StatusPill';
import { liveCondition, sameCondition, type LiveCondition } from '../lib/condition';
import type { Sample } from '../lib/types';
import { useCluster } from './cluster';
import { useConnection } from './connection';
import { openAlertLevel, useEvents } from './events';
import { liveStore, useLatest } from './live';

type Level = 'warning' | 'critical' | null;

/** The more severe of two levels. */
export const worstLevel = (a: Level, b: Level): Level => (a === 'critical' || b === 'critical' ? 'critical' : (a ?? b));

/** Live condition of one node's GPU; null unless the node is online (stale values never raise a pill). */
export function useLiveCondition(id: string): LiveCondition | null {
  const slowdown = useCluster((s) => s.nodes[id]?.info?.gpus[0]?.temp_slowdown_c ?? null);
  const online = useCluster((s) => s.nodes[id]?.status === 'online');
  const select = useCallback((s: Sample | null) => liveCondition(s?.gpu[0], slowdown), [slowdown]);
  const c = useLatest(id, select, sameCondition);
  return online ? c : null;
}

/** Status pill for a node in any chrome (sidebar, card, header, wall, interconnect). */
export function useNodeDisplayStatus(id: string): Status {
  const status = useCluster((s) => s.nodes[id]?.status);
  const alert = useEvents((s) => openAlertLevel(s.events, id));
  const consoleLive = useConnection((s) => s.status === 'live');
  const condition = useLiveCondition(id);
  return nodeDisplayStatus(status, worstLevel(alert, condition?.level ?? null), consoleLive);
}

/** Live conditions of several nodes (for the cluster sentence). Re-renders only when one of them changes. */
export function useLiveConditions(ids: readonly string[]): Record<string, LiveCondition | null> {
  const nodes = useCluster((s) => s.nodes);
  const idsKey = ids.join('\u0000');
  const cache = useRef<{ sig: string; value: Record<string, LiveCondition | null> }>({ sig: '', value: {} });
  const subscribe = useCallback(
    (cb: () => void) => {
      const offs = (idsKey ? idsKey.split('\u0000') : []).map((id) => liveStore.subscribeSample(id, cb));
      return () => { offs.forEach((off) => { off(); }); };
    },
    [idsKey],
  );
  const get = () => {
    const value: Record<string, LiveCondition | null> = {};
    for (const id of ids) {
      const n = nodes[id];
      value[id] = n?.status === 'online' ? liveCondition(liveStore.latest(id)?.gpu[0], n.info?.gpus[0]?.temp_slowdown_c) : null;
    }
    const prev = cache.current.value;
    const same = cache.current.sig === idsKey && ids.every((id) => sameCondition(prev[id] ?? null, value[id] ?? null));
    if (same) return prev;
    cache.current = { sig: idsKey, value };
    return value;
  };
  return useSyncExternalStore(subscribe, get, get);
}
