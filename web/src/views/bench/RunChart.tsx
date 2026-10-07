// uPlot chart for a benchmark run: one series per node, the x range spanning the run (to its ETA while it runs),
// and markers at the run's start and finish. Data arrives as props (the run view refreshes it at most once a second);
// the plot is created once per shape/theme and only re-fed with setData. Crosshair is synced with the other charts.
import { Table2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { ChartDataTable } from '../../charts/ChartDataTable';
import { axisLabels, readChartTheme, summarize, useThemeVersion, withAlpha } from '../../charts/theme';
import '../../charts/chart.css';
import { IconButton } from '../../design/components/Button';
import { Skeleton } from '../../design/components/Skeleton';
import { Tooltip } from '../../design/components/Tooltip';

export interface ChartSeries {
  label: string;
  values: readonly (number | null)[];
}
export interface Marker {
  ts: number;
  label: string;
}

interface Props {
  title: string;
  ts: readonly number[];
  series: readonly ChartSeries[];
  format: (n: number) => string;
  /** Visible x range (epoch seconds). Defaults to the data's extent. */
  xRange?: readonly [number, number] | null;
  markers?: readonly Marker[];
  height?: number;
  yMin?: number;
  yMax?: number;
  /** Smallest y span shown: a near-flat series (52-53 °C) would otherwise give a single, repeated tick label. */
  ySpan?: number;
  /** Shown instead of the plot while the data is on its way. */
  loading?: boolean;
  /** Shown (with the legend) when there is no data at all. */
  emptyText?: string;
}

const fmtHms = uPlot.fmtDate('{HH}:{mm}:{ss}');
const fmtHm = uPlot.fmtDate('{HH}:{mm}');

export function RunChart({ title, ts, series, format, xRange, markers = [], height = 160, yMin, yMax, ySpan, loading, emptyText = 'No samples for this run' }: Props) {
  const plotRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const legendRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const formatRef = useRef(format);
  const rangeRef = useRef(xRange);
  const markersRef = useRef(markers);
  const dataRef = useRef<uPlot.AlignedData>([[]]);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const themeVersion = useThemeVersion();
  const labels = useMemo(() => series.map((s) => s.label), [series]);
  const labelsId = labels.join('\u0000');

  useEffect(() => {
    formatRef.current = format;
    rangeRef.current = xRange;
    markersRef.current = markers;
  });

  const paintLegend = (idx: number | null | undefined) => {
    const d = dataRef.current;
    const n = d[0].length;
    legendRefs.current.forEach((el, k) => {
      if (!el) return;
      const col = d[k + 1];
      let v: number | null | undefined = null;
      if (idx != null) v = col?.[idx];
      else for (let i = n - 1; i >= 0 && v == null; i--) v = col?.[i]; // newest value, past trailing gaps
      el.textContent = v == null || Number.isNaN(v) ? '—' : formatRef.current(v);
    });
  };

  // Create the plot (once per shape and theme).
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const theme = readChartTheme();
    const k = theme.fontPx / 11;
    const opts: uPlot.Options = {
      width: Math.max(100, el.clientWidth),
      height,
      pxAlign: 0,
      legend: { show: false },
      // Top: room for marker labels above the first y label; right: the last time label, centred on the right edge.
      padding: [Math.round(22 * k), Math.round(30 * k), 0, 0],
      scales: {
        x: {
          time: true,
          range: (_u, dmin, dmax) => {
            const r = rangeRef.current;
            if (r) return [r[0], r[1]];
            return dmin === dmax ? [dmin - 30, dmax + 30] : [dmin, dmax];
          },
        },
        y: {
          range: (_u, dmin, dmax) => {
            let lo = Math.min(dmin, yMin ?? dmin);
            let hi = Math.max(dmax, yMax ?? dmax);
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [yMin ?? 0, yMax ?? 1];
            if (yMin !== undefined && yMax !== undefined && dmin >= yMin && dmax <= yMax) return [yMin, yMax];
            if (ySpan && hi - lo < ySpan) {
              const mid = (hi + lo) / 2;
              lo = mid - ySpan / 2;
              hi = mid + ySpan / 2;
            }
            return uPlot.rangeNum(lo, hi === lo ? lo + 1 : hi, 0.1, true);
          },
        },
      },
      axes: [
        {
          stroke: theme.axis,
          font: theme.font,
          grid: { stroke: theme.grid, width: 1 },
          ticks: { show: false },
          gap: 6,
          size: Math.round(28 * k),
          space: Math.round(72 * k),
          values: (u, splits) => {
            const span = (u.scales.x?.max ?? 0) - (u.scales.x?.min ?? 0);
            return splits.map((v) => (u.valToPos(v, 'x') < 22 * k ? '' : (span < 600 ? fmtHms : fmtHm)(new Date(v * 1000))));
          },
        },
        {
          stroke: theme.axis,
          font: theme.font,
          grid: { stroke: theme.grid, width: 1 },
          ticks: { show: false },
          gap: 8,
          // Wide enough for the longest label ("150 TFLOPS"), measured in the axis font.
          size: (self, values) => {
            const ctx = self.ctx;
            ctx.save();
            ctx.font = theme.font;
            // uPlot calls this before the first ticks exist (values null at runtime, despite the typings).
            const w = Math.max(0, ...(Array.isArray(values) ? values : []).map((t) => ctx.measureText(t).width));
            ctx.restore();
            return Math.max(Math.round(44 * k), Math.ceil(w) + 14);
          },
          space: Math.round(30 * k),
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
                    g.addColorStop(0, withAlpha(color, 0.18));
                    g.addColorStop(1, withAlpha(color, 0));
                    return g;
                  }
                : undefined,
          };
        }),
      ],
      cursor: {
        sync: { key: 'spark', setSeries: false, filters: { pub: (type) => type !== 'mousedown' && type !== 'mouseup' } },
        drag: { x: false, y: false },
        y: false,
        points: { size: 8, width: 2, fill: (u, si) => (u.series[si]?.stroke as string | undefined) ?? theme.axis, stroke: () => theme.surface },
      },
      hooks: {
        setCursor: [(u) => { paintLegend(u.cursor.idx); }],
        // Run markers: a dashed vertical rule with its label at the top, drawn under the cursor.
        draw: [
          (u) => {
            const list = markersRef.current;
            if (!list.length) return;
            const ctx = u.ctx;
            const dpr = uPlot.pxRatio;
            const { top, height: h, left, width } = u.bbox;
            ctx.save();
            ctx.font = `600 ${Math.round(theme.fontPx * dpr)}px ${theme.fontFamily}`;
            ctx.textBaseline = 'bottom';
            list.forEach((m, i) => {
              const x = Math.round(u.valToPos(m.ts, 'x', true)) + 0.5;
              if (x < left - 1 || x > left + width + 1) return;
              ctx.strokeStyle = theme.series[0] ?? theme.axis;
              ctx.lineWidth = dpr;
              ctx.setLineDash([3 * dpr, 3 * dpr]);
              ctx.beginPath();
              ctx.moveTo(x, top);
              ctx.lineTo(x, top + h);
              ctx.stroke();
              ctx.fillStyle = theme.text;
              const tw = ctx.measureText(m.label).width;
              // With a start and an end marker, the first label sits left of its rule and the last right of it, so
              // a short run's "Start" and "Done" never overlap.
              // Labels sit above the top y label ("100%", centred on the top grid line) and clear of the y gutter.
              const before = list.length > 1 && i === 0;
              const tx = Math.min(Math.max(before ? x - 4 * dpr - tw : x + 4 * dpr, left + 6 * dpr), left + width - tw);
              ctx.fillText(m.label, tx, top - (theme.fontPx / 2 + 3) * dpr);
            });
            ctx.restore();
          },
        ],
      },
    };
    const u = new uPlot(opts, dataRef.current, el);
    uRef.current = u;
    paintLegend(null);
    const ro = new ResizeObserver(() => { u.setSize({ width: Math.max(100, el.clientWidth), height }); });
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      uRef.current = null;
    };
    // Formatting, range and markers go through refs: they never recreate the plot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsId, height, yMin, yMax, ySpan, themeVersion]);

  // Feed data (and re-apply the range: it moves with the ETA while the run is live).
  useEffect(() => {
    dataRef.current = [Array.from(ts), ...series.map((s) => Array.from(s.values, (v) => (v == null ? null : v)))] as uPlot.AlignedData;
    const u = uRef.current;
    if (!u) return;
    u.setData(dataRef.current, true);
    if (u.cursor.idx == null) paintLegend(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ts, series, xRange?.[0], xRange?.[1], themeVersion, labelsId]);

  const summary = useMemo(() => {
    const parts = series.map((s) => {
      const st = summarize(s.values);
      return st.latest === null ? `${s.label}: no data` : `${s.label} latest ${format(st.latest)}, min ${format(st.min ?? 0)}, max ${format(st.max ?? 0)}`;
    });
    const mk = markers.length ? ` Markers: ${markers.map((m) => `${m.label} at ${fmtHms(new Date(m.ts * 1000))}`).join(', ')}.` : '';
    return `${title}. ${parts.join('; ')}.${mk}`;
  }, [series, format, title, markers]);

  const empty = !loading && (ts.length === 0 || series.every((s) => s.values.every((v) => v == null)));

  return (
    <figure className="tschart bench-chart">
      <figcaption className="tschart__head">
        <span className="bench-chart__title">{title}</span>
        <ul className="tschart__legend" aria-label={`${title} series`}>
          {series.map((s, i) => (
            <li key={s.label} className="tschart__legend-item">
              <span className={`tschart__swatch tschart__swatch--${i % 4}`} aria-hidden="true" />
              <span className="tschart__legend-label">{s.label}</span>
              <span className="tschart__legend-value num" ref={(r) => { legendRefs.current[i] = r; }}>—</span>
            </li>
          ))}
        </ul>
        <div className="tschart__actions">
          <Tooltip content={showTable ? 'Hide data table' : 'Show data table'} placement="bottom">
            <IconButton
              size="sm"
              aria-label={`${title}: data table`}
              aria-expanded={showTable}
              aria-controls={tableId}
              icon={<Table2 />}
              className={showTable ? 'is-pressed' : undefined}
              onClick={() => { setShowTable(!showTable); }}
            />
          </Tooltip>
        </div>
      </figcaption>
      <div className="tschart__plot-wrap" style={{ height }}>
        <div ref={plotRef} className={`tschart__plot${loading || empty ? ' tschart__plot--hidden' : ''}`} role="img" aria-label={summary} />
        {loading ? (
          <div className="tschart__overlay" aria-hidden="true"><Skeleton height={height - 24} radius={10} /></div>
        ) : empty ? (
          <div className="tschart__overlay"><p className="bench-chart__empty">{emptyText}</p></div>
        ) : null}
      </div>
      {showTable ? (
        <ChartDataTable id={tableId} caption={title} ts={ts} series={series.map((s) => ({ label: s.label, values: s.values }))} format={format} />
      ) : null}
    </figure>
  );
}
