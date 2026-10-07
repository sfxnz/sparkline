import { render } from '@testing-library/react';
import { LiveStore } from '../store/live';
import { sharedYMax, TimeSeriesChart } from './TimeSeriesChart';

// uPlot needs a real canvas: a stand-in that counts plots created and destroyed.
const plots = { created: 0, destroyed: 0 };
vi.mock('uplot', () => {
  class FakePlot {
    static pxRatio = 1;
    static fmtDate = () => () => '';
    static rangeNum = (lo: number, hi: number) => [lo, hi];
    bbox = { left: 0, top: 0, width: 600, height: 200 };
    cursor = { idx: null };
    scales = { x: { min: 0, max: 1 } };
    select = { width: 0 };
    constructor() { plots.created++; }
    setData() {}
    setScale() {}
    setSize() {}
    valToPos() { return 0; }
    destroy() { plots.destroyed++; }
  }
  return { default: FakePlot };
});

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
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
