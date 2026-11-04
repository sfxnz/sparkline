import { act, fireEvent, render, screen } from '@testing-library/react';
import sampleJson from '../test/fixtures/sample.json';
import type { CoreInfo, Sample } from '../lib/types';
import { LiveStore } from '../store/live';
import { cellEdges, Heatmap } from './Heatmap';

const base = sampleJson as unknown as Sample;
const mk = (ts: number, util: number): Sample => ({ ...base, node_id: 'spark1', ts, cpu: { ...base.cpu, per_core: [util, util, util] } });
const cores: CoreInfo[] = [0, 1, 2].map((id) => ({ id, kind: 'performance', model: null, max_mhz: null, cluster: null }));

describe('Heatmap', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('readout changes only on arrow keys, not when new samples arrive', () => {
    let t = 10_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => t);
    const frames: (() => void)[] = [];
    const store = new LiveStore(16, (cb) => frames.push(cb));
    const now = Date.now() / 1000;
    store.pushSample(mk(now - 1, 35));
    render(<Heatmap node="spark1" cores={cores} store={store} />);
    const img = screen.getByRole('img');
    img.focus();
    fireEvent.keyDown(img, { key: 'ArrowDown' });
    const live = img.parentElement?.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('Core 0 · Performance: 35% now');
    const label = img.getAttribute('aria-label');

    t += 6000; // past the 5 s summary cadence
    act(() => {
      store.pushSample(mk(now, 80));
      frames.splice(0).forEach((f) => { f(); });
    });
    expect(live).toHaveTextContent('Core 0 · Performance: 35% now');
    expect(img.getAttribute('aria-label')).toBe(label);

    fireEvent.keyDown(img, { key: 'ArrowDown' });
    expect(live).toHaveTextContent('Core 1 · Performance: 80% now');
    clock.mockRestore();
  });
});

describe('Heatmap group labels', () => {
  const core = (id: number, kind: CoreInfo['kind'], model: string | null = null): CoreInfo => ({ id, kind, model, max_mhz: null, cluster: null });
  let drawn: string[] = [];

  beforeEach(() => {
    drawn = [];
    const ctx = new Proxy({}, { get: (_, key) => (key === 'fillText' ? (text: string) => { drawn.push(text); } : () => undefined), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
    vi.stubGlobal('ResizeObserver', class {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.cb = cb; }
      observe() { this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const groupLabels = () => [...new Set(drawn.filter((t) => !/^\d+$/.test(t)))];

  it('labels a lone group of unknown cores "All cores", never "Other"', () => {
    render(<Heatmap node="spark1" cores={[core(0, 'unknown'), core(1, 'unknown'), core(2, 'unknown')]} store={new LiveStore(16)} />);
    expect(groupLabels()).toEqual(['All cores']);
  });

  it('keeps "Other" for unknown cores beside a performance/efficiency split, performance first', () => {
    render(<Heatmap node="spark1" cores={[core(0, 'unknown'), core(1, 'efficiency'), core(2, 'performance')]} store={new LiveStore(16)} />);
    expect(groupLabels()).toEqual(['Performance', 'Efficiency', 'Other']);
  });

  it('reads a core out by its group, without the product name its cores report', () => {
    const cpu = 'AMD Ryzen 9 7950X 16-Core Processor';
    const store = new LiveStore(16);
    store.pushSample(mk(Date.now() / 1000 - 1, 35));
    store.flush();
    render(<Heatmap node="spark1" cores={[0, 1, 2].map((id) => core(id, 'unknown', cpu))} cpuModel={cpu} store={store} />);
    const img = screen.getByRole('img');
    fireEvent.keyDown(img, { key: 'ArrowDown' });
    expect(img.parentElement?.querySelector('[aria-live="polite"]')).toHaveTextContent(/^Core 0 · All cores: 35% now/);
  });
});

describe('cellEdges', () => {
  const xAt = (t: number) => t * 1.37; // 1.37 px per second: edges land between pixels

  it('makes jittered live samples contiguous: no 1 px seams, no overlaps', () => {
    const ts = [100, 101.004, 101.998, 103.01, 104.002, 104.999];
    const e = cellEdges(ts, 1, 'end', xAt, 0, 1e9);
    for (let j = 1; j < ts.length; j++) expect(e[2 * j]).toBe(e[2 * j - 1]);
  });

  it('keeps a real gap in the data as a gap', () => {
    const e = cellEdges([100, 101, 110, 111], 1, 'end', xAt, 0, 1e9);
    expect(e[4]).toBeGreaterThan(e[3] ?? 0);
  });

  it('centres history buckets on their timestamp and spans the full bucket width', () => {
    const e = cellEdges([1000, 1180, 1360], 180, 'center', (t) => t / 10, 0, 1e9);
    expect([e[0], e[1], e[2], e[3], e[4], e[5]]).toEqual([91, 109, 109, 127, 127, 145]);
  });
});
