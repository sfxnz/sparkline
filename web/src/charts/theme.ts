// Chart theming from CSS custom properties, so charts follow the active theme (and re-theme when it changes).
import { useSyncExternalStore } from 'react';
import uPlot from 'uplot';
import type { TimeRange } from '../lib/prefs';

export interface ChartTheme {
  grid: string;
  axis: string;
  text: string;
  separator: string;
  surface: string;
  /** Series colours: accent first, then restrained neutrals. Status colours are only for thresholds. */
  series: string[];
  /** Sequential ramp stops (--heat-0..4) at HEAT_STOPS: one hue, lightness ordered by value. */
  heat: string[];
  warn: string;
  crit: string;
  /** `500 <fontPx>px <family>`: 11 px at the default 16 px root, scaled with the user's font size. */
  font: string;
  fontPx: number;
  fontFamily: string;
}

// Reading the theme means getComputedStyle on <html>, which forces a style recalc when anything is dirty (and the
// overview's animations keep style dirty). Sparklines and heatmaps draw every tick, so the values are cached: re-read
// at once when the theme attributes or the colour scheme change, otherwise at most every few seconds (which also
// picks up a changed font size).
const THEME_TTL_MS = 5000;
let themeCache: { key: string; at: number; theme: ChartTheme } | null = null;
let scaleCache: { at: number; scale: number } | null = null;

function themeKey(): string {
  const el = document.documentElement;
  const dark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : false;
  return `${el.getAttribute('data-theme') ?? ''}|${el.getAttribute('data-reduce-transparency') ?? ''}|${String(dark)}`;
}

/** Root font size relative to the 16 px default, so canvas text follows the user's font scaling. */
export function fontScale(): number {
  const now = performance.now();
  if (scaleCache && now - scaleCache.at < THEME_TTL_MS) return scaleCache.scale;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const scale = Number.isFinite(px) && px > 0 ? px / 16 : 1;
  scaleCache = { at: now, scale };
  return scale;
}

/** Chart colours and fonts from the active theme (cached; see above). */
export function readChartTheme(): ChartTheme {
  const key = themeKey();
  const now = performance.now();
  if (themeCache?.key === key && now - themeCache.at < THEME_TTL_MS) return themeCache.theme;
  const theme = computeChartTheme();
  themeCache = { key, at: now, theme };
  return theme;
}

function computeChartTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const fontPx = Math.round(11 * fontScale());
  const fontFamily = v('--font-sans', 'system-ui, sans-serif');
  return {
    grid: v('--chart-grid', 'rgba(128,128,128,0.15)'),
    axis: v('--chart-axis', '#888'),
    text: v('--text-1', '#eee'),
    separator: v('--separator-strong', 'rgba(128,128,128,0.3)'),
    surface: v('--surface-3', '#222'),
    series: [v('--chart-1', '#7286ff'), v('--chart-2', '#ccc'), v('--chart-3', '#888'), v('--chart-4', '#b4a4f5')],
    heat: ['#272b4f', '#4b5ed8', '#7b8dff', '#abb7ff', '#e0e4ff'].map((f, i) => v(`--heat-${i}`, f)),
    warn: v('--warn', '#f2b440'),
    crit: v('--crit', '#ff645b'),
    font: `500 ${fontPx}px ${fontFamily}`,
    fontPx,
    fontFamily,
  };
}

/** '#rrggbb' or 'rgb(a)(...)' with a new alpha. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (m?.[1]) {
    const [r, g, b] = m[1].split(',').map((x) => x.trim());
    return `rgba(${r ?? 0}, ${g ?? 0}, ${b ?? 0}, ${alpha})`;
  }
  return color;
}

/** Positions (0..1) of the --heat-N stops; denser at the low end so 20 % already clears 3:1 against the panel. */
export const HEAT_STOPS = [0, 0.2, 0.45, 0.7, 1] as const;

/** Colour of value `t` (0..1) on the sequential ramp: linear between the two neighbouring '#rrggbb' stops. */
export function heatColor(stops: readonly string[], t: number): string {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  let k = 0;
  while (k < HEAT_STOPS.length - 2 && x > (HEAT_STOPS[k + 1] ?? 1)) k++;
  const lo = HEAT_STOPS[k] ?? 0;
  const hi = HEAT_STOPS[k + 1] ?? 1;
  const f = hi > lo ? (x - lo) / (hi - lo) : 0;
  const rgb = (c: string | undefined) => {
    const n = parseInt(/^#([0-9a-f]{6})$/i.exec(c?.trim() ?? '')?.[1] ?? '808080', 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = rgb(stops[k]);
  const b = rgb(stops[k + 1]);
  return `rgb(${a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * f)).join(', ')})`;
}

const heatLuts = new WeakMap<readonly string[], string[]>();
/**
 * heatColor at every whole percent (index 0..100), computed once per palette: the heatmap paints thousands of cells
 * per sample, and a colour string per cell (regex, parse, format) was its main cost.
 */
export function heatLut(stops: readonly string[]): readonly string[] {
  let lut = heatLuts.get(stops);
  if (!lut) {
    lut = Array.from({ length: 101 }, (_, i) => heatColor(stops, i / 100));
    heatLuts.set(stops, lut);
  }
  return lut;
}

// One MutationObserver for the whole app: bumps a version whenever theme attributes on <html> change.
let version = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      version++;
      listeners.forEach((l) => { l(); });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-reduce-transparency'] });
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/** A number that changes whenever the theme changes (use as an effect dependency to re-theme). */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Size a canvas for its CSS box at the current devicePixelRatio and return a context in CSS pixels. */
export function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/** Summary used in aria-labels: latest / min / max over the provided values (nulls ignored). */
export function summarize(values: ArrayLike<number | null>): { latest: number | null; min: number | null; max: number | null } {
  let min: number | null = null;
  let max: number | null = null;
  let latest: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) continue;
    latest = v;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return { latest, min, max };
}

/** Y-axis steps for byte values: powers of two of KiB/MiB/GiB, so ticks read "32 GiB", "64 GiB" rather than
 *  decimal steps rendered in binary units ("93.1 GiB"). Pass as a chart's `yIncrs`. */
export const BYTE_INCRS: readonly number[] = [10, 20, 30].flatMap((p) => [1, 2, 4, 8, 16, 32, 64, 128, 256, 512].map((m) => m * 2 ** p));

const LABEL_RE = /^(-?\d+(?:\.\d+)?)(\s*)(.*)$/;

/** Fewest decimals (0..3) that write `v` exactly. */
function decimalsFor(v: number): number {
  for (let d = 0; d < 3; d++) if (Math.abs(Number(v.toFixed(d)) - v) < 1e-9 * Math.max(1, Math.abs(v))) return d;
  return 3;
}

/**
 * Y-axis tick labels that read as one scale: every tick in the same unit (the zero tick too: "0 GiB", not "0 B"),
 * the same number of decimals on every tick, and no trailing ".0" when all ticks are whole ("0 W, 20 W, 40 W").
 * Labels that do not parse as "<number><unit>", or whose non-zero ticks span units, keep the formatter's text.
 * Repeats are blanked: a narrow range formatted to whole units would otherwise read "69 °C, 70 °C, 70 °C".
 */
export function axisLabels(splits: readonly number[], format: (n: number) => string): string[] {
  let labels = splits.map((v) => format(v));
  const parsed = labels.map((t) => LABEL_RE.exec(t));
  if (parsed.every(Boolean)) {
    const parts = parsed.map((m) => ({ num: Number(m?.[1]), sep: m?.[2] ?? '', unit: m?.[3] ?? '' }));
    const nonZero = parts.filter((p) => p.num !== 0);
    const unit = nonZero[0]?.unit;
    if (unit !== undefined && nonZero.every((p) => p.unit === unit)) {
      const sep = nonZero[0]?.sep ?? '';
      const d = Math.max(0, ...nonZero.map((p) => decimalsFor(p.num)));
      labels = parts.map((p) => `${p.num.toFixed(p.num === 0 ? 0 : d)}${sep}${unit}`);
    }
  }
  let prev: string | null = null;
  return labels.map((t) => {
    const out = t === prev ? '' : t;
    prev = t;
    return out;
  });
}

/** Time-axis steps per range: the format and density follow the range, never the chart's width, so neighbouring
 *  charts of one screen tick alike (Live/5m every minute or more, as HH:MM; 7 d by day). */
export const TIME_INCRS: Record<TimeRange, number[]> = {
  live: [60, 120, 300, 600, 900, 1800],
  '5m': [60, 120, 300, 600, 900, 1800],
  '1h': [300, 600, 900, 1800, 3600],
  '24h': [3600, 7200, 10800, 21600, 43200, 86400],
  '7d': [86400, 172800, 345600, 604800],
};

const fmtHm = uPlot.fmtDate('{HH}:{mm}');
const fmtDay = uPlot.fmtDate('{D} {MMM}');

/** uPlot x-axis options for a range: its steps, its one label format, and no label so close to the plot's left edge
 *  that it would run into the y-axis labels. `k` scales the spacing with the user's font size. */
export function timeAxis(range: TimeRange, k: number): Pick<uPlot.Axis, 'incrs' | 'values' | 'space'> {
  const fmt = range === '7d' ? fmtDay : fmtHm;
  const edge = Math.round(22 * k);
  return {
    incrs: TIME_INCRS[range],
    space: Math.round(72 * k),
    values: (u, splits) => splits.map((v) => (u.valToPos(v, 'x') < edge ? '' : fmt(new Date(v * 1000)))),
  };
}
