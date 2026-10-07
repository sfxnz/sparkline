// A simulated 24-hour session, as fast as the machine allows: 24 h of 1 Hz samples from three nodes (259,200 samples)
// plus alert events, node status flaps, benchmark runs and history loads go through the real stream dispatcher into
// the real stores, while the real Overview and node GPU/CPU tabs (uPlot charts and the heatmap included) are mounted
// and unmounted 200 times. Every bounded structure must stay within its cap the whole time, and every subscription,
// window/document listener, observer, interval and animation frame a view takes must be released on unmount.
// The real-browser counterpart is scripts/soak.mjs (heap, DOM nodes and listeners over hours of wall time).
import { act, render, screen } from '@testing-library/react';
import type { StateCreator } from 'zustand';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { BenchRun, ClusterState, Event, NodeState, Sample } from '../lib/types';
import sampleJson from '../test/fixtures/sample.json';
import Node from '../views/Node';
import Overview from '../views/Overview';
import { MAX_RUNS, useBench } from './bench';
import { useCluster } from './cluster';
import { useConnection } from './connection';
import { MAX_EVENTS, useEvents } from './events';
import { historyCache } from './history';
import { DEFAULT_CAPACITY, MAX_KEYS_PER_NODE, liveStore } from './live';
import { usePrefs } from './prefs';
import { dispatch } from './session';

// Count live subscriptions on every zustand store (the hooks subscribe through api.subscribe).
const zustandSubs = { n: 0 };
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>();
  type Init = StateCreator<unknown>;
  const make = (init: Init) => {
    const api = actual.createStore(init);
    const subscribe = api.subscribe;
    api.subscribe = (listener) => {
      zustandSubs.n++;
      const off = subscribe(listener);
      let done = false;
      return () => {
        if (!done) zustandSubs.n--;
        done = true;
        off();
      };
    };
    return Object.assign((selector: (s: unknown) => unknown) => actual.useStore(api, selector), api);
  };
  return { ...actual, create: (init?: Init) => (init ? make(init) : make) };
});

const NODES = ['spark1', 'spark2', 'spark3'];
const DAY_S = 86_400;
const MOUNTS = 200;
const CORES = 20;
const T0 = Math.floor(Date.now() / 1000) - DAY_S;
const base = sampleJson as unknown as Sample;

// ---------------------------------------------------------------- resource accounting
const counts = { winListeners: 0, docListeners: 0, intervals: 0, observers: 0 };
const pendingFrames = new Set<number>();
function track(target: Window | Document, key: 'winListeners' | 'docListeners') {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const live = new Set<unknown>();
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
    const id = `${type}|${String(typeof o === 'boolean' ? o : !!o?.capture)}`;
    const k = [id, fn];
    if (![...live].some((x) => (x as unknown[])[0] === id && (x as unknown[])[1] === fn)) {
      live.add(k);
      counts[key]++;
    }
    add(type, fn, o);
  }) as typeof target.addEventListener;
  target.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => {
    const id = `${type}|${String(typeof o === 'boolean' ? o : !!o?.capture)}`;
    for (const x of live) {
      if ((x as unknown[])[0] === id && (x as unknown[])[1] === fn) {
        live.delete(x);
        counts[key]--;
      }
    }
    remove(type, fn, o);
  }) as typeof target.removeEventListener;
}

beforeAll(() => {
  track(window, 'winListeners');
  track(document, 'docListeners');
  const setI = window.setInterval.bind(window);
  const clearI = window.clearInterval.bind(window);
  const intervals = new Set<number>();
  vi.stubGlobal('setInterval', (fn: () => void, ms?: number) => {
    const id = setI(fn, ms);
    intervals.add(id);
    counts.intervals = intervals.size;
    return id;
  });
  vi.stubGlobal('clearInterval', (id?: number) => {
    if (id !== undefined) intervals.delete(id);
    counts.intervals = intervals.size;
    clearI(id);
  });
  // Animation frames are delivered on demand by frame(); a leaked chart loop would stay pending forever.
  let nextFrame = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, cb);
    pendingFrames.add(id);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    callbacks.delete(id);
    pendingFrames.delete(id);
  });
  frame = () => {
    const due = [...callbacks];
    callbacks.clear();
    pendingFrames.clear();
    for (const [, cb] of due) cb(performance.now());
  };
  class Observer {
    private on = false;
    observe() {
      if (!this.on) counts.observers++;
      this.on = true;
    }
    unobserve() {}
    disconnect() {
      if (this.on) counts.observers--;
      this.on = false;
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  vi.stubGlobal('IntersectionObserver', Observer);
  // uPlot and the heatmap draw on a 2D context: a no-op one, so the real chart code runs (create, draw, destroy).
  const noop = () => undefined;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    const props: Record<string | symbol, unknown> = { canvas: this };
    return new Proxy(props, {
      get: (t, p) => {
        if (p in t) return t[p];
        if (p === 'measureText') return (s: string) => ({ width: s.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
        if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return () => ({ addColorStop: noop });
        if (p === 'getImageData' || p === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
        if (p === 'getLineDash') return () => [];
        return noop;
      },
      set: (t, p, v) => {
        t[p] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} rect() {} arc() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} addPath() {} roundRect() {} });
  // REST: history windows, events and runs answer empty (the stream drives everything here).
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = url.includes('/history') || url.includes('/live') ? { node_id: 'spark1', ts: [], series: {} } : [];
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let frame: () => void = () => undefined;

// ---------------------------------------------------------------- synthetic traffic
const nodeState = (id: string, status: NodeState['status'], ts: number): NodeState => ({
  node_id: id, url: `http://${id}:9750`, status, since: ts, last_sample_ts: ts, error: null, info: null, next_retry_ts: null,
});

const wave = (t: number, period: number, phase: number) => 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / period + phase);

function sample(node: string, t: number): Sample {
  const k = NODES.indexOf(node);
  const util = 100 * wave(t, 600, k);
  const g = base.gpu[0];
  if (!g) throw new Error('fixture has no GPU');
  return {
    ...base,
    node_id: node,
    ts: t,
    seq: t - T0,
    gpu: [{ ...g, util, temp_c: 40 + util / 3, power_w: 20 + util }],
    cpu: {
      ...base.cpu,
      util: util / 2,
      per_core: Array.from({ length: CORES }, (_, i) => 100 * wave(t, 120 + i, i)),
      freq_mhz: Array.from({ length: CORES }, (_, i) => 2000 + 10 * i),
    },
    // A fresh process list every 5 s with changing pids, as the agent sends it (null in between).
    procs: t % 5 === 0 ? Array.from({ length: 8 }, (_, i) => ({ pid: (t % 50_000) + i, name: `proc${i}`, cmdline: `python w${i}.py`, user: 'u', cpu_pct: i, rss: 1e6 * i, gpu_mem: 1e8 * i, gpu_util: null, container: null, model: null })) : null,
  };
}

let eventId = 0;
const event = (t: number, node: string, kind: Event['kind'], resolved: number | null): Event => ({
  id: ++eventId, ts: t, node_id: node, severity: kind === 'recovered' ? 'info' : 'warning', kind, rule_id: 'gpu-temp',
  title: `GPU temperature high on ${node}`, detail: '', metric: 'gpu0.temp_c', value: 80, resolved_ts: resolved, acked: false,
});

const run = (n: number, t: number, status: BenchRun['status'], progress: number): BenchRun => ({
  id: `run-${n}`, bench_id: 'gpu-matmul', params: {}, nodes: ['spark1'], status, created_ts: t, started_ts: t, finished_ts: status === 'succeeded' ? t : null,
  progress, phase: status, results: [], series: { 'tflops.bf16': [100, 101, 102] }, metadata: {}, error: null, log_tail: ['ok'],
  baseline_for: false, params_key: '{}', baseline_run_id: null,
});

/** One simulated second of console traffic. */
function second(t: number) {
  for (const id of NODES) dispatch({ type: 'sample', node_id: id, sample: sample(id, t) });
  const s = t - T0;
  if (s % 60 === 0) {
    const node = NODES[(s / 60) % 3] ?? 'spark1';
    dispatch({ type: 'event', event: event(t, node, 'alert', null) });
    dispatch({ type: 'event', event: event(t, node, 'recovered', t) });
  }
  if (s % 600 === 0) {
    const id = NODES[(s / 600) % 3] ?? 'spark1';
    const status = (['stale', 'offline', 'online'] as const)[(s / 1800) % 3 | 0] ?? 'online';
    dispatch({ type: 'node_status', node: nodeState(id, status, t) });
    dispatch({ type: 'node_status', node: nodeState(id, 'online', t + 1) });
  }
  if (s % 300 === 0) {
    const n = s / 300;
    dispatch({ type: 'bench', run: run(n, t, 'queued', 0) });
    dispatch({ type: 'bench', run: run(n, t, 'running', 0.5) });
    dispatch({ type: 'bench', run: run(n, t, 'succeeded', 1) });
  }
  if (s % 97 === 0) {
    // Charts on fixed ranges ask for history with many key sets over a day.
    void historyCache.load(NODES[s % 3] ?? 'spark1', [`gpu0.util`, `cpu.core${s % CORES}.util`], s % 2 ? '1h' : '24h', t);
  }
}

// ---------------------------------------------------------------- views
const VIEWS = ['/', '/node/spark1/gpu', '/node/spark2/cpu'] as const;
function View({ path }: { path: string }) {
  const loc = memoryLocation({ path });
  return (
    <Router hook={loc.hook}>
      <Route path="/" component={Overview} />
      <Route path="/node/:id/:tab?" component={Node} />
    </Router>
  );
}

const snapshot = () => ({
  live: liveStore.listenerCount(),
  zustand: zustandSubs.n,
  ...counts,
  frames: pendingFrames.size,
});

describe('24-hour session (simulated)', () => {
  it('keeps every buffer bounded and releases every subscription after 200 mount/unmount cycles', async () => {
    useConnection.setState({ status: 'live', everLive: true });
    usePrefs.setState({ timeRange: 'live' });
    const hello: ClusterState = {
      nodes: NODES.map((id) => nodeState(id, 'online', T0)),
      settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
      demo: true,
      version: 'test',
      server_time: T0,
    };
    useCluster.getState().setHello(hello);
    liveStore.flush();
    frame();

    // Load the lazy node tabs once, so the cycles below measure steady-state mounts.
    for (const path of VIEWS.slice(1)) {
      second(T0);
      const v = render(<View path={path} />);
      await screen.findAllByRole('figure', undefined, { timeout: 10_000 }).catch(() => undefined);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      v.unmount();
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    liveStore.flush();
    frame();
    const baseline = snapshot();

    const max = { events: 0, runs: 0, history: 0, bytes: 0, keys: 0, nodes: 0 };
    const observe = () => {
      max.events = Math.max(max.events, useEvents.getState().events.length);
      max.runs = Math.max(max.runs, Object.keys(useBench.getState().runs).length);
      max.history = Math.max(max.history, historyCache.size);
      max.bytes = Math.max(max.bytes, liveStore.byteSize());
      max.nodes = Math.max(max.nodes, useCluster.getState().order.length);
      for (const id of NODES) max.keys = Math.max(max.keys, liveStore.keys(id).length);
    };

    const mountEvery = Math.floor((DAY_S - 20) / MOUNTS);
    let mounted: ReturnType<typeof render> | null = null;
    let mounts = 0;
    let peakWhileMounted = baseline;
    for (let s = 1; s <= DAY_S; s++) {
      const t = T0 + s;
      if (s % mountEvery === 0 && mounts < MOUNTS && s + 10 <= DAY_S) {
        // Mount a view, stream 10 s into it (frames delivered), then unmount.
        const path = VIEWS[mounts % VIEWS.length] ?? '/';
        act(() => { mounted = render(<View path={path} />); });
        for (let k = 0; k < 10; k++, s++) {
          act(() => {
            second(T0 + s);
            liveStore.flush();
            frame();
          });
        }
        const during = snapshot();
        if (during.live > peakWhileMounted.live) peakWhileMounted = during;
        act(() => { mounted?.unmount(); });
        mounted = null;
        mounts++;
        s--; // the inner loop stopped on a second it has not sent yet
        continue;
      }
      second(t);
      if (s % 60 === 0) liveStore.flush();
      if (s % 3600 === 0) observe();
    }
    observe();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    liveStore.flush();
    frame();

    expect(mounts).toBe(MOUNTS);
    // The views really subscribed while mounted (otherwise "back to baseline" would prove nothing).
    expect(peakWhileMounted.live).toBeGreaterThan(baseline.live + 5);
    expect(peakWhileMounted.zustand).toBeGreaterThan(baseline.zustand + 5);
    expect(peakWhileMounted.observers).toBeGreaterThan(baseline.observers);
    expect(snapshot()).toEqual(baseline);

    // Bounded structures, at their caps after a day.
    expect(max.events).toBeLessThanOrEqual(MAX_EVENTS);
    expect(useEvents.getState().events).toHaveLength(MAX_EVENTS);
    expect(max.runs).toBeLessThanOrEqual(MAX_RUNS);
    expect(Object.keys(useBench.getState().runs)).toHaveLength(MAX_RUNS);
    expect(max.history).toBeLessThanOrEqual(64);
    expect(max.nodes).toBe(NODES.length);
    expect(max.keys).toBeLessThanOrEqual(MAX_KEYS_PER_NODE);
    for (const id of NODES) {
      expect(liveStore.buffer(id)?.length).toBe(DEFAULT_CAPACITY);
      expect(liveStore.lastTs(id)).toBe(T0 + DAY_S);
    }
    // Ring memory is fixed at first sample: capacity x (1 + keys) x 8 bytes per node, never more.
    const keys = NODES.reduce((n, id) => n + liveStore.keys(id).length + 1, 0);
    expect(max.bytes).toBe(DEFAULT_CAPACITY * 8 * keys);
    expect(liveStore.byteSize()).toBe(max.bytes);
  }, 300_000);
});
