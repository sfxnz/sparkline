// Power arithmetic for the Thermals & Power tab (energy maths is shared: views/shared/energy.ts).

/** Mean and peak of a power series (W). `peaks` (per-bucket maxima) are used for the peak when available. */
export function powerStats(values: ArrayLike<number | null>, peaks?: ArrayLike<number | null>): { avg: number | null; peak: number | null } {
  let sum = 0;
  let n = 0;
  let peak: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    n++;
    const p = peaks?.[i] ?? v;
    if (peak === null || p > peak) peak = p;
  }
  return { avg: n ? sum / n : null, peak };
}
