import { THROTTLE_REASONS } from '../../lib/throttle';
import type { AlertRule } from '../../lib/types';

export const GIB = 1024 ** 3;

export type RuleUnit = 'celsius' | 'gib' | 'percent' | 'watts' | 'mhz' | 'mbit_s' | 'mbyte_s' | 'kwh' | 'plain';

interface UnitSpec {
  suffix: string;
  wirePerUnit: number;
  range: [number, number];
}

export const UNITS: Record<RuleUnit, UnitSpec> = {
  celsius: { suffix: '°C', wirePerUnit: 1, range: [0, 150] },
  gib: { suffix: 'GiB', wirePerUnit: GIB, range: [0, 4096] },
  percent: { suffix: '%', wirePerUnit: 1, range: [0, 100] },
  watts: { suffix: 'W', wirePerUnit: 1, range: [0, 10_000] },
  mhz: { suffix: 'MHz', wirePerUnit: 1, range: [0, 10_000] },
  mbit_s: { suffix: 'Mb/s', wirePerUnit: 1e6 / 8, range: [0, 10_000_000] },
  mbyte_s: { suffix: 'MB/s', wirePerUnit: 1e6, range: [0, 1_000_000] },
  kwh: { suffix: 'kWh', wirePerUnit: 3.6e6, range: [0, 1_000_000] },
  plain: { suffix: '', wirePerUnit: 1, range: [-1e9, 1e9] },
};

const UNIT_PATTERNS: readonly (readonly [string, RuleUnit])[] = [
  ['*temp_c', 'celsius'],
  ['temp.*', 'celsius'],
  ['*.psi*', 'percent'],
  ['*_pct', 'percent'],
  ['*.util', 'percent'],
  ['*_util', 'percent'],
  ['mem.*', 'gib'],
  ['fs.*.used', 'gib'],
  ['fs.*.total', 'gib'],
  ['fs.*.free', 'gib'],
  ['*power_w', 'watts'],
  ['*_mhz', 'mhz'],
  ['*.mhz', 'mhz'],
  ['disk.*_bps', 'mbyte_s'],
  ['*_bps', 'mbit_s'],
  ['*energy_j', 'kwh'],
];

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
const UNIT_MATCHERS = UNIT_PATTERNS.map(([glob, unit]) => [globToRegExp(glob), unit] as const);

export interface MetricMeta {
  key: string;
  label: string;
}

/** Metrics offered in the rule editor (threshold rules). Keys are flattened metric keys; `*` matches any part. */
export const RULE_METRICS: readonly MetricMeta[] = [
  { key: 'gpu0.temp_c', label: 'GPU temperature' },
  { key: 'gpu0.util', label: 'GPU utilisation' },
  { key: 'gpu0.power_w', label: 'GPU power' },
  { key: 'gpu0.sm_mhz', label: 'GPU SM clock' },
  { key: 'gpu0.power_capped_pct', label: 'Time GPU power-capped' },
  { key: 'gpu0.thermal_capped_pct', label: 'Time GPU thermal-capped' },
  { key: 'mem.available', label: 'Memory available' },
  { key: 'mem.used', label: 'Memory used' },
  { key: 'mem.used_pct', label: 'Memory used (share)' },
  { key: 'mem.swap_used', label: 'Swap used' },
  { key: 'mem.psi_some', label: 'Memory pressure (some stalled)' },
  { key: 'mem.psi_full', label: 'Memory pressure (all stalled)' },
  { key: 'cpu.util', label: 'CPU utilisation' },
  { key: 'cpu.load1', label: 'CPU load average (1 min)' },
  { key: 'cpu.psi_some', label: 'CPU pressure' },
  { key: 'fs.root.used_pct', label: 'Root disk used' },
  { key: 'fs.*.used_pct', label: 'Any disk used' },
  { key: 'disk.*.busy_pct', label: 'NVMe busy' },
  { key: 'temp.nvme.composite', label: 'NVMe temperature' },
  { key: 'temp.*', label: 'Any temperature sensor' },
];

const BY_KEY = new Map(RULE_METRICS.map((m) => [m.key, m]));

export function unitFor(key: string | null): RuleUnit {
  if (!key) return 'plain';
  return UNIT_MATCHERS.find(([re]) => re.test(key))?.[1] ?? 'plain';
}

export function metricMeta(key: string | null): MetricMeta {
  if (!key) return { key: '', label: 'No metric' };
  return BY_KEY.get(key) ?? { key, label: key };
}

/** Wire value -> the number shown in the editor. */
export function toDisplay(value: number | null, unit: RuleUnit): string {
  if (value == null || !Number.isFinite(value)) return '';
  return String(Math.round((value / UNITS[unit].wirePerUnit) * 100) / 100);
}

/** Editor text -> wire value, or null when it is not a number. */
export function fromDisplay(text: string, unit: RuleUnit): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const { wirePerUnit } = UNITS[unit];
  return wirePerUnit === 1 ? n : Math.round(n * wirePerUnit);
}

export interface RuleDraft {
  rule: AlertRule;
  /** Threshold in display units (threshold rules). */
  thresholdText: string;
  forText: string;
}

export type RuleErrors = Partial<Record<'name' | 'threshold' | 'for_s' | 'mask', string>>;

export function toDraft(rule: AlertRule): RuleDraft {
  return {
    rule,
    thresholdText: rule.kind === 'threshold' ? toDisplay(rule.threshold, unitFor(rule.metric)) : '',
    forText: toDisplay(rule.for_s, 'plain'),
  };
}

export function validateDraft(d: RuleDraft): RuleErrors {
  const e: RuleErrors = {};
  const { rule } = d;
  if (!rule.name.trim()) e.name = 'Give the rule a name.';
  else if (rule.name.length > 80) e.name = 'Keep the name under 80 characters.';
  const forS = fromDisplay(d.forText, 'plain');
  if (forS === null) e.for_s = 'Enter a duration in seconds.';
  else if (forS < 0 || forS > 86_400) e.for_s = 'Use 0 to 86400 seconds (24 h).';
  if (rule.kind === 'threshold') {
    const { suffix, range: [lo, hi] } = UNITS[unitFor(rule.metric)];
    const shown = fromDisplay(d.thresholdText, 'plain');
    if (shown === null) e.threshold = 'Enter a number.';
    else if (shown < lo || shown > hi) e.threshold = `Use ${lo} to ${hi}${suffix ? ` ${suffix}` : ''}.`;
  }
  if (rule.kind === 'throttle' && !(rule.threshold && Math.trunc(rule.threshold) > 0)) e.mask = 'Pick at least one reason.';
  return e;
}

export const hasErrors = (e: RuleErrors) => Object.keys(e).length > 0;

/** Draft -> wire rule. Only call when validateDraft returned no errors. */
export function fromDraft(d: RuleDraft): AlertRule {
  const r = { ...d.rule, name: d.rule.name.trim() };
  r.for_s = fromDisplay(d.forText, 'plain') ?? r.for_s;
  if (r.kind === 'threshold') {
    const unit = unitFor(r.metric);
    if (d.thresholdText !== toDisplay(r.threshold, unit)) r.threshold = fromDisplay(d.thresholdText, unit) ?? r.threshold;
  }
  return r;
}

/** Edited compared with the saved rule (text compared as typed, so "80" -> "80.0" still counts as unchanged). */
export function draftChanged(d: RuleDraft, saved: AlertRule | undefined): boolean {
  if (!saved) return true;
  const s = toDraft(saved);
  const r = d.rule;
  const num = (t: string, unit: RuleUnit) => fromDisplay(t, unit) ?? t;
  return (
    r.name !== saved.name ||
    r.enabled !== saved.enabled ||
    r.metric !== saved.metric ||
    r.op !== saved.op ||
    r.severity !== saved.severity ||
    (r.kind === 'throttle' && r.threshold !== saved.threshold) ||
    num(d.forText, 'plain') !== num(s.forText, 'plain') ||
    (r.kind === 'threshold' && num(d.thresholdText, unitFor(r.metric)) !== num(s.thresholdText, unitFor(saved.metric)))
  );
}

/** Throttle reasons as checkbox state for a rule's bitmask. */
export function maskReasons(mask: number | null): { bit: number; title: string; explanation: string; checked: boolean }[] {
  const m = mask == null ? 0 : Math.trunc(mask);
  return THROTTLE_REASONS.map((r) => ({ bit: r.bit, title: r.title, explanation: r.explanation, checked: (m & r.bit) !== 0 }));
}

export function toggleBit(mask: number | null, bit: number, on: boolean): number {
  const m = mask == null ? 0 : Math.trunc(mask);
  return on ? m | bit : m & ~bit;
}

/** "Rule 'gpu_temp_high': for_s must be >= 0" -> "gpu_temp_high" (validate_rules wording). */
export function ruleIdInError(cause: string): string | null {
  return /Rule '([^']+)'/.exec(cause)?.[1] ?? /rule id '([^']+)'/i.exec(cause)?.[1] ?? null;
}

/** Plain-English condition for rules without a metric threshold. */
export const KIND_CONDITION: Record<Exclude<AlertRule['kind'], 'threshold' | 'throttle'>, string> = {
  node_offline: 'When a node stops responding or its agent is unreachable',
  link_down: 'When a cabled ConnectX-7 link or its RDMA port goes down',
};
