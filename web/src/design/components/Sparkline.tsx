import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { readChartTheme, setupCanvas, summarize, useThemeVersion, withAlpha } from '../../charts/theme';
import { formatAgo } from '../../lib/format';
import { liveStore, type LiveStore } from '../../store/live';
import { serverNow } from '../../store/cluster';
import './Sparkline.css';

interface Props {
  /** What the line shows, used in the accessible summary: "GPU utilisation". */
  label: string;
  /** Full display text for a value including unit: n => "91%". */
  format: (n: number) => string;
  /** Static data… */
  values?: readonly (number | null)[];
  ts?: readonly number[];
  /** …or live data from the LiveStore (redraws once per animation frame at most, without React renders). */
  source?: { node: string; metric: string; windowS?: number };
  store?: LiveStore;
  height?: number;
  /** Fixed y domain (e.g. 0–100 for percentages); otherwise fitted to the data. */
  min?: number;
  max?: number;
}

interface Data {
  ts: readonly number[];
  values: readonly (number | null)[];
}

const PAD_Y = 3;

/** Small canvas line chart: DPR-aware, tactile hover readout, keyboard focusable with a text summary. */
export function Sparkline({ label, format, values, ts, source, store = liveStore, height = 40, min, max }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const data = useRef<Data>({ ts: [], values: [] });
  const cursor = useRef<number | null>(null);
  const width = useRef(0);
  const formatRef = useRef(format);
  const [summary, setSummary] = useState('');
  const themeVersion = useThemeVersion();

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const w = width.current;
    if (!canvas || !w) return;
    const ctx = setupCanvas(canvas, w, height);
    if (!ctx) return;
    const theme = readChartTheme();
    const color = theme.series[0] ?? '#7286ff';
    const { values: vs } = data.current;
    const n = vs.length;
    const s = summarize(vs);
    if (n < 2 || s.min === null || s.max === null) return;
    let lo = min ?? s.min;
    let hi = max ?? s.max;
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const x = (i: number) => (i / (n - 1)) * (w - 2) + 1;
    const y = (v: number) => PAD_Y + (1 - (v - lo) / (hi - lo)) * (height - PAD_Y * 2);

    // Area + line, broken at gaps.
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, withAlpha(color, 0.22));
    grad.addColorStop(1, withAlpha(color, 0));
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length > 1) {
        const first = run[0] as [number, number];
        const last = run[run.length - 1] as [number, number];
        ctx.beginPath();
        ctx.moveTo(first[0], height);
        for (const [px, py] of run) ctx.lineTo(px, py);
        ctx.lineTo(last[0], height);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        run.forEach(([px, py], k) => {
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }
      run = [];
    };
    for (let i = 0; i < n; i++) {
      const v = vs[i];
      if (v == null || Number.isNaN(v)) flush();
      else run.push([x(i), y(v)]);
    }
    flush();

    const c = cursor.current;
    const cv = c === null ? null : vs[c];
    const readout = readoutRef.current;
    if (c !== null && cv != null) {
      const px = x(c);
      ctx.strokeStyle = theme.separator;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, 0);
      ctx.lineTo(Math.round(px) + 0.5, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, y(cv), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.surface;
      ctx.stroke();
      if (readout) {
        const t = data.current.ts[c];
        readout.textContent = t !== undefined ? `${formatRef.current(cv)} · ${formatAgo(t, serverNow())}` : formatRef.current(cv);
        readout.dataset.visible = 'true';
      }
    } else if (readout) {
      delete readout.dataset.visible;
    }
  }, [height, min, max]);

  const updateSummary = useCallback(() => {
    const s = summarize(data.current.values);
    const f = formatRef.current;
    setSummary(
      s.latest === null
        ? `${label}: no data`
        : `${label}: latest ${f(s.latest)}, range ${f(s.min ?? s.latest)} to ${f(s.max ?? s.latest)}`,
    );
  }, [label]);

  useEffect(() => {
    formatRef.current = format;
  }, [format]);

  // Static data.
  useEffect(() => {
    if (source || !values) return;
    data.current = { ts: ts ?? [], values };
    draw();
    updateSummary();
  }, [values, ts, source, draw, updateSummary]);

  // Live data: copy the window once per notification (coalesced per frame by the store).
  const node = source?.node;
  const metric = source?.metric;
  const windowS = source?.windowS ?? 180;
  useEffect(() => {
    if (!node || !metric) return;
    let lastSummary = 0;
    const pull = () => {
      const w = store.window(node, [metric], serverNow() - windowS);
      data.current = { ts: w.ts, values: w.values[0] ?? [] };
      draw();
      const t = performance.now();
      if (t - lastSummary > 5000) {
        lastSummary = t; // the aria-label does not need per-second churn
        updateSummary();
      }
    };
    pull();
    return store.subscribeSample(node, pull);
  }, [node, metric, windowS, store, draw, updateSummary]);

  // Size + DPR.
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

  const indexAt = (clientX: number) => {
    const el = wrapRef.current;
    const n = data.current.values.length;
    if (!el || n < 2) return null;
    const r = el.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, Math.round(((clientX - r.left - 1) / (r.width - 2)) * (n - 1))));
  };

  const onPointerMove = (e: PointerEvent) => {
    cursor.current = indexAt(e.clientX);
    draw();
  };
  const onLeave = () => {
    cursor.current = null;
    draw();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const n = data.current.values.length;
    if (!n) return;
    const c = cursor.current ?? n - 1;
    const next = e.key === 'ArrowLeft' ? Math.max(0, c - 1) : e.key === 'ArrowRight' ? Math.min(n - 1, c + 1) : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'Escape' ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    cursor.current = next;
    draw();
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see tabIndex note below
    <div
      ref={wrapRef}
      className="sparkline"
      style={{ height }}
      role="img"
      aria-label={summary || label}
      // A focusable image: the summary is its name, and arrow keys scrub the visual readout. No ARIA widget role
      // fits a scrubbable chart better, so the non-interactive role keeps screen readers on the summary.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onPointerMove={onPointerMove}
      onPointerLeave={onLeave}
      onFocus={() => { cursor.current = data.current.values.length ? data.current.values.length - 1 : null; draw(); }}
      onBlur={onLeave}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="sparkline__canvas" style={{ height }} />
      <div ref={readoutRef} className="sparkline__readout" aria-hidden="true" />
    </div>
  );
}
