// After a sweep: how the server scaled from one stream to many. Three small multiples share a doubling (log2) level
// axis — output tokens/s, decode tokens/s per request, time to first token p50–p95 — with the peak-throughput level
// emphasised in each and hover linked across them; the table below holds every value (the charts' table view).
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Panel } from '../../../design/components/Panel';
import { Table, type Column } from '../../../design/components/Table';
import { axisLabels } from '../../../charts/theme';
import { formatPercent } from '../../../lib/format';
import type { RunStatus } from '../../../lib/types';
import { formatValue, valueWithUnit } from '../model';
import { formatMs, formatTokS, niceTicks, peakLevel, scalingEfficiency, type LevelStats } from './model';
import { useWidth } from './useWidth';

const plural = (n: number) => `${n} ${n === 1 ? 'stream' : 'streams'}`;
const tokS = (n: number) => `${formatTokS(n)} tok/s`;
const percent = (share: number | null) => formatPercent(share === null ? null : share * 100);
/** Milliseconds on the axis, or seconds for every tick once the axis passes one second. */
const msAxis = (n: number, top: number) => (top >= 1000 ? `${Number((n / 1000).toPrecision(3))} s` : `${Math.round(n)} ms`);

interface Series {
  label: string;
  values: readonly (number | null)[];
}

interface ChartProps {
  title: string;
  levels: readonly number[];
  /** The bars, and optionally a whisker above each (time to first token: p50 bars, p95 whiskers). */
  series: readonly [Series] | readonly [Series, Series];
  /** Readout text with its unit ("412 tok/s"). */
  format: (n: number) => string;
  /** Axis tick text; `top` is the axis maximum, for picking one unit for every tick. */
  axis: (n: number, top: number) => string;
  /** Value printed on the emphasised bar (none for whiskered charts). */
  label?: (n: number) => string;
  peak: number | null;
  hover: number | null;
  onHover: (level: number | null) => void;
  legend?: ReactNode;
}

const H = 156;
const TOP = 22;
const BOTTOM = 24;

/** A bar with rounded data end (top) and a square base. */
function barPath(x: number, w: number, top: number, base: number): string {
  const r = Math.min(4, w / 2, Math.max(0, base - top));
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

function LevelChart({ title, levels, series, format, axis, label, peak, hover, onHover, legend }: ChartProps) {
  const [ref, width] = useWidth(320);
  const [bars, whiskers] = series;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const { ticks, top } = niceTicks(Math.max(...all, 0) * 1.04, 3);
  const tickText = axisLabels(ticks, (n) => axis(n, top));
  const left = Math.max(...tickText.map((t) => t.length)) * 6.4 + 12;
  const right = 8;
  const innerW = Math.max(40, width - left - right);
  const lo = Math.log2(levels[0] ?? 1);
  const hi = Math.log2(levels.at(-1) ?? 1);
  const inset = Math.min(30, innerW / (2 * Math.max(1, levels.length)));
  const x = (level: number) => left + inset + (hi > lo ? (Math.log2(level) - lo) / (hi - lo) : 0.5) * (innerW - 2 * inset);
  const y = (v: number) => TOP + (1 - v / (top || 1)) * (H - TOP - BOTTOM);
  const gaps = levels.slice(1).map((l, i) => x(l) - x(levels[i] ?? l));
  const bw = Math.max(6, Math.min(22, 0.62 * Math.min(...gaps, innerW)));
  const base = y(0);
  const i = hover === null ? -1 : levels.indexOf(hover);
  const hx = i >= 0 ? x(levels[i] ?? 0) : 0;
  const peakValue = peak === null ? null : bars.values[levels.indexOf(peak)];

  const summary = `${title}: ${levels.map((l, k) => `${plural(l)} ${series.map((s) => `${series.length > 1 ? `${s.label} ` : ''}${s.values[k] == null ? 'not measured' : format(s.values[k] ?? 0)}`).join(', ')}`).join('; ')}.${peak !== null ? ` Peak output at ${plural(peak)}.` : ''}`;

  const nearest = (clientX: number, el: HTMLElement) => {
    const px = clientX - el.getBoundingClientRect().left;
    let best = levels[0] ?? null;
    for (const l of levels) if (best === null || Math.abs(x(l) - px) < Math.abs(x(best) - px)) best = l;
    return best;
  };
  const onKey = (e: KeyboardEvent) => {
    const at = hover === null ? -1 : levels.indexOf(hover);
    const next = e.key === 'ArrowRight' ? Math.min(levels.length - 1, at + 1) : e.key === 'ArrowLeft' ? Math.max(0, at < 0 ? 0 : at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? levels.length - 1 : e.key === 'Escape' ? -1 : null;
    if (next === null) return;
    e.preventDefault();
    onHover(next < 0 ? null : (levels[next] ?? null));
  };

  return (
    <figure className="strm-chart">
      <figcaption className="strm-chart__head">
        <span className="strm-chart__title">{title}</span>
        {/* The highlighted level's values replace the legend while hovering (they carry the same keys). */}
        {i >= 0 ? (
          <span className="strm-chart__readout" aria-hidden="true">
            <span>{plural(levels[i] ?? 0)}</span>
            {series.map((s) => (
              <span key={s.label}>
                <strong className="num">{s.values[i] == null ? '—' : format(s.values[i] ?? 0)}</strong>
                {series.length > 1 ? ` ${s.label}` : null}
              </span>
            ))}
          </span>
        ) : (
          legend
        )}
      </figcaption>
      {/* A focusable image: the summary is its name; arrow keys move the highlighted level (as Sparkline does). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={ref}
        className="strm-chart__plot"
        role="img"
        aria-label={summary}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onPointerMove={(e) => { onHover(nearest(e.clientX, e.currentTarget)); }}
        onPointerLeave={() => { onHover(null); }}
        onFocus={() => { onHover(peak ?? levels[0] ?? null); }}
        onBlur={() => { onHover(null); }}
        onKeyDown={onKey}
      >
        {width > 0 ? (
          <svg width={width} height={H} aria-hidden="true">
            {ticks.map((t, k) => (
              <g key={t}>
                <line className="strm-chart__grid" x1={left} x2={width - right} y1={y(t)} y2={y(t)} />
                <text className="strm-chart__tick" x={left - 8} y={y(t)} dy="0.32em" textAnchor="end">{tickText[k]}</text>
              </g>
            ))}
            {i >= 0 ? <rect className="strm-chart__band" x={hx - bw / 2 - 6} width={bw + 12} y={TOP - 14} height={H - TOP - BOTTOM + 14} rx={6} /> : null}
            {levels.map((l, k) => {
              const v = bars.values[k];
              const w = whiskers?.values[k];
              const cx = x(l);
              const cap = Math.min(10, bw * 0.6) / 2;
              return (
                <g key={l} className={`strm-chart__mark${l === peak ? ' is-peak' : ''}`}>
                  {v == null ? null : <path className="strm-chart__bar" d={barPath(cx - bw / 2, bw, y(v), base)} />}
                  {v != null && w != null && w > v ? (
                    <path className="strm-chart__whisker" d={`M${cx},${y(v)}V${y(w)}M${cx - cap},${y(w)}H${cx + cap}`} />
                  ) : null}
                </g>
              );
            })}
            {label && peak !== null && peakValue != null ? (
              <text className="strm-chart__label" x={x(peak)} y={y(peakValue) - 7} textAnchor="middle">{label(peakValue)}</text>
            ) : null}
            {levels.map((l) => (
              <text key={l} className={`strm-chart__x${l === peak ? ' is-peak' : ''}${l === hover ? ' is-hover' : ''}`} x={x(l)} y={H - 6} textAnchor="middle">{l}</text>
            ))}
          </svg>
        ) : null}
      </div>
    </figure>
  );
}

interface Props {
  levels: readonly LevelStats[];
  /** Every level the run planned (more than were recorded when it stopped early). */
  planned: readonly number[];
  status: RunStatus;
  actions?: ReactNode;
}

export function SweepPanel({ levels: rows, planned, status, actions }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const levels = rows.map((r) => r.level);
  const peak = peakLevel(rows);
  const peakRow = rows.find((r) => r.level === peak);
  const maxOut = Math.max(0, ...rows.map((r) => r.out_tok_s ?? 0));
  const out = rows.map((r) => r.out_tok_s);
  const decode = rows.map((r) => r.decode_tok_s_p50);
  const ttft = [rows.map((r) => r.ttft_p50_ms), rows.map((r) => r.ttft_p95_ms)] as const;
  const has = (values: readonly (number | null)[]) => values.some((v) => v != null);
  const charts = rows.length > 1 && (has(out) || has(decode) || has(ttft[0]) || has(ttft[1]));

  const columns = useMemo((): Column<LevelStats>[] => [
    {
      id: 'level',
      header: 'Streams',
      sortValue: (r) => r.level,
      render: (r) => (
        <span className="strm-level-cell">
          <span className="num">{r.level}</span>
          {r.level === peak ? <span className="strm-peak">Peak</span> : null}
        </span>
      ),
    },
    {
      id: 'requests',
      header: 'Requests',
      align: 'end',
      sortValue: (r) => r.ok,
      render: (r) => (
        <span className="num">
          {r.ok ?? '—'} / {r.requests ?? '—'}
          {r.failed ? <span className="strm-failed-cell tone-crit"> · {r.failed} failed</span> : null}
        </span>
      ),
    },
    {
      id: 'out',
      header: 'Output tok/s',
      align: 'end',
      sortValue: (r) => r.out_tok_s,
      render: (r) => (
        <span className="strm-bar-cell">
          {r.out_tok_s != null && maxOut > 0 ? (
            <span className="strm-bar-cell__track" aria-hidden="true">
              <span className={r.level === peak ? 'is-peak' : ''} style={{ width: `${Math.max(2, (r.out_tok_s / maxOut) * 100)}%` }} />
            </span>
          ) : null}
          <span className="num strm-bar-cell__value">{formatTokS(r.out_tok_s)}</span>
        </span>
      ),
    },
    { id: 'decode', header: 'Decode tok/s per request', align: 'end', sortValue: (r) => r.decode_tok_s_p50, render: (r) => <span className="num">{formatTokS(r.decode_tok_s_p50)}</span> },
    { id: 'scaling', header: 'Scaling efficiency', align: 'end', sortValue: (r) => scalingEfficiency(r, rows), render: (r) => <span className="num">{percent(scalingEfficiency(r, rows))}</span> },
    { id: 'ttft50', header: 'TTFT p50', align: 'end', sortValue: (r) => r.ttft_p50_ms, render: (r) => <span className="num">{valueWithUnit(r.ttft_p50_ms, 'ms')}</span> },
    { id: 'ttft95', header: 'TTFT p95', align: 'end', sortValue: (r) => r.ttft_p95_ms, render: (r) => <span className="num">{valueWithUnit(r.ttft_p95_ms, 'ms')}</span> },
    { id: 'prefill', header: 'Prefill tok/s', align: 'end', sortValue: (r) => r.prefill_tok_s_p50, render: (r) => <span className="num">{formatTokS(r.prefill_tok_s_p50)}</span> },
  ], [rows, peak, maxOut]);

  // Every planned level recorded, or where the run stopped; then the peak, or why there is none.
  const counted = `${rows.length} ${rows.length === 1 ? 'level' : 'levels'}`;
  const all = rows.length >= planned.length;
  const where = all ? counted : `Stopped during level ${Math.min(rows.length + 1, planned.length)} of ${planned.length} · ${counted} recorded`;
  const subtitle = !rows.some((r) => (r.ok ?? 0) > 0)
    ? `${where} · every request failed`
    : !all
      ? where
      : status === 'succeeded'
        ? `${counted}${peakRow?.out_tok_s != null ? ` · output peaked at ${plural(peakRow.level)} (${tokS(peakRow.out_tok_s)})` : ''}`
        : `${counted} · the run ${status === 'cancelled' ? 'was cancelled' : 'failed'}`;

  return (
    <Panel title="Concurrency sweep" subtitle={subtitle} actions={actions} className="strm-sweep">
      <div className="strm-sweep__body">
        {charts ? (
          <div className="strm-multiples">
            {has(out) ? <LevelChart title="Output tokens/s" levels={levels} series={[{ label: 'Output', values: out }]} format={tokS} axis={formatValue} label={formatTokS} peak={peak} hover={hover} onHover={setHover} /> : null}
            {has(decode) ? <LevelChart title="Decode tokens/s per request" levels={levels} series={[{ label: 'Median', values: decode }]} format={tokS} axis={formatValue} label={formatTokS} peak={peak} hover={hover} onHover={setHover} /> : null}
            {has(ttft[0]) || has(ttft[1]) ? <LevelChart
              title="Time to first token"
              levels={levels}
              series={[{ label: 'p50', values: ttft[0] }, { label: 'p95', values: ttft[1] }]}
              format={formatMs}
              axis={msAxis}
              peak={peak}
              hover={hover}
              onHover={setHover}
              legend={
                <span className="strm-legend" aria-hidden="true">
                  <span><span className="strm-legend__bar" />p50</span>
                  <span>
                    <svg className="strm-legend__whisker" viewBox="0 0 10 10"><path d="M5,2V10M1,2H9" /></svg>
                    p95
                  </span>
                </span>
              }
            /> : null}
          </div>
        ) : null}
        {charts ? <p className="strm-sweep__axis">Concurrent streams, each step doubling{peak !== null ? ' · the peak-output level is highlighted' : ''}</p> : null}
        {rows.length > 1 && !charts ? <p className="strm-note">No request at any level produced a token, so there are no speeds or times to chart.</p> : null}
        <div className="strm-sweep__table">
          <Table caption="Concurrency sweep, one row per level" columns={columns} rows={rows} rowKey={(r) => r.level} />
        </div>
        <p className="strm-note">
          Output tokens/s is every completion token of a level over its wall time. Scaling efficiency compares it with perfect scaling: that many streams each as fast as one stream alone.
        </p>
      </div>
    </Panel>
  );
}
