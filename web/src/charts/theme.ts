// Chart theming from CSS custom properties, so charts follow the active theme (and re-theme when it changes).
import { useSyncExternalStore } from 'react';

export interface ChartTheme {
  grid: string;
  axis: string;
  text: string;
  separator: string;
  surface: string;
  /** Series colours: accent first, then restrained neutrals. Status colours are only for thresholds. */
  series: string[];
  warn: string;
  crit: string;
  /** `500 <fontPx>px <family>`: 11 px at the default 16 px root, scaled with the user's font size. */
  font: string;
  fontPx: number;
  fontFamily: string;
}

/** Root font size relative to the 16 px default, so canvas text follows the user's font scaling. */
export function fontScale(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px / 16 : 1;
}

export function readChartTheme(): ChartTheme {
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
