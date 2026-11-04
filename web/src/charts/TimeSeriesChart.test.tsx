import { act, render, screen, within } from '@testing-library/react';
import type { NodeInfo, NodeState } from '../lib/types';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { liveStore, LiveStore } from '../store/live';
import { usePrefs } from '../store/prefs';
import { sharedYMax, TimeSeriesChart } from './TimeSeriesChart';

interface PlotStandIn {
  opts: { hooks: { setSelect: ((u: PlotStandIn) => void)[] } };
  data: (number | null)[][];
  select: { width: number };
}

// uPlot needs a real canvas.
const plots = { created: 0, destroyed: 0 };
const newest: { plot?: PlotStandIn } = {};
vi.mock('uplot', () => {
  class FakePlot {
    static pxRatio = 1;
    static fmtDate = () => () => '';
    static rangeNum = (lo: number, hi: number) => [lo, hi];
    bbox = { left: 0, top: 0, width: 600, height: 200 };
    cursor = { idx: null };
    scales: Record<string, { min: number; max: number }> = { x: { min: 0, max: 1 } };
    select = { width: 0 };
    constructor(readonly opts: PlotStandIn['opts'], public data: (number | null)[][]) {
      plots.created++;
      newest.plot = this;
    }
    setData(d: (number | null)[][]) { this.data = d; }
    setScale(key: string, s: { min: number; max: number }) { this.scales[key] = s; }
    setSize() {}
    valToPos() { return 0; }
    destroy() { plots.destroyed++; }
  }
  return { default: FakePlot };
});

let frames: FrameRequestCallback[] = [];
let framesRequested = 0;
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return ++framesRequested;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});
afterAll(() => { vi.unstubAllGlobals(); });

describe('TimeSeriesChart', () => {
  it('keeps one plot across re-renders that pass an equal series array (no rebuild on every sample)', () => {
    const store = new LiveStore(16, () => undefined);
    const fmt = (n: number) => `${n}`;
    // Callers write the series inline, so every render passes a new array with the same contents.
    const series = () => [{ key: 'net.eth0.rx_bps', label: 'Receive' }, { key: 'net.eth0.tx_bps', label: 'Transmit' }];
    const { rerender, unmount } = render(<TimeSeriesChart node="spark1" title="eth0 throughput" series={series()} format={fmt} range="live" store={store} />);
    for (let i = 0; i < 5; i++) rerender(<TimeSeriesChart node="spark1" title="eth0 throughput" series={series()} format={fmt} range="live" store={store} />);
    expect(plots).toEqual({ created: 1, destroyed: 0 });
    // A real change of series does rebuild it.
    rerender(<TimeSeriesChart node="spark1" title="eth0 throughput" series={[{ key: 'net.eth0.rx_bps', label: 'Receive' }]} format={fmt} range="live" store={store} />);
    expect(plots).toEqual({ created: 2, destroyed: 1 });
    unmount();
    expect(plots.destroyed).toBe(2);
  });
});

describe('GPU series colours', () => {
  it('draws a GPU series line and legend swatch in its index colour, past the eighth GPU in the neutral axis colour; other series keep their position colour', () => {
    const store = new LiveStore(16, () => undefined);
    const series = [
      { key: 'gpu2.util', label: 'GPU 2', gpu: 2 },
      { key: 'gpu0.util', label: 'GPU 0', gpu: 0 },
      { key: 'gpu9.util', label: 'GPU 9', gpu: 9 },
      { key: 'cpu.util', label: 'CPU' },
    ];
    const { container, unmount } = render(<TimeSeriesChart node="spark1" title="Utilisation" series={series} format={String} range="live" store={store} />);
    const opts = newest.plot?.opts as unknown as { series: { stroke?: string }[] };
    expect(opts.series.slice(1).map((s) => s.stroke)).toEqual(['#199e70', '#3987e5', '#888', '#b4a4f5']);
    const swatches = [...container.querySelectorAll<HTMLElement>('.tschart__legend-item .tschart__swatch')].map((el) => el.style.background);
    expect(swatches).toEqual(['var(--gpu-2)', 'var(--gpu-0)', 'var(--chart-axis)', '']);
    unmount();
  });

  it('fills no GPU series, so no GPU looks primary on a comparison chart', () => {
    const store = new LiveStore(16, () => undefined);
    const gpus = [0, 1].map((i) => ({ key: `gpu${i}.util`, label: `GPU ${i}`, gpu: i }));
    const { unmount } = render(<TimeSeriesChart node="spark1" title="Utilisation" series={gpus} format={String} range="live" store={store} />);
    const opts = newest.plot?.opts as unknown as { series: { fill?: unknown }[] };
    expect(opts.series.slice(1).map((s) => s.fill)).toEqual([undefined, undefined]);
    unmount();
  });
});

describe('live chart, as lines or as stacked layers', () => {
  const NODE = 'mtest';
  const LAYERS = [
    { key: 'mem.gpu', label: 'GPU', className: 'mem-c-gpu' },
    { key: 'mem.anon', label: 'Processes', className: 'mem-c-anon' },
    { key: 'mem.cache', label: 'Page cache', className: 'mem-c-cache', hatched: true },
  ];
  const fmt = (n: number) => `${n} B`;
  const charts = {
    lines: () => render(<TimeSeriesChart node={NODE} title="Memory" series={LAYERS} format={fmt} />),
    stacked: () => render(<TimeSeriesChart node={NODE} title="Memory" stack series={LAYERS} format={fmt} />),
  };
  const node = (status: NodeState['status']): NodeState => ({ node_id: NODE, url: '', status, since: 0, last_sample_ts: null, error: null, info: null, next_retry_ts: null });
  const seed = (ts: number[], values: number[][]) => {
    liveStore.seed({ node_id: NODE, resolution_s: 1, ts, series: Object.fromEntries(LAYERS.map((l, k) => [l.key, values[k] ?? []])), min: {}, max: {} });
    liveStore.flush();
  };
  const runFrames = (n: number) => {
    for (let i = 0; i < n; i++) {
      act(() => {
        vi.advanceTimersByTime(1000 / 60);
        const due = frames;
        frames = [];
        due.forEach((cb) => { cb(performance.now()); });
      });
    }
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    frames = [];
    framesRequested = 0;
    liveStore.removeNode(NODE);
    usePrefs.setState({ timeRange: 'live' });
    useConnection.setState({ status: 'live', everLive: true });
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node('online') } });
  });
  afterEach(() => { vi.useRealTimers(); });

  describe.each(['lines', 'stacked'] as const)('%s', (mode) => {
    it('sleeps between half-pixel scroll steps instead of requesting every display frame', () => {
      const now = Date.now() / 1000;
      seed([now - 2, now - 1], [[1, 1], [2, 2], [3, 3]]);
      framesRequested = 0;
      charts[mode]();
      runFrames(60);
      expect(framesRequested, 'animation frames requested over one idle second').toBeLessThan(10);
    });

    it('requests no more frames once a drag-zoom has paused it', () => {
      const now = Date.now() / 1000;
      seed([now - 2, now - 1], [[1, 1], [2, 2], [3, 3]]);
      charts[mode]();
      runFrames(2);
      act(() => {
        const plot = newest.plot;
        if (!plot) throw new Error('no plot');
        plot.select.width = 120;
        plot.opts.hooks.setSelect.forEach((h) => { h(plot); });
      });
      expect(screen.getByRole('button', { name: 'Back to live' })).toBeInTheDocument();
      framesRequested = 0;
      runFrames(60);
      expect(framesRequested, 'animation frames requested over one paused second').toBeLessThanOrEqual(1);
    });

    it('breaks the plot across an outage instead of drawing straight over it', () => {
      const now = Date.now() / 1000;
      seed([now - 100, now - 99, now - 98, now - 2, now - 1], [[1, 1, 1, 2, 2], [1, 1, 1, 2, 2], [1, 1, 1, 2, 2]]);
      charts[mode]();
      runFrames(2);
      const drawn = newest.plot?.data ?? [];
      expect(drawn[0]).toHaveLength(6);
      for (const layer of drawn.slice(1)) expect(layer[3]).toBeNull();
    });

    it('says "No data in this range", not a blank plot, when samples arrive without the chart\'s keys', () => {
      const now = Date.now() / 1000;
      liveStore.seed({ node_id: NODE, resolution_s: 1, ts: [now - 2, now - 1], series: { 'cpu.util': [5, 6] }, min: {}, max: {} });
      liveStore.flush();
      const { container } = charts[mode]();
      runFrames(2);
      expect(screen.getByText('No data in this range')).toBeInTheDocument();
      expect(container.querySelector('.skeleton')).not.toBeInTheDocument();
    });

    it('shows the loading skeleton, not "No data in this range", while an online node has sent nothing yet', () => {
      const { container } = charts[mode]();
      runFrames(2);
      expect(screen.queryByText('No data in this range')).not.toBeInTheDocument();
      expect(container.querySelector('.skeleton')).toBeInTheDocument();
    });
  });

  it('stacked: plots running totals, while the legend, summary and data table keep each layer\'s own value', () => {
    seed([Date.now() / 1000 - 1], [[1], [10], [100]]);
    charts.stacked();
    runFrames(2);
    expect(newest.plot?.data.slice(1)).toEqual([[1], [11], [111]]);
    expect(within(screen.getByRole('list')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['GPU1 B', 'Processes10 B', 'Page cache100 B']);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Page cache latest 100 B');
    act(() => { screen.getByRole('button', { name: 'Memory: data table' }).click(); });
    const row = within(screen.getByRole('table')).getAllByRole('row')[1];
    expect(row && within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1 B', '10 B', '100 B']);
  });
});

describe('not-reported chart', () => {
  it('still names its series and thresholds, with the gap and its reason in the plot area', () => {
    const info = { unsupported: [{ metric: 'gpu*', kind: 'access', reason: 'Permission denied to the agent\'s user (NVML: Insufficient Permissions)' }] } as unknown as NodeInfo;
    useCluster.setState({ nodes: { noperm: { node_id: 'noperm', url: '', status: 'online', since: 0, last_sample_ts: null, error: null, info, next_retry_ts: null } } });
    render(<TimeSeriesChart node="noperm" title="noperm GPU temperature" series={[{ key: 'gpu0.temp_c', label: 'noperm' }]} format={(n) => `${n} °C`} range="live" legendValues="hover" thresholds={[{ value: 86, label: 'Slowdown 86 °C', tone: 'warn' }]} />);
    const legend = screen.getByRole('list', { name: 'noperm GPU temperature series' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['noperm—', 'Slowdown 86 °C']);
    expect(screen.getByText('No access')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Why is this not reported?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /data table/ })).not.toBeInTheDocument();
  });

  it('marks a series the agent declares not reported in the legend, and still plots the others', () => {
    const reason = 'Install nvidia-ml-py to read NVIDIA GPU metrics';
    const info = { unsupported: [{ metric: 'mem.gpu', kind: 'dependency', reason }] } as unknown as NodeInfo;
    useCluster.setState({ nodes: { nonvml: { node_id: 'nonvml', url: '', status: 'online', since: 0, last_sample_ts: null, error: null, info, next_retry_ts: null } } });
    render(<TimeSeriesChart node="nonvml" title="Unified memory used" series={[{ key: 'mem.used', label: 'Used' }, { key: 'mem.gpu', label: 'GPU-allocated' }]} format={(n) => `${n} B`} range="live" />);
    const [used, gpu] = within(screen.getByRole('list', { name: 'Unified memory used series' })).getAllByRole('listitem');
    expect(gpu).toHaveTextContent('GPU-allocatedHelper tool missing');
    expect(within(gpu as HTMLElement).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(reason);
    expect(used).toHaveTextContent('Used—');
    expect(screen.getByRole('button', { name: 'Unified memory used: data table' })).toBeInTheDocument();
  });
});

describe('sharedYMax', () => {
  it('gives every chart of a group the highest visible value, and forgets a chart that has no data', () => {
    const a = {};
    const b = {};
    expect(sharedYMax('g', a, 40)).toBe(40);
    expect(sharedYMax('g', b, 18)).toBe(40);
    expect(sharedYMax('g', a, 12)).toBe(18);
    expect(sharedYMax('g', a, -Infinity)).toBe(18);
    expect(sharedYMax(undefined, a, 7)).toBe(7);
  });
});
