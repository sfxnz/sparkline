// Console settings form model: text drafts, validation that mirrors server validate_settings (app.py), and
// conversion back to ConsoleSettings. Pure, unit-tested.
import type { ConsoleSettings } from '../../lib/types';

export type SettingsKey = keyof ConsoleSettings;
export type Draft = Record<SettingsKey, string>;
export type Errors = Partial<Record<SettingsKey, string>>;

export const NUMERIC: readonly SettingsKey[] = ['energy_rate_per_kwh', 'stale_after_s', 'offline_after_s', 'regression_pct'];

export function toDraft(s: ConsoleSettings): Draft {
  const n = (v: number) => String(Math.round(v * 10_000) / 10_000);
  return {
    energy_rate_per_kwh: n(s.energy_rate_per_kwh),
    currency: s.currency,
    stale_after_s: n(s.stale_after_s),
    offline_after_s: n(s.offline_after_s),
    regression_pct: n(s.regression_pct),
  };
}

export function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** Validate only the given fields (each settings section saves its own fields). */
export function validate(d: Draft, fields: readonly SettingsKey[] = Object.keys(d) as SettingsKey[]): Errors {
  const e: Errors = {};
  const has = (k: SettingsKey) => fields.includes(k);
  if (has('energy_rate_per_kwh')) {
    const v = parseNumber(d.energy_rate_per_kwh);
    if (v === null) e.energy_rate_per_kwh = 'Enter a price, for example 0.28.';
    else if (v < 0) e.energy_rate_per_kwh = 'The price cannot be negative.';
    else if (v > 100) e.energy_rate_per_kwh = 'That is more than 100 per kWh. Check the decimal point.';
  }
  if (has('currency')) {
    const c = d.currency.trim();
    if (!c) e.currency = 'Enter a currency symbol or code, for example £ or EUR.';
    else if (c.length > 8) e.currency = 'Use at most 8 characters.';
  }
  const stale = parseNumber(d.stale_after_s);
  const offline = parseNumber(d.offline_after_s);
  if (has('stale_after_s')) {
    if (stale === null) e.stale_after_s = 'Enter a number of seconds.';
    else if (stale < 1 || stale > 600) e.stale_after_s = 'Use 1 to 600 seconds.';
  }
  if (has('offline_after_s')) {
    if (offline === null) e.offline_after_s = 'Enter a number of seconds.';
    else if (offline > 3600) e.offline_after_s = 'Use at most 3600 seconds (1 h).';
    else if (stale !== null && offline <= stale) e.offline_after_s = 'Must be longer than the stale delay.';
  }
  if (has('regression_pct')) {
    const v = parseNumber(d.regression_pct);
    if (v === null) e.regression_pct = 'Enter a percentage.';
    else if (v <= 0 || v >= 100) e.regression_pct = 'Use more than 0 and less than 100 %.';
  }
  return e;
}

/** Apply the given fields of a draft on top of the current server settings. Call only when valid. */
export function apply(current: ConsoleSettings, d: Draft, fields: readonly SettingsKey[]): ConsoleSettings {
  const next = { ...current };
  for (const k of fields) {
    if (k === 'currency') next.currency = d.currency.trim();
    else next[k] = parseNumber(d[k]) ?? current[k];
  }
  return next;
}

export function changed(current: ConsoleSettings, d: Draft, fields: readonly SettingsKey[]): boolean {
  const base = toDraft(current);
  return fields.some((k) => (k === 'currency' ? d.currency.trim() !== base.currency : parseNumber(d[k]) !== parseNumber(base[k])));
}

/** "£0.28 per kWh: running at 33 W for 24 h costs about £0.22". Helps people sanity-check the rate. */
export function costExample(rateText: string, currency: string, watts = 35): string | null {
  const rate = parseNumber(rateText);
  if (rate === null || rate < 0) return null;
  const kwh = (watts * 24) / 1000;
  return `At ${watts} W for 24 hours (${kwh.toFixed(2)} kWh) the GPU rail costs about ${currency.trim() || '£'}${(kwh * rate).toFixed(2)}.`;
}

/** Retention copy for the clear-history dialog (agent rollups: 10 s for 7 days, 1 min for 30 days). */
export const RETENTION = '7 days at 10 s, 30 days at 1 min';
