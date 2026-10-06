// Energy from NVML's cumulative counter (gpu0.energy_j) and its display, shared by the Overview, GPU and
// Thermals & Power screens so every screen totals and formats energy the same way. Unit-tested in energy.test.ts.
import { DASH } from '../../lib/format';

const J_PER_KWH = 3.6e6;
const NBSP = '\u00a0';

/**
 * Increase of a cumulative counter over readings, oldest first: every forward step adds; a backward step is a
 * counter reset (driver reload, reboot), after which the counter restarted from zero, so the new reading itself is
 * the energy since the reset. Missing and non-finite readings are skipped.
 */
export function counterIncrease(values: ArrayLike<number | null | undefined>): { joules: number; first: number | null; last: number | null; steps: number } {
  let prev: number | null = null;
  let first: number | null = null;
  let joules = 0;
  let steps = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (prev === null) first = v;
    else {
      joules += v >= prev ? v - prev : v;
      steps++;
    }
    prev = v;
  }
  return { joules, first, last: prev, steps };
}

/** Energy (J) over a series of counter readings, or null when fewer than two readings exist (no interval). */
export function counterDelta(values: ArrayLike<number | null | undefined>): number | null {
  const r = counterIncrease(values);
  return r.steps ? r.joules : null;
}

/**
 * Energy over a history response for a counter key. Rollups store the counter's last value per bucket, so the
 * first bucket's own increase is recovered from its minimum (the reading nearest the range start) when present.
 */
export function historyEnergy(series: readonly (number | null)[] | undefined, min?: readonly (number | null)[]): number | null {
  if (!series?.length) return null;
  const firstIdx = series.findIndex((v) => v != null);
  const start = firstIdx >= 0 ? min?.[firstIdx] : null;
  return counterDelta(start != null ? [start, ...series.slice(firstIdx)] : series);
}

/**
 * Extend a history total with newer live readings of the same counter. The live window may overlap the last history
 * bucket (bucket timestamps are centres or means, not ends), so leading readings at or below the last history reading
 * are already counted and are skipped: the counter only grows, so they precede it. From the first reading above it,
 * increases count as usual (restarts within the live readings included).
 */
export function extendCounter(lastHistory: number | null, liveValues: readonly (number | null)[]): number {
  let start = 0;
  if (lastHistory != null) {
    while (start < liveValues.length && (liveValues[start] == null || (liveValues[start] ?? 0) <= lastHistory)) start++;
  }
  const rest = liveValues.slice(start);
  const inc = counterIncrease(rest);
  const seam = lastHistory != null && inc.first != null ? inc.first - lastHistory : 0;
  return inc.joules + seam;
}

/** Energy over a counter's history plus the live readings after it (see extendCounter): totals that are as fresh as
 *  the live view, not as old as the last closed history bucket. `liveAfter` reads live values newer than a time. */
export function historyPlusLive(resp: { ts: readonly number[]; resolution_s: number; series: Record<string, readonly (number | null)[]>; min: Record<string, readonly (number | null)[]> }, key: string, liveAfter: (ts: number) => readonly (number | null)[]): number | null {
  const values = resp.series[key] ?? [];
  const base = historyEnergy(values, resp.min[key]);
  let i = values.length - 1;
  while (i >= 0 && values[i] == null) i--;
  if (i < 0) return base;
  // Live readings from the start of the last bucket on: extendCounter skips the ones that bucket already counted.
  const extra = extendCounter(values[i] ?? null, liveAfter((resp.ts[i] ?? 0) - resp.resolution_s));
  return (base ?? 0) + extra;
}

export const joulesToKwh = (j: number) => j / J_PER_KWH;

/** Energy for display: Wh below 1 kWh (a 3-minute window is a few Wh), kWh with 2 decimals above. */
export function formatEnergyAuto(joules: number | null | undefined): string {
  if (joules == null || !Number.isFinite(joules)) return DASH;
  const kwh = joulesToKwh(Math.max(0, joules));
  if (kwh >= 0.9995) return `${kwh.toFixed(kwh >= 100 ? 0 : 2)}${NBSP}kWh`;
  const wh = kwh * 1000;
  return `${wh.toFixed(wh >= 100 ? 0 : wh >= 10 ? 1 : 2)}${NBSP}Wh`;
}

/** Energy in kWh with 3 significant figures ("0.812 kWh", "1.22 kWh"): one unit for a figure that grows all day,
 *  so it never appears to drop when it crosses from Wh to kWh. */
export function formatKwh(joules: number | null | undefined): string {
  if (joules == null || !Number.isFinite(joules)) return DASH;
  const kwh = joulesToKwh(Math.max(0, joules));
  return `${kwh.toFixed(kwh >= 100 ? 0 : kwh >= 10 ? 1 : kwh >= 1 ? 2 : 3)}${NBSP}kWh`;
}

/** Cost of `joules` at `ratePerKwh`, e.g. "£0.42"; amounts that round to zero read "< £0.01" rather than "£0.00". */
export function formatEnergyCost(joules: number | null | undefined, ratePerKwh: number, currency: string): string {
  if (joules == null || !Number.isFinite(joules) || !Number.isFinite(ratePerKwh)) return DASH;
  const amount = joulesToKwh(Math.max(0, joules)) * ratePerKwh;
  if (amount > 0 && amount < 0.005) return `<${NBSP}${currency}0.01`;
  return `${currency}${amount.toFixed(2)}`;
}

/** Local midnight (epoch seconds) of the day containing `nowS`. */
export function startOfDay(nowS: number): number {
  const d = new Date(nowS * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}
