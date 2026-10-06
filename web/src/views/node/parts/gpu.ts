// GPU tab arithmetic: observed peaks, means and temperature headroom (energy maths: views/shared/energy.ts).

/** Largest value across the series (and its per-bucket maxima, when history provides them). */
export function peak(...series: readonly (readonly (number | null)[] | undefined)[]): number | null {
  let best: number | null = null;
  for (const s of series) {
    if (!s) continue;
    for (const v of s) if (v != null && Number.isFinite(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/** Mean of the non-null values (e.g. % of time power-capped across a range). */
export function mean(values: readonly (number | null)[] | undefined): number | null {
  if (!values) return null;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    n++;
  }
  return n ? sum / n : null;
}

export interface Headroom {
  /** Degrees below the slowdown threshold (negative when above it). */
  toSlowdown: number | null;
  toShutdown: number | null;
  level: 'ok' | 'warn' | 'crit';
  text: string;
}

/** Plain-English headroom to the GPU's own thresholds (GB10: slowdown 86 °C, shutdown 90 °C). */
export function tempHeadroom(temp: number | null, slowdown: number | null, shutdown: number | null): Headroom | null {
  if (temp == null || !Number.isFinite(temp)) return null;
  const toSlowdown = slowdown == null ? null : slowdown - temp;
  const toShutdown = shutdown == null ? null : shutdown - temp;
  const deg = (v: number) => `${Math.round(Math.abs(v))} °C`;
  if (toShutdown !== null && toShutdown <= 0) return { toSlowdown, toShutdown, level: 'crit', text: `At or above shutdown (${shutdown ?? ''} °C)` };
  if (toSlowdown !== null && toSlowdown <= 0) {
    return { toSlowdown, toShutdown, level: 'crit', text: `${deg(toSlowdown)} over slowdown${toShutdown !== null ? ` · ${deg(toShutdown)} to shutdown` : ''}` };
  }
  if (toSlowdown !== null) return { toSlowdown, toShutdown, level: toSlowdown <= 6 ? 'warn' : 'ok', text: `${deg(toSlowdown)} below slowdown (${slowdown ?? ''} °C)` };
  if (toShutdown !== null) return { toSlowdown, toShutdown, level: toShutdown <= 6 ? 'warn' : 'ok', text: `${deg(toShutdown)} below shutdown` };
  return null;
}
