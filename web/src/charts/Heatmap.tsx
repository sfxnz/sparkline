// Per-core CPU utilisation over time. Rows are grouped performance first, then efficiency, with a separator.
// Colour is the sequential --heat ramp: one hue, lightness ordered by value, legible on the panel in both themes
// (status colours are reserved for status). Redraws once per sample.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CoreInfo } from '../lib/types';
import { serverNow } from '../store/cluster';
import { liveStore, type LiveStore } from '../store/live';
import { fontScale, heatLut, readChartTheme, setupCanvas, useThemeVersion, withAlpha } from './theme';
import './chart.css';

interface Props {
  node: string;
  cores: readonly CoreInfo[];
  windowS?: number;
  rowHeight?: number;
  store?: LiveStore;
  /** Where a point sits in its cell: 'end' for live samples (each covers the interval before it), 'center' for
   *  history buckets (stamped at their middle). */
  cellAlign?: 'end' | 'center';
}

interface Row {
  core: CoreInfo;
  group: CoreInfo['kind'];
}

const LABEL_W = 92;
const GROUP_GAP = 10;
const GROUP_NAME: Record<CoreInfo['kind'], string> = { performance: 'Performance', efficiency: 'Efficiency', unknown: 'Other' };

/**
 * Integer x edges [x0, x1] of each cell (flat array, two per point). Each cell starts exactly where its neighbour
 * ended: sample times jitter by a few ms, so edges rounded independently leave 1 px seams or overlaps (alpha would
 * double). A real gap in the data (more than 1.5 steps) stays a gap. Clamped to [minX, maxX].
 */
export function cellEdges(ts: ArrayLike<number>, step: number, align: 'end' | 'center', xAt: (t: number) => number, minX: number, maxX: number): number[] {
  const offset = align === 'center' ? step / 2 : 0;
  const out = new Array<number>(ts.length * 2);
  let prevT: number | null = null;
  let prevX1 = minX;
  for (let j = 0; j < ts.length; j++) {
    const t = ts[j] ?? 0;
    const x1 = Math.min(maxX, Math.round(xAt(t + offset)));
    const x0 = Math.max(minX, prevT !== null && t - prevT <= 1.5 * step ? prevX1 : Math.round(xAt(t + offset - step)));
    out[2 * j] = x0;
    out[2 * j + 1] = x1;
    prevT = t;
    prevX1 = x1;
  }
  return out;
}

export function orderCores(cores: readonly CoreInfo[]): Row[] {
  const rank = { performance: 0, efficiency: 1, unknown: 2 } as const;
  return [...cores].sort((a, b) => rank[a.kind] - rank[b.kind] || a.id - b.id).map((core) => ({ core, group: core.kind }));
}

export function Heatmap({ node, cores, windowS = 180, rowHeight: baseRowHeight = 13, store = liveStore, cellAlign = 'end' }: Props) {
  // Rows and the label column grow with the user's font size so the canvas labels stay legible and unclipped.
  const scale = fontScale();
  const rowHeight = Math.round(baseRowHeight * scale);
  const labelW = Math.round(LABEL_W * scale);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useRef(0);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const [summary, setSummary] = useState('Per-core CPU utilisation');
  const themeVersion = useThemeVersion();
  const rows = useMemo(() => orderCores(cores), [cores]);
  const keys = useMemo(() => rows.map((r) => `cpu.core${r.core.id}.util`), [rows]);
  const groupBreaks = rows.reduce((n, r, i) => n + (i > 0 && rows[i - 1]?.group !== r.group ? 1 : 0), 0);
  const height = rows.length * rowHeight + groupBreaks * GROUP_GAP;

  const rowY = useCallback(
    (i: number) => {
      let breaks = 0;
      for (let k = 1; k <= i; k++) if (rows[k - 1]?.group !== rows[k]?.group) breaks++;
      return i * rowHeight + breaks * GROUP_GAP;
    },
    [rows, rowHeight],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const w = width.current;
    if (!canvas || !w) return;
    const ctx = setupCanvas(canvas, w, height);
    if (!ctx) return;
    const theme = readChartTheme();
    const win = store.window(node, keys, serverNow() - windowS);
    const n = win.ts.length;
    const plotW = w - labelW;
    const colW = plotW / Math.max(1, windowS);
    const step = (store.latest(node)?.interval_ms ?? 1000) / 1000;
    const heat = heatLut(theme.heat);

    ctx.font = `500 ${Math.round((theme.fontPx * 10) / 11)}px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';
    rows.forEach((r, i) => {
      const y = rowY(i);
      const first = i === 0 || rows[i - 1]?.group !== r.group;
      ctx.fillStyle = theme.axis;
      ctx.textAlign = 'left';
      if (first) ctx.fillText(GROUP_NAME[r.group], 0, y + rowHeight / 2);
      ctx.textAlign = 'right';
      ctx.fillText(String(r.core.id), labelW - 8, y + rowHeight / 2);
      // Track (no data) then cells.
      ctx.fillStyle = withAlpha(theme.axis, 0.08);
      ctx.fillRect(labelW, y + 1, plotW, rowHeight - 2);
      const vs = win.values[i] ?? [];
      const now = serverNow();
      const edges = cellEdges(win.ts, step, cellAlign, (t) => labelW + plotW - (now - t) * colW, labelW, labelW + plotW);
      for (let j = 0; j < n; j++) {
        const v = vs[j];
        const x0 = edges[2 * j] ?? 0;
        const x1 = edges[2 * j + 1] ?? 0;
        if (v == null || x1 <= x0) continue;
        ctx.fillStyle = heat[Math.min(100, Math.max(0, Math.round(v)))] ?? '';
        ctx.fillRect(x0, y + 1, x1 - x0, rowHeight - 2);
      }
      if (focusRow === i) {
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 1;
        ctx.strokeRect(labelW + 0.5, y + 0.5, plotW - 1, rowHeight - 1);
      }
    });
    // Group separators.
    ctx.fillStyle = theme.separator;
    rows.forEach((r, i) => {
      if (i > 0 && rows[i - 1]?.group !== r.group) ctx.fillRect(0, rowY(i) - GROUP_GAP / 2, w, 1);
    });
  }, [node, keys, rows, rowY, rowHeight, labelW, height, windowS, store, focusRow, cellAlign]);

  const describe = useCallback(() => {
    const latest = keys.map((k) => store.latestValue(node, k));
    const avg = (kind: CoreInfo['kind']) => {
      const v = rows.map((r, i) => (r.group === kind ? latest[i] : null)).filter((x): x is number => x != null);
      return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    };
    let hot = -1;
    latest.forEach((v, i) => { if (v != null && (hot < 0 || v > (latest[hot] ?? -1))) hot = i; });
    const perf = avg('performance');
    const eff = avg('efficiency');
    const hotRow = rows[hot];
    setSummary(
      [
        'Per-core CPU utilisation',
        perf !== null ? `performance cores average ${perf}%` : null,
        eff !== null ? `efficiency cores average ${eff}%` : null,
        hotRow ? `busiest core ${hotRow.core.id} at ${Math.round(latest[hot] ?? 0)}%` : 'no data yet',
      ].filter(Boolean).join(', '),
    );
  }, [keys, rows, node, store]);

  useEffect(() => {
    let last = 0;
    const onSample = () => {
      draw();
      const t = performance.now();
      // The summary is the focused element's name: keep it still while focused (it updates again after blur).
      if (t - last > 5000 && document.activeElement !== wrapRef.current) {
        last = t;
        describe();
      }
    };
    onSample();
    return store.subscribeSample(node, onSample);
  }, [node, store, draw, describe]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      width.current = entries[0]?.contentRect.width ?? el.clientWidth;
      draw();
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [draw]);

  useEffect(() => { draw(); }, [themeVersion, draw]);

  // Computed only on arrow keys, so the polite live region speaks in response to the user, never on its own.
  const [readout, setReadout] = useState('');
  const readoutFor = (i: number) => {
    const r = rows[i];
    const key = keys[i];
    if (!r || !key) return '';
    const vals = (store.window(node, [key], serverNow() - windowS).values[0] ?? []).filter((v): v is number => v != null);
    const now = store.latestValue(node, key);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return `Core ${r.core.id} · ${GROUP_NAME[r.group]}${r.core.model ? ` (${r.core.model})` : ''}: ${now === null ? 'no data' : `${Math.round(now)}% now`}${avg === null ? '' : `, ${Math.round(avg)}% average`}`;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!rows.length) return;
    const cur = focusRow ?? -1;
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, cur + 1) : e.key === 'ArrowUp' ? Math.max(0, cur - 1) : e.key === 'Escape' ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setFocusRow(next);
    setReadout(next === null ? '' : readoutFor(next));
  };

  return (
    <div className="heatmap">
      {/* A focusable image: arrow keys move a row readout announced in the polite region below. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={wrapRef}
        className="heatmap__canvas-wrap"
        style={{ height }}
        role="img"
        aria-label={`${summary}. Use the up and down arrow keys to read individual cores.`}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => { setFocusRow(null); setReadout(''); }}
      >
        <canvas ref={canvasRef} className="heatmap__canvas" style={{ height }} />
      </div>
      <div className="heatmap__time" aria-hidden="true">
        <span>{Math.round(windowS / 60)} min ago</span>
        <span>Now</span>
      </div>
      <div className="heatmap__foot">
        <span aria-live="polite" className="num">{readout}</span>
        <span className="heatmap__scale" aria-hidden="true">
          0% <span className="heatmap__ramp" /> 100%
        </span>
      </div>
    </div>
  );
}
