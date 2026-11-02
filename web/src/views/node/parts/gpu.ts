// GPU tab arithmetic: observed peaks, means and temperature headroom (energy maths: views/shared/energy.ts).
import { tempRoom } from '../../../lib/condition';

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
  const slow = tempRoom(temp, slowdown);
  const off = tempRoom(temp, shutdown);
  const toSlowdown = slow?.degrees ?? null;
  const toShutdown = off?.degrees ?? null;
  const deg = (v: number) => `${Math.abs(v)} °C`;
  const toOff = toShutdown !== null ? ` · ${deg(toShutdown)} to shutdown` : '';
  if (off?.level === 'crit') return { toSlowdown, toShutdown, level: off.level, text: `At or above shutdown (${shutdown ?? ''} °C)` };
  if (slow?.degrees === 0) return { toSlowdown, toShutdown, level: slow.level, text: `At slowdown (${slowdown ?? ''} °C)${toOff}` };
  if (slow && slow.degrees < 0) return { toSlowdown, toShutdown, level: slow.level, text: `${deg(slow.degrees)} over slowdown${toOff}` };
  if (slow) return { toSlowdown, toShutdown, level: slow.level, text: `${deg(slow.degrees)} below slowdown (${slowdown ?? ''} °C)` };
  if (off) return { toSlowdown, toShutdown, level: off.level, text: `${deg(off.degrees)} below shutdown` };
  return null;
}
