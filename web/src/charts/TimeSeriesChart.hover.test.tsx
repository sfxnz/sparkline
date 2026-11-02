import { act, render } from '@testing-library/react';
import type { NodeState } from '../lib/types';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { liveStore } from '../store/live';
import { usePrefs } from '../store/prefs';
import { TimeSeriesChart } from './TimeSeriesChart';

beforeAll(() => {
  const noop = () => undefined;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(this: HTMLCanvasElement) {
    const props: Record<string | symbol, unknown> = { canvas: this };
    return new Proxy(props, {
      get: (t, p) => {
        if (p in t) return t[p];
        if (p === 'measureText') return (s: string) => ({ width: s.length * 6 });
        if (p === 'createLinearGradient' || p === 'createPattern') return () => ({ addColorStop: noop });
        return noop;
      },
      set: (t, p, v) => {
        t[p] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} rect() {} arc() {} closePath() {} bezierCurveTo() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('hovering a live chart', () => {
  const NODE = 'htest';
  const LAYERS = [
    { key: 'mem.gpu', label: 'GPU', className: 'mem-c-gpu' },
    { key: 'mem.anon', label: 'Processes', className: 'mem-c-anon' },
  ];
  const node: NodeState = { node_id: NODE, url: '', status: 'online', since: 0, last_sample_ts: null, error: null, info: null, next_retry_ts: null };

  beforeEach(() => {
    usePrefs.setState({ timeRange: 'live' });
    useConnection.setState({ status: 'live', everLive: true });
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
    const now = Date.now() / 1000;
    liveStore.removeNode(NODE);
    liveStore.seed({ node_id: NODE, resolution_s: 1, ts: [now - 2, now - 1], series: { 'mem.gpu': [1, 1], 'mem.anon': [2, 2] }, min: {}, max: {} });
    liveStore.flush();
  });

  const hoverDots = async (container: HTMLElement) => {
    // uPlot applies new data and scales in a microtask.
    await act(async () => { await Promise.resolve(); });
    const over = container.querySelector('.u-over');
    if (!over) throw new Error('no plot');
    act(() => { over.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 50 })); });
    return Array.from(container.querySelectorAll<HTMLElement>('.u-cursor-pt'));
  };

  it('lines: marks each series at the cursor with a dot', async () => {
    const { container } = render(<TimeSeriesChart node={NODE} title="Memory" series={LAYERS} format={String} />);
    const dots = await hoverDots(container);
    expect(dots).toHaveLength(2);
    expect(dots.map((d) => d.style.transform), 'no dot left parked off the plot').not.toContain('translate(-10px,-10px)');
  });

  it('stacked: shows no dots', async () => {
    const { container } = render(<TimeSeriesChart node={NODE} title="Memory" stack series={LAYERS} format={String} />);
    expect(await hoverDots(container)).toHaveLength(0);
  });
});
