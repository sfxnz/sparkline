// Number formatting. Rules are fixed per unit so live digits do not change width (paired with tabular-nums):
//   bytes      IEC (KiB/MiB/GiB/TiB), 1 decimal (B: integer)
//   bit rates  SI bits/s from bytes/s, 3 significant figures (e.g. 4.59 / 45.9 / 459 Gb/s)
//   °C         integer;  W  1 decimal below 100, else integer;  MHz below 1000, else GHz with 2 decimals
//   %          integer by default;  kWh  3 significant figures;  cost  2 decimals with currency symbol
// Missing values (null/undefined/NaN) render as an em dash, never as 0.

export interface Parts {
  value: string;
  unit: string;
}
/** A formatter may be asked to keep a specific unit (used while a number animates across a unit boundary). */
export type Formatter = (n: number, unit?: string) => Parts;

export const DASH = '—';
const NBSP = ' ';

const missing = (n: number | null | undefined): n is null | undefined =>
  n == null || Number.isNaN(n) || !Number.isFinite(n);

/** Join parts for plain text output. Percent sticks to the number; other units get a no-break space. */
export function text(p: Parts): string {
  if (p.value === DASH) return DASH;
  if (!p.unit) return p.value;
  return p.unit === '%' ? `${p.value}%` : `${p.value}${NBSP}${p.unit}`;
}

function sig3(x: number): string {
  const a = Math.abs(x);
  return x.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

function scaled(n: number, base: number, units: readonly string[], unit?: string): { v: number; u: string } {
  let i = unit ? Math.max(0, units.indexOf(unit)) : 0;
  if (!unit) while (i < units.length - 1 && Math.abs(n) >= base ** (i + 1) * 0.9995) i++;
  return { v: n / base ** i, u: units[i] ?? '' };
}

const IEC = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;
export const bytesParts: Formatter = (n, unit) => {
  if (missing(n)) return { value: DASH, unit: '' };
  const { v, u } = scaled(n, 1024, IEC, unit);
  return { value: v.toFixed(u === 'B' ? 0 : 1), unit: u };
};
export const formatBytes = (n: number | null | undefined) => (missing(n) ? DASH : text(bytesParts(n)));

const BITS = ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'] as const;
/** Input is bytes per second (wire contract); output is bits per second, SI. */
export const bitrateParts: Formatter = (bytesPerSec, unit) => {
  if (missing(bytesPerSec)) return { value: DASH, unit: '' };
  const { v, u } = scaled(bytesPerSec * 8, 1000, BITS, unit);
  return { value: u === 'b/s' ? v.toFixed(0) : sig3(v), unit: u };
};
export const formatBitrate = (n: number | null | undefined) => (missing(n) ? DASH : text(bitrateParts(n)));

export const tempParts: Formatter = (c) =>
  missing(c) ? { value: DASH, unit: '' } : { value: c.toFixed(0), unit: '°C' };
export const formatTemp = (n: number | null | undefined) => (missing(n) ? DASH : text(tempParts(n)));

export const wattsParts: Formatter = (w, unit) => {
  if (missing(w)) return { value: DASH, unit: '' };
  if (unit === 'kW' || (!unit && Math.abs(w) >= 10_000)) return { value: (w / 1000).toFixed(1), unit: 'kW' };
  return { value: w.toFixed(Math.abs(w) < 100 ? 1 : 0), unit: 'W' };
};
export const formatWatts = (n: number | null | undefined) => (missing(n) ? DASH : text(wattsParts(n)));

export const freqParts: Formatter = (mhz, unit) => {
  if (missing(mhz)) return { value: DASH, unit: '' };
  if (unit === 'GHz' || (!unit && mhz >= 999.5)) return { value: (mhz / 1000).toFixed(2), unit: 'GHz' };
  return { value: mhz.toFixed(0), unit: 'MHz' };
};
export const formatFreq = (n: number | null | undefined) => (missing(n) ? DASH : text(freqParts(n)));

export const percentParts: Formatter = (pct) =>
  missing(pct) ? { value: DASH, unit: '' } : { value: pct.toFixed(0), unit: '%' };
export const formatPercent = (n: number | null | undefined, digits = 0) =>
  missing(n) ? DASH : `${n.toFixed(digits)}%`;

/** Joules -> kWh. */
export const energyParts: Formatter = (joules) => {
  if (missing(joules)) return { value: DASH, unit: '' };
  return { value: sig3(joules / 3.6e6), unit: 'kWh' };
};
export const formatEnergy = (n: number | null | undefined) => (missing(n) ? DASH : text(energyParts(n)));

export function formatCost(amount: number | null | undefined, currency = '£'): string {
  if (missing(amount)) return DASH;
  const sign = amount < 0 ? '−' : '';
  return `${sign}${currency}${Math.abs(amount).toFixed(2)}`;
}

/** Cost of `joules` at `ratePerKwh`. */
export const energyCost = (joules: number, ratePerKwh: number) => (joules / 3.6e6) * ratePerKwh;

/** Compact duration: "45 s", "12 min", "1 h 05 min", "3 d 4 h". */
export function formatDuration(seconds: number | null | undefined): string {
  if (missing(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}${NBSP}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${NBSP}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${NBSP}h ${String(m % 60).padStart(2, '0')}${NBSP}min`;
  return `${Math.floor(h / 24)}${NBSP}d ${h % 24}${NBSP}h`;
}

/** "just now", "12 s ago", "4 min ago", "2 h ago", "3 d ago". Both arguments in epoch seconds. */
export function formatAgo(ts: number | null | undefined, now: number = Date.now() / 1000): string {
  if (missing(ts)) return DASH;
  const d = Math.max(0, now - ts);
  if (d < 2) return 'just now';
  if (d < 60) return `${Math.floor(d)}${NBSP}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}${NBSP}min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}${NBSP}h ago`;
  return `${Math.floor(d / 86400)}${NBSP}d ago`;
}

/** Wall-clock time of an epoch-seconds timestamp, 24 h, with seconds. */
export function formatClock(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
