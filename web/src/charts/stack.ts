import uPlot from 'uplot';
import type { StackLayer } from './TimeSeriesChart';

export function runningTotals(layers: readonly ArrayLike<number | null | undefined>[]): (number | null)[][] {
  const out: (number | null)[][] = [];
  layers.forEach((layer, k) => {
    const below = out[k - 1];
    out.push(Array.from(layer, (v, i) => {
      const b = below?.[i] ?? null;
      if (v == null) return b;
      return (b ?? 0) + v;
    }));
  });
  return out;
}

export function stackedSeries(layers: readonly StackLayer[], host: HTMLElement, separatorColor: string): { series: uPlot.Series[]; bands: uPlot.Band[] } {
  const fills = layers.map((l) => {
    const c = segColor(l.className, host);
    return l.hatched ? hatch(c) : c;
  });
  return {
    series: layers.map((l, i) => ({ label: l.label, stroke: separatorColor, width: 1.25, fill: fills[i], points: { show: false }, spanGaps: false })),
    bands: layers.slice(1).map((_, i): uPlot.Band => ({ series: [i + 2, i + 1], fill: fills[i + 1] })),
  };
}

function hatch(color: string): CanvasPattern | string {
  const c = document.createElement('canvas');
  const s = Math.round(8 * uPlot.pxRatio);
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  if (!ctx) return color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.fillRect(0, 0, s, s);
  ctx.globalAlpha = 1;
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

function segColor(className: string, host: HTMLElement): string {
  const probe = document.createElement('span');
  probe.className = className;
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--seg)';
  host.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}
