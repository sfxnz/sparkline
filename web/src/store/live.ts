// High-frequency telemetry lives here, outside React.
// Per node: one shared timestamp ring plus one Float64Array value ring per flattened metric key, all with the same
// capacity and write head, so every series of a node is aligned by construction (NaN = no value at that tick).
// Memory is strictly bounded: capacity x (1 + keys) x 8 bytes per node, with keys capped at MAX_KEYS_PER_NODE.
// Subscribers are notified at most once per animation frame, however many samples arrived.
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { flatten } from '../lib/metrics';
import type { HistoryResponse, Sample } from '../lib/types';

export const DEFAULT_CAPACITY = 3600;
export const MAX_KEYS_PER_NODE = 512;

type Listener = () => void;

export class NodeBuffer {
  readonly ts: Float64Array;
  readonly values = new Map<string, Float64Array>();
  /** Index of the oldest element. */
  start = 0;
  length = 0;
  latest: Sample | null = null;

  constructor(readonly capacity: number) {
    this.ts = new Float64Array(capacity);
  }

  /** Append one tick. Keys missing from `flat` get NaN; new keys are back-filled with NaN. */
  push(ts: number, flat: ReadonlyMap<string, number>): void {
    if (this.length > 0 && ts <= this.lastTs()) return; // out-of-order or duplicate tick
    const i = (this.start + this.length) % this.capacity;
    if (this.length < this.capacity) this.length++;
    else this.start = (this.start + 1) % this.capacity;
    this.ts[i] = ts;
    for (const [key, ring] of this.values) ring[i] = flat.get(key) ?? NaN;
    for (const [key, v] of flat) {
      if (this.values.has(key) || this.values.size >= MAX_KEYS_PER_NODE) continue;
      const ring = new Float64Array(this.capacity).fill(NaN);
      ring[i] = v;
      this.values.set(key, ring);
    }
  }

  lastTs(): number {
    return this.length ? (this.ts[(this.start + this.length - 1) % this.capacity] ?? NaN) : NaN;
  }

  firstTs(): number {
    return this.length ? (this.ts[this.start] ?? NaN) : NaN;
  }

  /** Physical index of the logical position `n` (0 = oldest). */
  index(n: number): number {
    return (this.start + n) % this.capacity;
  }

  /** First logical position with ts >= from (binary search; the ring is sorted by time). */
  lowerBound(from: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.ts[this.index(mid)] ?? 0) < from) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  clear(): void {
    this.start = this.length = 0;
    this.values.clear();
    this.latest = null;
  }
}

/** Aligned arrays for charts. `values[k][i]` is null where there is no data (uPlot gap). */
export interface Window {
  ts: number[];
  values: (number | null)[][];
}

export class LiveStore {
  private readonly nodes = new Map<string, NodeBuffer>();
  private readonly sampleListeners = new Map<string, Set<Listener>>();
  private readonly keyListeners = new Map<string, Set<Listener>>();
  private readonly dirtyNodes = new Set<string>();
  private readonly dirtyKeys = new Set<string>();
  private scheduled = false;
  private readonly schedule: (cb: () => void) => void;

  constructor(
    readonly capacity: number = DEFAULT_CAPACITY,
    schedule?: (cb: () => void) => void,
  ) {
    this.schedule =
      schedule ??
      ((cb) => {
        if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
          requestAnimationFrame(cb);
        } else setTimeout(cb, 16);
      });
  }

  buffer(node: string): NodeBuffer | undefined {
    return this.nodes.get(node);
  }

  private ensure(node: string): NodeBuffer {
    let b = this.nodes.get(node);
    if (!b) {
      b = new NodeBuffer(this.capacity);
      this.nodes.set(node, b);
    }
    return b;
  }

  pushSample(sample: Sample): void {
    const b = this.ensure(sample.node_id);
    const flat = flatten(sample);
    b.push(sample.ts, flat);
    // procs is null on ticks between process refreshes: keep the last known list.
    b.latest = sample.procs == null && b.latest?.procs ? { ...sample, procs: b.latest.procs } : sample;
    this.markDirty(sample.node_id, flat.keys());
  }

  /** Back-fill a node from a HistoryResponse (e.g. /api/v1/live on connect). Only points older than what the
   *  buffer already holds are added; the newest `capacity` points are kept. */
  seed(resp: HistoryResponse): void {
    const b = this.ensure(resp.node_id);
    const first = b.length ? b.firstTs() : Infinity;
    const keys = Object.keys(resp.series);
    const rows: { ts: number; flat: Map<string, number> }[] = [];
    resp.ts.forEach((t, i) => {
      if (t >= first) return;
      const flat = new Map<string, number>();
      for (const k of keys) {
        const v = resp.series[k]?.[i];
        if (v != null) flat.set(k, v);
      }
      rows.push({ ts: t, flat });
    });
    if (!rows.length) return;
    // Existing ticks, re-read so they can be re-appended after the older history.
    for (let n = 0; n < b.length; n++) {
      const i = b.index(n);
      const flat = new Map<string, number>();
      for (const [k, ring] of b.values) {
        const v = ring[i];
        if (v !== undefined && !Number.isNaN(v)) flat.set(k, v);
      }
      rows.push({ ts: b.ts[i] ?? 0, flat });
    }
    const latest = b.latest;
    b.clear();
    b.latest = latest;
    for (const r of rows.slice(-this.capacity)) b.push(r.ts, r.flat);
    this.markDirty(resp.node_id, keys);
  }

  removeNode(node: string): void {
    this.nodes.delete(node);
  }

  latest(node: string): Sample | null {
    return this.nodes.get(node)?.latest ?? null;
  }

  lastTs(node: string): number | null {
    const t = this.nodes.get(node)?.lastTs();
    return t === undefined || Number.isNaN(t) ? null : t;
  }

  /** Most recent value of a key, or null if the key has no value at the latest tick. */
  latestValue(node: string, key: string): number | null {
    const b = this.nodes.get(node);
    const ring = b?.values.get(key);
    if (!b || !ring || !b.length) return null;
    const v = ring[b.index(b.length - 1)];
    return v === undefined || Number.isNaN(v) ? null : v;
  }

  hasKey(node: string, key: string): boolean {
    return this.nodes.get(node)?.values.has(key) ?? false;
  }

  keys(node: string): string[] {
    return [...(this.nodes.get(node)?.values.keys() ?? [])];
  }

  /** Copy the ticks with ts >= from for `keys` into chart-ready aligned arrays. */
  window(node: string, keys: readonly string[], from = -Infinity): Window {
    const b = this.nodes.get(node);
    if (!b?.length) return { ts: [], values: keys.map(() => []) };
    const lo = b.lowerBound(from);
    const n = b.length - lo;
    const ts = new Array<number>(n);
    const rings = keys.map((k) => b.values.get(k));
    const values = keys.map(() => new Array<number | null>(n));
    for (let j = 0; j < n; j++) {
      const i = b.index(lo + j);
      ts[j] = b.ts[i] ?? 0;
      for (let k = 0; k < rings.length; k++) {
        const v = rings[k]?.[i];
        (values[k] as (number | null)[])[j] = v === undefined || Number.isNaN(v) ? null : v;
      }
    }
    return { ts, values };
  }

  subscribeSample(node: string, cb: Listener): () => void {
    return this.add(this.sampleListeners, node, cb);
  }

  subscribe(node: string, key: string, cb: Listener): () => void {
    return this.add(this.keyListeners, `${node}\u0000${key}`, cb);
  }

  private add(map: Map<string, Set<Listener>>, id: string, cb: Listener): () => void {
    let set = map.get(id);
    if (!set) {
      set = new Set();
      map.set(id, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (!set.size) map.delete(id);
    };
  }

  private markDirty(node: string, keys: Iterable<string>): void {
    this.dirtyNodes.add(node);
    if (this.keyListeners.size) for (const k of keys) this.dirtyKeys.add(`${node}\u0000${k}`);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.flush();
    });
  }

  /** Deliver pending notifications now (normally called once per animation frame). */
  flush(): void {
    this.scheduled = false;
    const nodes = [...this.dirtyNodes];
    const keys = [...this.dirtyKeys];
    this.dirtyNodes.clear();
    this.dirtyKeys.clear();
    for (const n of nodes) this.sampleListeners.get(n)?.forEach((cb) => { cb(); });
    for (const k of keys) this.keyListeners.get(k)?.forEach((cb) => { cb(); });
  }

  /** Approximate bytes held by typed arrays (used by the memory-bound test). */
  byteSize(): number {
    let total = 0;
    for (const b of this.nodes.values()) {
      total += b.ts.byteLength;
      for (const r of b.values.values()) total += r.byteLength;
    }
    return total;
  }
}

export const liveStore = new LiveStore();

/**
 * Subscribe a component to a derived value of a node's latest Sample. The component re-renders only when
 * `isEqual(previous, next)` is false, so a Stat showing GPU temperature ignores ticks where the temperature
 * did not change.
 */
export function useLatest<T>(
  node: string,
  selector: (s: Sample | null) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
  store: LiveStore = liveStore,
): T {
  const cache = useRef<{ sample: Sample | null; selector: (s: Sample | null) => T; value: T } | null>(null);
  const subscribe = useCallback((cb: Listener) => store.subscribeSample(node, cb), [store, node]);
  const getSnapshot = () => {
    const sample = store.latest(node);
    const prev = cache.current;
    if (prev && prev.sample === sample && prev.selector === selector) return prev.value;
    const next = selector(sample);
    if (prev && isEqual(prev.value, next)) {
      cache.current = { sample, selector, value: prev.value };
      return prev.value;
    }
    cache.current = { sample, selector, value: next };
    return next;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
