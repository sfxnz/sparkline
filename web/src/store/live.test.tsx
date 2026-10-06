import { act, render } from '@testing-library/react';
import sampleJson from '../test/fixtures/sample.json';
import type { GpuSample, Sample } from '../lib/types';
import { LiveStore, MAX_KEYS_PER_NODE, useLatest } from './live';

const base = sampleJson as unknown as Sample;
const gpu0 = base.gpu[0] as GpuSample;
const mk = (ts: number, gpuUtil: number | null = 50, node = 'spark1'): Sample => ({
  ...base,
  node_id: node,
  ts,
  gpu: [{ ...gpu0, util: gpuUtil }],
});

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

  it('caps the number of keys per node', () => {
    const { store } = manual(4);
    const many = { ...mk(1), temps: Array.from({ length: MAX_KEYS_PER_NODE + 100 }, (_, i) => ({ id: `s${i}`, c: 1 })) };
    store.pushSample(many);
    expect(store.keys('spark1').length).toBe(MAX_KEYS_PER_NODE);
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
      const temp = useLatest('spark1', (s) => s?.gpu[0]?.temp_c ?? null, Object.is, store);
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
