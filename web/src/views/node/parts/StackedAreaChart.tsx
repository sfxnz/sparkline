// Stacked area chart for a part-to-whole series (unified memory breakdown). Same data paths and behaviour as
// TimeSeriesChart (live scroll from the LiveStore without React renders, history ranges, synced crosshair,
// drag-zoom, data table) but each layer sits on the ones below it. Candidate for promotion into charts/.
import { ChartLine, Table2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { ChartDataTable } from '../../../charts/ChartDataTable';
import { axisLabels, readChartTheme, timeAxis, useThemeVersion, withAlpha } from '../../../charts/theme';
import { Button, IconButton } from '../../../design/components/Button';
import { EmptyState } from '../../../design/components/EmptyState';
import { ProblemState } from '../../../design/components/ProblemState';
import { Skeleton } from '../../../design/components/Skeleton';
import { Tooltip } from '../../../design/components/Tooltip';
import { serverNow, useCluster } from '../../../store/cluster';
import { historyCache, RANGE_SECONDS, historyRefreshMs } from '../../../store/history';
import { liveStore } from '../../../store/live';
import { usePrefs } from '../../../store/prefs';
import '../../../charts/chart.css';

export interface StackSeries {
  key: string;
  label: string;
  /** CSS class that sets --seg (the layer colour), shared with the legend swatch. */
  className: string;
  /** Draw the layer hatched (reclaimable memory). */
  hatched?: boolean;
}

interface Props {
  node: string;
  title: string;
  /** Bottom layer first. */
  series: readonly StackSeries[];
  format: (n: number) => string;
  height?: number;
  /** Top of the y axis (e.g. total memory). */
  yMax?: number;
  /** Y-axis steps (e.g. BYTE_INCRS from charts/theme). */
  yIncrs?: readonly number[];
  liveWindowS?: number;
}

type LoadState = 'loading' | 'ready' | 'empty' | 'error';

/** Diagonal stripes for a reclaimable layer (matches the hatched page-cache segment of the memory bar). */
function hatch(color: string, gap: string): CanvasPattern | string {
  const c = document.createElement('canvas');
  const s = Math.round(8 * uPlot.pxRatio);
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  if (!ctx) return color;
  ctx.fillStyle = gap;
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.45;
  ctx.beginPath();
  for (const o of [-s, 0, s]) {
    ctx.moveTo(o, s);
    ctx.lineTo(o + s, 0);
  }
  ctx.stroke();
  return ctx.createPattern(c, 'repeat') ?? color;
}

/** Running totals bottom-up: out[k][i] = sum of layers 0..k at i (null where every layer so far is null). */
export function stack(values: readonly (readonly (number | null)[])[]): (number | null)[][] {
  const out: (number | null)[][] = [];
  values.forEach((layer, k) => {
    const below = out[k - 1];
    out.push(layer.map((v, i) => {
      const b = below?.[i] ?? null;
      if (v == null) return b;
      return (b ?? 0) + v;
    }));
  });
  return out;
}

/** Resolve a class's --seg colour against the current theme as rgb() (uPlot draws on canvas, and
 *  computed colour-mix() values are not in a form withAlpha understands). */
function segColor(className: string, host: HTMLElement): string {
  const probe = document.createElement('span');
  probe.className = className;
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--seg)';
  host.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx || !c) return c || '#888';
  ctx.fillStyle = c;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

export function StackedAreaChart({ node, title, series, format, height = 240, yMax, yIncrs, liveWindowS = 180 }: Props) {
  const range = usePrefs((s) => s.timeRange);
  const live = range === 'live';
  const nodeStatus = useCluster((s) => s.nodes[node]?.status);
  const themeVersion = useThemeVersion();
  const plotRef = useRef<HTMLDivElement>(null);
  const legendRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const rawRef = useRef<{ ts: number[]; values: (number | null)[][] }>({ ts: [], values: [] });
  const formatRef = useRef(format);
  const resetRef = useRef<() => void>(() => undefined);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [load, setLoad] = useState<{ id: string; state: LoadState }>({ id: '', state: 'loading' });
  const [summary, setSummary] = useState(title);
  const [table, setTable] = useState<{ ts: number[]; values: (number | null)[][] } | null>(null);
  const showTable = table !== null;
  const [reloadKey, setReloadKey] = useState(0);
  const tableId = useId();
  const keys = useMemo(() => series.map((s) => s.key), [series]);
  const keysId = keys.join('|');
  const classesId = series.map((s) => s.className).join('|');
  const dataId = `${node}|${keysId}|${range}|${reloadKey}`;
  const state = load.id === dataId ? load.state : 'loading';

  useEffect(() => {
    formatRef.current = format;
  }, [format]);

  const paintLegend = useCallback((idx: number | null | undefined) => {
    const { ts, values } = rawRef.current;
    const i = idx ?? (ts.length ? ts.length - 1 : null);
    legendRefs.current.forEach((el, k) => {
      if (!el) return;
      const v = i === null ? null : values[k]?.[i];
      el.textContent = v == null ? '—' : formatRef.current(v);
    });
  }, []);

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const theme = readChartTheme();
    const k = theme.fontPx / 11;
    const ks = keysId.split('|');
    const classes = classesId.split('|');
    const solid = classes.map((c) => segColor(c, el));
    const colors = solid.map((c, i) => (series[i]?.hatched ? hatch(c, withAlpha(c, 0.35)) : c));
    const labels = series.map((s) => s.label);
    const set = (s: LoadState) => { setLoad((p) => (p.id === dataId && p.state === s ? p : { id: dataId, state: s })); };

    const toPlot = (): uPlot.AlignedData => [rawRef.current.ts, ...stack(rawRef.current.values)];
    const opts: uPlot.Options = {
      width: Math.max(100, el.clientWidth),
      height,
      pxAlign: 0,
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(yMax ?? 0, max, 1)] } },
      legend: { show: false },
      padding: [8, 16, 0, 0],
      axes: [
        { stroke: theme.axis, font: theme.font, grid: { stroke: theme.grid, width: 1 }, ticks: { show: false }, gap: 6, size: Math.round(28 * k), ...timeAxis(range, k) }, // same ticks as TimeSeriesChart
        {
          stroke: theme.axis,
          font: theme.font,
          grid: { stroke: theme.grid, width: 1 },
          ticks: { show: false },
          gap: 8,
          size: Math.round(64 * k),
          space: Math.round(32 * k),
          ...(yIncrs ? { incrs: [...yIncrs] } : {}),
          values: (_u, splits) => axisLabels(splits, formatRef.current),
        },
      ],
      series: [
        {},
        ...ks.map((_, i): uPlot.Series => ({
          label: labels[i],
          // A thin surface-coloured top edge separates the layers (the 2px gap of a stacked bar).
          stroke: theme.surface,
          width: 1.25,
          fill: colors[i],
          points: { show: false },
          spanGaps: false,
        })),
      ],
      // Each layer fills down to the one beneath it.
      bands: ks.slice(1).map((_, i) => ({ series: [i + 2, i + 1] as [number, number], fill: colors[i + 1] })),
      cursor: {
        sync: { key: 'spark', setSeries: false, filters: { pub: (type) => type !== 'mousedown' && type !== 'mouseup' } },
        drag: { x: true, y: false, setScale: true },
        y: false,
        points: { show: false },
        bind: { dblclick: () => () => { resetRef.current(); return null; } },
      },
      hooks: {
        setCursor: [(u) => { paintLegend(u.cursor.idx); }],
        setSelect: [(u) => { if (u.select.width > 0 && !pausedRef.current) { pausedRef.current = true; setPaused(true); } }],
      },
    };
    const u = new uPlot(opts, toPlot(), el);
    const resetView = () => {
      const now = serverNow();
      u.setScale('x', { min: now - (live ? liveWindowS : RANGE_SECONDS[range]), max: now });
    };
    resetRef.current = () => { pausedRef.current = false; setPaused(false); resetView(); };
    const summarizeNow = () => {
      const { values } = rawRef.current;
      const parts = labels.map((l, i) => {
        const vs = values[i] ?? [];
        const last = [...vs].reverse().find((v) => v != null);
        return `${l} ${last == null ? 'no data' : formatRef.current(last)}`;
      });
      setSummary(`${title}, ${live ? 'live' : range}. Latest: ${parts.join(', ')}.`);
    };
    const ro = new ResizeObserver(() => { u.setSize({ width: Math.max(100, el.clientWidth), height }); });
    ro.observe(el);

    const cleanups: (() => void)[] = [];
    if (live) {
      let dirty = true;
      let raf = 0;
      let visible = true;
      let lastNow = 0;
      let lastSummary = 0;
      const frame = () => {
        raf = 0;
        if (!visible || document.hidden) return;
        raf = requestAnimationFrame(frame);
        if (pausedRef.current) return;
        const now = serverNow();
        const pxPerSec = u.bbox.width / uPlot.pxRatio / liveWindowS;
        if (!dirty && (now - lastNow) * pxPerSec < 0.5) return;
        if (dirty) {
          const w = liveStore.window(node, ks, now - liveWindowS - 5);
          rawRef.current = w;
          u.setData(toPlot(), false);
          if (u.cursor.idx == null) paintLegend(null);
          set(w.ts.length ? 'ready' : 'empty');
          if (performance.now() - lastSummary > 5000) { lastSummary = performance.now(); summarizeNow(); }
          dirty = false;
        }
        lastNow = now;
        u.setScale('x', { min: now - liveWindowS, max: now });
      };
      const start = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame); };
      const io = new IntersectionObserver((e) => { visible = e.some((x) => x.isIntersecting); start(); });
      io.observe(el);
      const onVis = () => { start(); };
      document.addEventListener('visibilitychange', onVis);
      const unsub = liveStore.subscribeSample(node, () => { dirty = true; start(); });
      start();
      cleanups.push(() => { if (raf) cancelAnimationFrame(raf); io.disconnect(); document.removeEventListener('visibilitychange', onVis); unsub(); });
    } else {
      let cancelled = false;
      const fetchOnce = () => {
        historyCache
          .load(node, ks, range, serverNow())
          .then((r) => {
            if (cancelled) return;
            rawRef.current = { ts: r.ts, values: ks.map((key) => r.series[key] ?? r.ts.map(() => null)) };
            u.setData(toPlot(), false);
            if (!pausedRef.current) resetView();
            paintLegend(null);
            summarizeNow();
            set(r.ts.length ? 'ready' : 'empty');
          })
          .catch(() => { if (!cancelled) set('error'); });
      };
      fetchOnce();
      const timer = setInterval(fetchOnce, historyRefreshMs(range));
      cleanups.push(() => { cancelled = true; clearInterval(timer); });
    }
    return () => {
      cleanups.forEach((f) => { f(); });
      ro.disconnect();
      u.destroy();
    };
    // keysId/classesId stand in for `series`; formatting goes through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, keysId, classesId, range, live, liveWindowS, height, yMax, yIncrs, themeVersion, dataId, paintLegend, title]);

  const nodeStale = live && (nodeStatus === 'stale' || nodeStatus === 'offline' || nodeStatus === 'error');
  const overlay = state === 'ready' ? null : state;

  return (
    <figure className={`tschart${nodeStale ? ' tschart--stale' : ''}`}>
      <figcaption className="tschart__head">
        <ul className="stack__legend" aria-label={`${title} layers`}>
          {series.map((s, i) => (
            <li key={s.key} className="stack__legend-item">
              <span className={`stack__swatch ${s.className}`} aria-hidden="true" />
              <span className="tschart__legend-label">{s.label}</span>
              <span className="tschart__legend-value num" ref={(r) => { legendRefs.current[i] = r; }}>—</span>
            </li>
          ))}
        </ul>
        <div className="tschart__actions">
          {paused ? (
            <Button size="sm" variant="secondary" icon={<Undo2 />} onClick={() => { resetRef.current(); }}>
              {live ? 'Back to live' : 'Reset zoom'}
            </Button>
          ) : null}
          <Tooltip content={showTable ? 'Hide data table' : 'Show data table'} placement="bottom">
            <IconButton
              size="sm"
              aria-label={`${title}: data table`}
              aria-expanded={showTable}
              aria-controls={tableId}
              icon={<Table2 />}
              className={showTable ? 'is-pressed' : undefined}
              onClick={() => { setTable(showTable ? null : { ts: [...rawRef.current.ts], values: rawRef.current.values.map((v) => [...v]) }); }}
            />
          </Tooltip>
        </div>
      </figcaption>
      <div className="tschart__plot-wrap" style={{ height }}>
        <div ref={plotRef} className={`tschart__plot${overlay ? ' tschart__plot--hidden' : ''}`} role="img" aria-label={summary} />
        {overlay === 'loading' ? (
          <div className="tschart__overlay" aria-hidden="true"><Skeleton height={height - 36} radius={10} /></div>
        ) : overlay === 'empty' ? (
          <div className="tschart__overlay">
            <EmptyState icon={ChartLine} title="No data in this range" compact>Samples will appear here as soon as {node} reports them.</EmptyState>
          </div>
        ) : overlay === 'error' ? (
          <div className="tschart__overlay">
            <ProblemState compact message="History unavailable" fix="The console could not return history for this range. Retry, or switch to Live." onRetry={() => { historyCache.clear(); setReloadKey((x) => x + 1); }} />
          </div>
        ) : null}
      </div>
      {table ? (
        <ChartDataTable
          id={tableId}
          caption={`${title} — ${live ? 'snapshot of the visible window' : range}`}
          ts={table.ts}
          series={series.map((s, i) => ({ label: s.label, values: table.values[i] ?? [] }))}
          format={format}
        />
      ) : null}
    </figure>
  );
}
