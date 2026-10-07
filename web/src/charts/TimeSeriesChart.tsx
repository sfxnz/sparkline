// uPlot time series bound to the LiveStore (live) or the history loader (5m/1h/24h/7d).
// Live mode scrolls continuously: the x scale moves to [now - window, now] in the animation frame after the scroll
// has moved half a pixel or new data arrived (sleeping in between), and stops entirely while offscreen or while
// the tab is hidden. Data is copied from the ring buffers once per sample, never through React state.
import { Table2, Undo2 } from 'lucide-react';
import { Tooltip } from '../design/components/Tooltip';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { Button, IconButton } from '../design/components/Button';
import { HistoryUnavailable } from './HistoryUnavailable';
import { NoDataInRange } from './NoDataInRange';
import { Skeleton } from '../design/components/Skeleton';
import { Unsupported } from '../design/components/Unsupported';
import { useNow } from '../design/useNow';
import { formatAgo } from '../lib/format';
import type { TimeRange } from '../lib/prefs';
import type { NodeInfo } from '../lib/types';
import { serverNow, useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { historyCache, historyRefreshMs, RANGE_SECONDS } from '../store/history';
import { liveStore, type LiveStore } from '../store/live';
import { usePrefs } from '../store/prefs';
import { ChartDataTable } from './ChartDataTable';
import { insertGaps } from './gaps';
import { axisLabels, readChartTheme, summarize, timeAxis, useThemeVersion, withAlpha } from './theme';
import './chart.css';

export interface SeriesSpec {
  key: string;
  label: string;
}

export interface Threshold {
  value: number;
  label: string;
  tone: 'warn' | 'crit';
}

interface Props {
  node: string;
  /** Accessible name and data-table caption: "GPU temperature". */
  title: string;
  series: readonly SeriesSpec[];
  /** Value -> text with unit ("72 °C"). Used for axis, legend, summary and table. */
  format: (n: number) => string;
  /** Defaults to the global time-range preference. */
  range?: TimeRange;
  liveWindowS?: number;
  height?: number;
  /** Always include these in the y range (e.g. 0 and 100 for percentages). */
  yMin?: number;
  yMax?: number;
  /** Y-axis steps, e.g. BYTE_INCRS (from ./theme) for byte values. */
  yIncrs?: readonly number[];
  thresholds?: readonly Threshold[];
  /** Charts with the same group share one y ceiling (the highest visible value among them), so small multiples
   *  compare by eye: equal heights mean equal values. */
  yGroup?: string;
  /** Force the unsupported state with this reason (otherwise derived from NodeInfo.unsupported). */
  unsupported?: string;
  /** 'hover': in Live mode the legend shows values only under the cursor, for panels whose stats already show the
   *  current values right above the chart (the same number twice, a frame apart, reads as two numbers). */
  legendValues?: 'always' | 'hover';
  store?: LiveStore;
}

type LoadState = 'loading' | 'ready' | 'empty' | 'error';

export const LIVE_WINDOW_S = 180;
const SYNC_KEY = 'spark';

const RANGE_LABEL: Record<TimeRange, string> = {
  live: 'live',
  '5m': 'last 5 minutes',
  '1h': 'last hour',
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
};

const fmtLegendTime = uPlot.fmtDate('{HH}:{mm}');
const fmtLegendDay = uPlot.fmtDate('{D} {MMM} {HH}:{mm}');
/** "16:20", or "3 Oct 16:20" for a moment that is not today. */
function legendTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toDateString() === new Date().toDateString() ? fmtLegendTime(d) : fmtLegendDay(d);
}

/** Per y group: each chart's highest visible value (keyed by a token per plot). */
const yGroups = new Map<string, Map<object, number>>();

/** Record `self`'s visible maximum in `group` and return the group's maximum (just `dmax` without a group). */
export function sharedYMax(group: string | undefined, self: object, dmax: number): number {
  if (!group) return dmax;
  let g = yGroups.get(group);
  if (!g) yGroups.set(group, (g = new Map<object, number>()));
  if (Number.isFinite(dmax)) g.set(self, dmax);
  else g.delete(self);
  let top = dmax;
  for (const v of g.values()) top = Number.isFinite(top) ? Math.max(top, v) : v;
  return top;
}

/** Reason a metric key is not reported by this node, if listed in NodeInfo.unsupported (exact key or prefix). */
export function unsupportedReason(info: NodeInfo | null | undefined, key: string): string | null {
  const u = info?.unsupported.find((x) => key === x.metric || key.startsWith(`${x.metric}.`));
  return u?.reason ?? null;
}

export function TimeSeriesChart({
  node,
  title,
  series,
  format,
  range: rangeProp,
  liveWindowS = LIVE_WINDOW_S,
  height = 200,
  yMin,
  yMax,
  yIncrs,
  thresholds,
  yGroup,
  unsupported: unsupportedProp,
  legendValues = 'always',
  store = liveStore,
}: Props) {
  const prefRange = usePrefs((s) => s.timeRange);
  const range = rangeProp ?? prefRange;
  const live = range === 'live';
  const info = useCluster((s) => s.nodes[node]?.info);
  const nodeStatus = useCluster((s) => s.nodes[node]?.status);
  const connStatus = useConnection((s) => s.status);
  const themeVersion = useThemeVersion();

  const plotRef = useRef<HTMLDivElement>(null);
  const legendRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const legendTimeRef = useRef<HTMLSpanElement>(null);
  const liveRef = useRef(live);
  const nodeStale = nodeStatus === 'stale' || nodeStatus === 'offline' || nodeStatus === 'error';
  /** The node stopped reporting (or the browser lost the console): its latest point is not "now". */
  const notNow = nodeStale || connStatus !== 'live';
  const staleRef = useRef(notNow);
  /** The "Last updated N s ago" badge is showing: it already dates the idle legend, so the time is left out. */
  const badgeRef = useRef(nodeStale && live);
  const hoverOnlyRef = useRef(legendValues === 'hover');
  const uRef = useRef<uPlot | null>(null);
  const dataRef = useRef<uPlot.AlignedData>([[]]);
  const formatRef = useRef(format);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  // Load state is tagged with the data identity it belongs to; anything else reads as 'loading'.
  const [loadTagged, setLoadTagged] = useState<{ id: string; state: LoadState }>({ id: '', state: 'loading' });
  const [error, setError] = useState<unknown>(null);
  const [summary, setSummary] = useState(title);
  const [showTable, setShowTable] = useState(false);
  const [tableData, setTableData] = useState<{ ts: number[]; values: (number | null)[][] } | null>(null);
  const tableId = useId();
  /** Set by the plot effect: return to live / the full range. */
  const resetRef = useRef<() => void>(() => undefined);

  const [reloadKey, setReloadKey] = useState(0);
  // Keyed by content, not identity: callers pass a fresh `series` literal on every render, and a new array here
  // would destroy and rebuild the plot on every sample.
  const keysId = JSON.stringify(series.map((s) => s.key));
  const keys = useMemo(() => JSON.parse(keysId) as string[], [keysId]);
  const dataId = `${node}|${keysId}|${range}|${reloadKey}`;
  const load = loadTagged.id === dataId ? loadTagged.state : 'loading';
  const labelsId = JSON.stringify(series.map((s) => s.label));
  const labels = useMemo(() => JSON.parse(labelsId) as string[], [labelsId]);
  const thresholdsId = JSON.stringify(thresholds ?? []);
  const unsupported =
    unsupportedProp ?? (keys.length && keys.every((k) => unsupportedReason(info, k)) ? unsupportedReason(info, keys[0] ?? '') : null);

  useEffect(() => {
    formatRef.current = format;
  }, [format]);
  useEffect(() => {
    liveRef.current = live;
    hoverOnlyRef.current = legendValues === 'hover';
  }, [live, legendValues]);

  /** Legend values: at the cursor, or the latest point when the cursor is idle. */
  const paintLegend = useCallback((idx: number | null | undefined) => {
    const d = dataRef.current;
    const xs = d[0];
    const i = idx ?? (xs.length ? xs.length - 1 : null);
    const blank = liveRef.current && idx == null && hoverOnlyRef.current;
    legendRefs.current.forEach((el, k) => {
      if (!el) return;
      const v = i === null ? null : d[k + 1]?.[i];
      el.textContent = blank ? '' : v == null || Number.isNaN(v) ? '—' : formatRef.current(v);
    });
    // Always say which moment the values are: "now" when live and idle, else the time under the cursor (or of the
    // last bucket), so a latest sample is never read as an average shown nearby and the last bucket of a 24 h chart is
    // never mistaken for the live value.
    const t = legendTimeRef.current;
    const ts = i === null ? undefined : xs[i];
    if (t) t.textContent = blank || ts === undefined || (idx == null && badgeRef.current) ? '' : liveRef.current && idx == null && !staleRef.current ? 'now' : `at ${legendTime(ts)}`;
  }, []);

  useEffect(() => {
    staleRef.current = notNow;
    badgeRef.current = nodeStale && live;
    paintLegend(null);
  }, [notNow, nodeStale, live, paintLegend]);

  const updateSummary = useCallback(() => {
    const d = dataRef.current;
    const parts = labels.map((label, k) => {
      const s = summarize((d[k + 1] ?? []) as ArrayLike<number | null>);
      const f = formatRef.current;
      return s.latest === null ? `${label}: no data` : `${label} latest ${f(s.latest)}, min ${f(s.min ?? 0)}, max ${f(s.max ?? 0)}`;
    });
    setSummary(`${title}, ${live ? `last ${Math.round(liveWindowS / 60)} minutes` : RANGE_LABEL[range]}. ${parts.join('; ')}.`);
  }, [labels, title, live, liveWindowS, range]);

  const snapshotTable = useCallback(() => {
    const u = uRef.current;
    const d = dataRef.current;
    const xs = Array.from(d[0]);
    const min = u?.scales.x?.min ?? -Infinity;
    const max = u?.scales.x?.max ?? Infinity;
    const idx = xs.map((t, i) => (t >= min && t <= max ? i : -1)).filter((i) => i >= 0);
    setTableData({
      ts: idx.map((i) => xs[i] ?? 0),
      values: keys.map((_, k) => idx.map((i) => {
        const v = d[k + 1]?.[i];
        return v == null || Number.isNaN(v) ? null : v;
      })),
    });
  }, [keys]);
  const showTableRef = useRef(showTable);
  useEffect(() => {
    showTableRef.current = showTable;
  }, [showTable]);

  // Create / destroy the uPlot instance.
  useEffect(() => {
    const el = plotRef.current;
    if (!el || unsupported) return;
    const theme = readChartTheme();
    const k = theme.fontPx / 11; // axis room grows with the user's font size
    // Same tag and state => same object, so React skips the render: only transitions re-render, not every sample.
    const setLoad = (state: LoadState) => { setLoadTagged((prev) => (prev.id === dataId && prev.state === state ? prev : { id: dataId, state })); };
    const thresholdList: Threshold[] = JSON.parse(thresholdsId) as Threshold[];
    let programmatic = false;

    const yToken = {};
    const yRange: uPlot.Range.Function = (_u, dmin, dataMax) => {
      const dmax = sharedYMax(yGroup, yToken, dataMax);
      const lo = Math.min(dmin, yMin ?? dmin);
      const hi = Math.max(dmax, yMax ?? dmax);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [yMin ?? 0, yMax ?? 1];
      if (yMin !== undefined && yMax !== undefined && dmin >= yMin && dmax <= yMax) return [yMin, yMax];
      return uPlot.rangeNum(lo, hi === lo ? lo + 1 : hi, 0.1, true);
    };

    const opts: uPlot.Options = {
      width: Math.max(100, el.clientWidth),
      height,
      pxAlign: 0,
      scales: { x: { time: true }, y: { range: yRange } },
      legend: { show: false },
      padding: [8, Math.round(28 * k), 0, 0], // room for the newest time label, centred on the right edge
      axes: [
        {
          stroke: theme.axis,
          font: theme.font,
          grid: { stroke: theme.grid, width: 1 },
          ticks: { show: false },
          gap: 6,
          size: Math.round(28 * k),
          ...timeAxis(range, k),
        },
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
        ...labels.map((label, i): uPlot.Series => {
          const color = theme.series[i % theme.series.length] ?? theme.axis;
          return {
            label,
            stroke: color,
            width: 1.75,
            points: { show: false },
            spanGaps: false,
            fill:
              i === 0
                ? (u) => {
                    const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
                    g.addColorStop(0, withAlpha(color, 0.2));
                    g.addColorStop(1, withAlpha(color, 0));
                    return g;
                  }
                : undefined,
          };
        }),
      ],
      cursor: {
        // The crosshair is synced; drag-zoom is not (mousedown/mouseup stay local), so zoom and its reset
        // (double-click, "Back to live") always apply to the same single chart.
        sync: { key: SYNC_KEY, setSeries: false, filters: { pub: (type) => type !== 'mousedown' && type !== 'mouseup' } },
        drag: { x: true, y: false, setScale: true },
        y: false,
        points: {
          size: 8,
          width: 2,
          fill: (u, si) => (u.series[si]?.stroke as string | undefined) ?? theme.axis,
          stroke: () => theme.surface,
        },
        bind: {
          // Double-click: back to live (or to the full range), instead of uPlot's autoscale.
          dblclick: () => () => {
            resetRef.current();
            return null;
          },
        },
      },
      hooks: {
        setCursor: [(u) => { paintLegend(u.cursor.idx); }],
        // A drag selection is the only user zoom; it pauses live scrolling until "Back to live" / double-click.
        setSelect: [
          (u) => {
            if (u.select.width > 0 && !pausedRef.current) {
              pausedRef.current = true;
              setPaused(true);
            }
          },
        ],
        setScale: [
          (_u, key) => {
            if (key === 'x' && showTableRef.current && !programmatic) snapshotTable();
          },
        ],
        // Threshold lines only: their labels sit in the legend row (a reserved gutter), so the data line never
        // crosses the text and two close thresholds never collide.
        draw: [
          (u) => {
            if (!thresholdList.length) return;
            const ctx = u.ctx;
            const { left, top, width, height: h } = u.bbox;
            const dpr = uPlot.pxRatio;
            ctx.save();
            for (const t of thresholdList) {
              const y = Math.round(u.valToPos(t.value, 'y', true)) + 0.5;
              if (y < top || y > top + h) continue;
              ctx.strokeStyle = t.tone === 'crit' ? theme.crit : theme.warn;
              ctx.lineWidth = dpr;
              ctx.setLineDash([4 * dpr, 4 * dpr]);
              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(left + width, y);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
      },
    };

    const u = new uPlot(opts, dataRef.current, el);
    uRef.current = u;

    const setX = (min: number, max: number) => {
      programmatic = true;
      u.setScale('x', { min, max });
      programmatic = false;
    };
    function resetView() {
      const now = serverNow();
      const span = live ? liveWindowS : RANGE_SECONDS[range];
      setX(now - span, now);
    }
    /** Restarts the live scroll loop (set below in Live mode). */
    let resume: () => void = () => undefined;
    resetRef.current = () => {
      pausedRef.current = false;
      setPaused(false);
      resetView();
      resume();
    };

    const ro = new ResizeObserver(() => {
      u.setSize({ width: Math.max(100, el.clientWidth), height });
    });
    ro.observe(el);

    // Data + continuous scroll.
    const cleanups: (() => void)[] = [];
    if (live) {
      let dirty = true;
      let lastNow = 0;
      let raf = 0;
      let timer = 0;
      let visible = true;
      let lastSummary = 0;
      let state: LoadState = 'loading';
      const pull = () => {
        const raw = store.window(node, keys, serverNow() - liveWindowS - 5);
        const w = insertGaps(raw.ts, raw.values, (store.latest(node)?.interval_ms ?? 1000) / 1000, 3);
        dataRef.current = [w.ts, ...w.values];
        // Nothing buffered for an online node yet (the bootstrap or first sample is on its way) is loading, not
        // empty: "No data in this range" only when the node has data but not for these keys, or is not online.
        const online = useCluster.getState().nodes[node]?.status === 'online';
        state = w.ts.length ? 'ready' : store.lastTs(node) !== null || !online ? 'empty' : 'loading';
        setLoad(state);
        return state;
      };
      // The loop sleeps between redraws instead of polling every frame: a pending animation frame makes the
      // browser run a full main-thread frame (style for every running CSS animation included) at 60 Hz, while the
      // scroll only needs a redraw each time it has moved half a pixel. Wake-ups sit on a shared grid
      // (multiples of the interval), so the charts of one screen redraw in the same frame. New data wakes it at once.
      const sleep = (pxPerSec: number) => {
        const step = Math.max(16, 500 / Math.max(pxPerSec, 1e-3));
        const t = performance.now();
        timer = window.setTimeout(() => {
          timer = 0;
          start();
        }, Math.ceil((t + 1) / step) * step - t);
      };
      const frame = () => {
        raf = 0;
        if (!visible || document.hidden || pausedRef.current) return;
        const now = serverNow();
        const pxPerSec = u.bbox.width / uPlot.pxRatio / liveWindowS;
        sleep(pxPerSec);
        if (!dirty && (now - lastNow) * pxPerSec < 0.5) return;
        if (dirty) {
          pull();
          u.setData(dataRef.current, false);
          if (u.cursor.idx == null) paintLegend(null);
          const t = performance.now();
          if (t - lastSummary > 5000) {
            lastSummary = t;
            updateSummary();
          }
          if (showTableRef.current) snapshotTable();
          dirty = false;
        }
        lastNow = now;
        setX(now - liveWindowS, now);
      };
      const start = () => {
        if (!raf && !timer && visible && !document.hidden) raf = requestAnimationFrame(frame);
      };
      const wake = () => {
        if (timer) clearTimeout(timer);
        timer = 0;
        start();
      };
      resume = wake;
      const io = new IntersectionObserver((entries) => {
        visible = entries.some((e) => e.isIntersecting);
        start();
      });
      io.observe(el);
      const onVis = () => { start(); };
      document.addEventListener('visibilitychange', onVis);
      const unsub = store.subscribeSample(node, () => {
        dirty = true;
        // Offscreen charts do not draw, but their overlay and summary must not keep saying "no data" once data
        // has arrived: a cheap pull settles the state, and the plot draws on intersect.
        if (!visible && state !== 'ready' && pull() === 'ready') updateSummary();
        wake();
      });
      pull();
      u.setData(dataRef.current, false);
      resetView();
      paintLegend(null);
      updateSummary();
      start();
      cleanups.push(() => {
        if (raf) cancelAnimationFrame(raf);
        if (timer) clearTimeout(timer);
        io.disconnect();
        document.removeEventListener('visibilitychange', onVis);
        unsub();
      });
    } else {
      let cancelled = false;
      const fetchOnce = () => {
        historyCache
          .load(node, keys, range, serverNow())
          .then((resp) => {
            if (cancelled) return;
            const w = insertGaps(resp.ts, keys.map((k) => resp.series[k] ?? resp.ts.map(() => null)));
            dataRef.current = [w.ts, ...w.values];
            u.setData(dataRef.current, false);
            if (!pausedRef.current) resetView();
            paintLegend(null);
            updateSummary();
            setLoad(resp.ts.length ? 'ready' : 'empty');
            setError(null);
          })
          .catch((e: unknown) => {
            if (cancelled) return;
            setError(e);
            setLoad('error');
          });
      };
      // The summary names the new range at once (no longer "last 3 minutes" while the history loads).
      dataRef.current = [[]];
      updateSummary();
      fetchOnce();
      const timer = setInterval(fetchOnce, historyRefreshMs(range));
      cleanups.push(() => {
        cancelled = true;
        clearInterval(timer);
      });
    }

    return () => {
      cleanups.forEach((f) => { f(); });
      ro.disconnect();
      u.destroy();
      uRef.current = null;
      if (yGroup) yGroups.get(yGroup)?.delete(yToken);
    };
    // `keysId`/`thresholdsId` stand in for the arrays; formatting goes through refs so it never recreates the plot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, keysId, labels, range, live, liveWindowS, height, yMin, yMax, yIncrs, yGroup, thresholdsId, themeVersion, unsupported, store, reloadKey, dataId, updateSummary, snapshotTable, paintLegend]);

  if (unsupported) {
    return (
      <figure className="tschart" aria-label={title}>
        <div className="tschart__plot tschart__plot--empty" style={{ height }}>
          <Unsupported reason={unsupported} block />
        </div>
      </figure>
    );
  }

  const waiting = load === 'loading' || (live && load === 'empty' && (connStatus !== 'live' || nodeStatus === 'connecting' || !nodeStatus));
  const overlay = waiting ? 'loading' : load === 'empty' ? 'empty' : load === 'error' ? 'error' : null;

  return (
    <figure className={`tschart${nodeStale && live ? ' tschart--stale' : ''}`}>
      <figcaption className="tschart__head">
        <ul className="tschart__legend" aria-label={`${title} series`}>
          {series.map((s, i) => (
            <li key={s.key} className="tschart__legend-item">
              <span className={`tschart__swatch tschart__swatch--${i % 4}`} aria-hidden="true" />
              <span className="tschart__legend-label">{s.label}</span>
              <span className="tschart__legend-value num" ref={(r) => { legendRefs.current[i] = r; }}>—</span>
            </li>
          ))}
          {thresholds?.map((t) => (
            <li key={`${t.label}${t.value}`} className={`tschart__legend-item tschart__threshold tone-${t.tone}`}>
              <span className="tschart__swatch tschart__swatch--dashed" aria-hidden="true" />
              <span className="tschart__legend-label">{t.label}</span>
            </li>
          ))}
        </ul>
        <div className="tschart__actions">
          {/* Which moment the legend values are ("now", or the time under the cursor): at the row's end, so it never
              wraps the legend onto a second line. */}
          <span className="tschart__legend-time num" aria-hidden="true"><span ref={legendTimeRef} /></span>
          {nodeStale && live ? <StaleBadge node={node} store={store} /> : null}
          {paused ? (
            <Button size="sm" variant="secondary" icon={<Undo2 />} onClick={() => { resetRef.current(); }} className="tschart__chip">
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
              onClick={() => {
                if (!showTable) snapshotTable();
                setShowTable(!showTable);
              }}
            />
          </Tooltip>
        </div>
      </figcaption>
      <div className="tschart__plot-wrap" style={{ height }}>
        <div ref={plotRef} className={`tschart__plot${overlay ? ' tschart__plot--hidden' : ''}`} role="img" aria-label={summary} />
        {overlay === 'loading' ? (
          <div className="tschart__overlay" aria-hidden="true">
            <Skeleton height={height - 36} radius={10} />
          </div>
        ) : overlay === 'empty' ? (
          <div className="tschart__overlay">
            <NoDataInRange node={node} offerLive={rangeProp === undefined} />
          </div>
        ) : overlay === 'error' ? (
          <div className="tschart__overlay">
            <HistoryUnavailable node={node} error={error} offerLive={rangeProp === undefined} onRetry={() => { historyCache.clear(); setReloadKey((k) => k + 1); }} />
          </div>
        ) : null}
      </div>
      {showTable && tableData ? (
        <ChartDataTable
          id={tableId}
          caption={`${title} — ${live ? 'visible window' : RANGE_LABEL[range]}`}
          ts={tableData.ts}
          series={series.map((s, k) => ({ label: s.label, values: tableData.values[k] ?? [] }))}
          format={format}
        />
      ) : null}
    </figure>
  );
}

function StaleBadge({ node, store }: { node: string; store: LiveStore }) {
  const now = useNow(1000);
  const last = store.lastTs(node);
  return (
    <span className="tschart__stale num">
      {last ? `Last updated ${formatAgo(last, now / 1000 + useCluster.getState().clockOffset)}` : 'No recent data'}
    </span>
  );
}
