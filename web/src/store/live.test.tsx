import { act, render } from '@testing-library/react';
import sampleJson from '../test/fixtures/sample.json';
import type { DiskSample, FsSample, GpuSample, NetSample, Sample } from '../lib/types';
import { flatten } from '../lib/metrics';
import { KEY_CAP_FLOOR, LiveStore, useLatest } from './live';
import { gpuAt } from '../lib/gpu';

const base = sampleJson as unknown as Sample;
const gpu0 = gpuAt(base.gpu, 0) as GpuSample;
const mk = (ts: number, gpuUtil: number | null = 50, node = 'spark1'): Sample => ({
  ...base,
  node_id: node,
  ts,
  gpu: [{ ...gpu0, util: gpuUtil }],
});

const netA = base.net[0] as NetSample;

/** A large workstation: 256 threads, 8 GPUs, 6 NICs, 4 disks, 6 filesystems and 40 sensors. */
function bigNode(ts: number): Sample {
  const n = (k: number) => Array.from({ length: k }, (_, i) => i);
  return {
    ...base,
    node_id: 'ws8',
    ts,
    gpu: n(8).map((index) => ({ ...gpu0, index, util: 10 + index })),
    cpu: { ...base.cpu, per_core: n(256).map((i) => i % 100), freq_mhz: n(256).map((i) => 3000 + i) },
    net: n(6).map((i) => ({ ...netA, name: `enp${i}s0` })),
    disk: n(4).map((i) => ({ ...(base.disk[0] as DiskSample), name: `nvme${i}n1` })),
    fs: n(6).map((i) => ({ ...(base.fs[0] as FsSample), mount: `/mnt/d${i}`, key: `mnt_d${i}` })),
    temps: n(40).map((i) => ({ id: `hwmon.s${i}`, c: 40 + i })),
  };
}

/** A store whose notifications are flushed manually (deterministic frames). */
function manual(capacity = 8) {
  const frames: (() => void)[] = [];
  const store = new LiveStore(capacity, (cb) => frames.push(cb));
  const frame = () => { frames.splice(0).forEach((f) => { f(); }); };
  return { store, frame, frames };
}

describe('LiveStore ring buffers', () => {
  it('keeps the newest `capacity` ticks in order', () => {
    const { store } = manual(4);
    for (let t = 1; t <= 10; t++) store.pushSample(mk(t, t * 10));
    const w = store.window('spark1', ['gpu0.util']);
    expect(w.ts).toEqual([7, 8, 9, 10]);
    expect(w.values[0]).toEqual([70, 80, 90, 100]);
    expect(store.latestValue('spark1', 'gpu0.util')).toBe(100);
    expect(store.lastTs('spark1')).toBe(10);
  });

  it('aligns series and leaves gaps (null) where a metric is missing', () => {
    const { store } = manual(8);
    store.pushSample(mk(1, 10));
    store.pushSample(mk(2, null));
    store.pushSample(mk(3, 30));
    const w = store.window('spark1', ['gpu0.util', 'gpu0.temp_c', 'no.such.key']);
    expect(w.ts).toEqual([1, 2, 3]);
    expect(w.values[0]).toEqual([10, null, 30]);
    expect(w.values[1]).toEqual([71, 71, 71]);
    expect(w.values[2]).toEqual([null, null, null]);
    expect(store.latestValue('spark1', 'gpu0.util')).toBe(30);
  });

  it('filters by time and drops out-of-order ticks', () => {
    const { store } = manual(8);
    [1, 2, 3, 2.5, 3, 4].forEach((t) => { store.pushSample(mk(t)); });
    expect(store.window('spark1', ['gpu0.util']).ts).toEqual([1, 2, 3, 4]);
    expect(store.window('spark1', ['gpu0.util'], 2.5).ts).toEqual([3, 4]);
  });

  it('keeps the last process list on ticks where procs is null', () => {
    const { store } = manual(8);
    const procs = [{ pid: 1, name: 'python', cmdline: 'python serve.py', user: null, cpu_pct: 1, rss: 1, gpu_mem: 2, gpu_util: null, container: 'c5-2B-r0', model: null }];
    store.pushSample({ ...mk(1), procs });
    store.pushSample(mk(2));
    expect(store.latest('spark1')?.ts).toBe(2);
    expect(store.latest('spark1')?.procs).toEqual(procs);
  });

  it('memory stays strictly bounded over a long session', () => {
    const { store } = manual(3600);
    for (let t = 1; t <= 3600; t++) store.pushSample(mk(t, t % 100));
    const full = store.byteSize();
    for (let t = 3601; t <= 3600 * 6; t++) store.pushSample(mk(t, t % 100));
    expect(store.byteSize()).toBe(full);
    const keys = store.keys('spark1').length;
    // (1 timestamp ring + one ring per key) x capacity x 8 bytes
    expect(full).toBe((1 + keys) * 3600 * 8);
  });

  it('keeps every metric of a 256-thread, 8-GPU node with several NICs, disks, filesystems and 40 sensors', () => {
    const { store } = manual(4);
    const big = bigNode(1);
    const flat = flatten(big);
    expect(flat.size, 'the node is larger than the old fixed cap').toBeGreaterThan(KEY_CAP_FLOOR);
    store.pushSample(big);
    const missing = [...flat].filter(([k, v]) => store.latestValue('ws8', k) !== v).map(([k]) => k);
    expect(missing).toEqual([]);
    // History for a metric the live ticks have not carried yet (a chart back-filling it) is kept too.
    store.seed({ node_id: 'ws8', resolution_s: 1, ts: [0], series: { 'gpu7.thermal_capped_pct': [12] }, min: {}, max: {} });
    expect(store.window('ws8', ['gpu7.thermal_capped_pct']).values[0]).toEqual([12, null]);
  });

  it('stays bounded when keys churn: at most twice the largest tick, however many keys come and go', () => {
    const { store } = manual(4);
    const tick = (t: number) => ({ ...mk(t), net: Array.from({ length: 60 }, (_, i) => ({ ...netA, name: `veth${t}_${i}` })) });
    const perTick = flatten(tick(1)).size;
    for (let t = 1; t <= 200; t++) store.pushSample(tick(t));
    const bound = Math.max(KEY_CAP_FLOOR, 2 * perTick);
    expect(store.keys('spark1').length).toBeLessThanOrEqual(bound);
    expect(store.byteSize()).toBeLessThanOrEqual((1 + bound) * 4 * 8);
    expect(store.latestValue('spark1', 'gpu0.util'), 'keys present from the start keep updating').toBe(50);
  });

  it('seeds older history behind live ticks without duplicating', () => {
    const { store } = manual(6);
    store.pushSample(mk(10, 100));
    store.pushSample(mk(11, 110));
    store.seed({ node_id: 'spark1', resolution_s: 1, ts: [6, 7, 8, 9, 10, 11], series: { 'gpu0.util': [60, 70, null, 90, 999, 999] }, min: {}, max: {} });
    const w = store.window('spark1', ['gpu0.util', 'gpu0.temp_c']);
    expect(w.ts).toEqual([6, 7, 8, 9, 10, 11]);
    expect(w.values[0]).toEqual([60, 70, null, 90, 100, 110]);
    expect(w.values[1]).toEqual([null, null, null, null, 71, 71]);
    expect(store.latest('spark1')?.ts).toBe(11);
  });
});

describe('LiveStore reconnect back-fill', () => {
  const SOCKET_UTIL = 50;
  const REPLY_UTIL = 1;
  const LAST_TICK_BEFORE_DROP = 1000;
  const RECONNECT_TICK = 1120;
  const LIVE_SECONDS = 900;
  const ticks = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const filled = (from: number, to: number, v: number) => ticks(from, to).map(() => v);
  const reply = (from: number, to: number) => {
    const ts = ticks(from, to);
    return { node_id: 'spark1', resolution_s: 1, ts, series: { 'gpu0.util': ts.map(() => REPLY_UTIL) }, min: {}, max: {} };
  };
  const replyAtReconnect = () => reply(RECONNECT_TICK - LIVE_SECONDS + 1, RECONNECT_TICK);
  const beforeOutage = () => {
    const { store, frame } = manual(3600);
    for (let t = 1; t <= LAST_TICK_BEFORE_DROP; t++) store.pushSample(mk(t, SOCKET_UTIL));
    frame();
    return { store, frame };
  };

  it('fills the outage when a new-socket sample lands before the seed reply', () => {
    const { store, frame } = beforeOutage();
    const onKey = vi.fn();
    store.subscribe('spark1', 'gpu0.util', onKey);
    store.pushSample(mk(RECONNECT_TICK, SOCKET_UTIL));
    frame();
    store.seed(replyAtReconnect());
    frame();
    const w = store.window('spark1', ['gpu0.util']);
    expect(w.ts).toEqual(ticks(1, RECONNECT_TICK));
    expect(w.values[0]).toEqual([
      ...filled(1, LAST_TICK_BEFORE_DROP, SOCKET_UTIL),
      ...filled(LAST_TICK_BEFORE_DROP + 1, RECONNECT_TICK - 1, REPLY_UTIL),
      SOCKET_UTIL,
    ]);
    expect(onKey).toHaveBeenCalledTimes(2);
    expect(store.latest('spark1')?.ts).toBe(RECONNECT_TICK);
  });

  it('fills the outage when the seed reply lands before the new-socket samples', () => {
    const { store } = beforeOutage();
    store.seed(replyAtReconnect());
    store.pushSample(mk(RECONNECT_TICK, SOCKET_UTIL));
    store.pushSample(mk(RECONNECT_TICK + 1, SOCKET_UTIL));
    const w = store.window('spark1', ['gpu0.util']);
    expect(w.ts).toEqual(ticks(1, RECONNECT_TICK + 1));
    expect(w.values[0]).toEqual([
      ...filled(1, LAST_TICK_BEFORE_DROP, SOCKET_UTIL),
      ...filled(LAST_TICK_BEFORE_DROP + 1, RECONNECT_TICK, REPLY_UTIL),
      SOCKET_UTIL,
    ]);
    expect(store.latest('spark1')?.ts).toBe(RECONNECT_TICK + 1);
  });

  it('keeps the newest `capacity` ticks after filling a gap', () => {
    const { store } = manual(8);
    for (let t = 1; t <= 5; t++) store.pushSample(mk(t, SOCKET_UTIL));
    store.pushSample(mk(12, SOCKET_UTIL));
    store.seed(reply(3, 12));
    const w = store.window('spark1', ['gpu0.util']);
    expect(w.ts).toEqual(ticks(5, 12));
    expect(w.values[0]).toEqual([SOCKET_UTIL, ...filled(6, 11, REPLY_UTIL), SOCKET_UTIL]);
  });

  it('fills a gap in a ring that has wrapped', () => {
    const { store } = manual(8);
    for (const t of [...ticks(1, 6), ...ticks(9, 12)]) store.pushSample(mk(t, SOCKET_UTIL));
    store.seed(reply(7, 8));
    const w = store.window('spark1', ['gpu0.util']);
    expect(w.ts).toEqual(ticks(5, 12));
    expect(w.values[0]).toEqual([...filled(5, 6, SOCKET_UTIL), ...filled(7, 8, REPLY_UTIL), ...filled(9, 12, SOCKET_UTIL)]);
  });
});

describe('LiveStore notifications', () => {
  it('coalesces many samples into one notification per frame', () => {
    const { store, frame, frames } = manual(8);
    const onNode = vi.fn();
    const onKey = vi.fn();
    const onOther = vi.fn();
    store.subscribeSample('spark1', onNode);
    store.subscribe('spark1', 'gpu0.util', onKey);
    store.subscribeSample('spark2', onOther);
    store.pushSample(mk(1));
    store.pushSample(mk(2));
    store.pushSample(mk(3));
    expect(frames).toHaveLength(1);
    expect(onNode).not.toHaveBeenCalled();
    frame();
    expect(onNode).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onOther).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly', () => {
    const { store, frame } = manual(8);
    const cb = vi.fn();
    const off = store.subscribeSample('spark1', cb);
    off();
    store.pushSample(mk(1));
    frame();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('useLatest', () => {
  it('re-renders only when the selected value changes', () => {
    const { store, frame } = manual(8);
    let renders = 0;
    function Temp() {
      renders++;
      const temp = useLatest('spark1', (s) => gpuAt(s?.gpu, 0)?.temp_c ?? null, Object.is, store);
      return <span data-testid="t">{temp ?? '—'}</span>;
    }
    const { getByTestId } = render(<Temp />);
    expect(getByTestId('t').textContent).toBe('—');
    const r0 = renders;
    act(() => { store.pushSample(mk(1, 10)); frame(); });
    expect(getByTestId('t').textContent).toBe('71');
    const r1 = renders;
    expect(r1).toBeGreaterThan(r0);
    // util changes every tick, temperature does not: no re-render.
    act(() => { store.pushSample(mk(2, 20)); frame(); });
    act(() => { store.pushSample(mk(3, 30)); frame(); });
    expect(renders).toBe(r1);
    act(() => { store.pushSample({ ...mk(4), gpu: [{ ...gpu0, temp_c: 75 }] }); frame(); });
    expect(getByTestId('t').textContent).toBe('75');
  });
});
