// Alert-rule editing model: metric labels and units, display <-> wire conversion (bytes are edited in GiB),
// validation, dirty tracking and attribution of API errors to a rule. Pure, unit-tested.
import { THROTTLE_REASONS } from '../../lib/throttle';
import type { AlertRule } from '../../lib/types';

export const GIB = 1024 ** 3;

export type RuleUnit = 'celsius' | 'gib' | 'percent' | 'watts' | 'mhz' | 'plain';
export const UNIT_SUFFIX: Record<RuleUnit, string> = { celsius: '°C', gib: 'GiB', percent: '%', watts: 'W', mhz: 'MHz', plain: '' };

export interface MetricMeta {
  key: string;
  label: string;
  unit: RuleUnit;
}

/** Metrics offered in the rule editor (threshold rules). Keys are flattened metric keys; `*` matches any part. */
export const RULE_METRICS: readonly MetricMeta[] = [
  { key: 'gpu0.temp_c', label: 'GPU temperature', unit: 'celsius' },
  { key: 'gpu0.util', label: 'GPU utilisation', unit: 'percent' },
  { key: 'gpu0.power_w', label: 'GPU power', unit: 'watts' },
  { key: 'gpu0.sm_mhz', label: 'GPU SM clock', unit: 'mhz' },
  { key: 'gpu0.power_capped_pct', label: 'Time GPU power-capped', unit: 'percent' },
  { key: 'gpu0.thermal_capped_pct', label: 'Time GPU thermal-capped', unit: 'percent' },
  { key: 'mem.available', label: 'Memory available', unit: 'gib' },
  { key: 'mem.used', label: 'Memory used', unit: 'gib' },
  { key: 'mem.used_pct', label: 'Memory used (share)', unit: 'percent' },
  { key: 'mem.swap_used', label: 'Swap used', unit: 'gib' },
  { key: 'mem.psi_some', label: 'Memory pressure (some stalled)', unit: 'percent' },
  { key: 'mem.psi_full', label: 'Memory pressure (all stalled)', unit: 'percent' },
  { key: 'cpu.util', label: 'CPU utilisation', unit: 'percent' },
  { key: 'cpu.load1', label: 'CPU load average (1 min)', unit: 'plain' },
  { key: 'cpu.psi_some', label: 'CPU pressure', unit: 'percent' },
  { key: 'fs.root.used_pct', label: 'Root disk used', unit: 'percent' },
  { key: 'fs.*.used_pct', label: 'Any disk used', unit: 'percent' },
  { key: 'disk.*.busy_pct', label: 'NVMe busy', unit: 'percent' },
  { key: 'temp.nvme.composite', label: 'NVMe temperature', unit: 'celsius' },
  { key: 'temp.*', label: 'Any temperature sensor', unit: 'celsius' },
];

const BY_KEY = new Map(RULE_METRICS.map((m) => [m.key, m]));

/** Unit for any key, mirroring the console's own formatting (server alerts.py fmt_value). */
export function unitFor(key: string | null): RuleUnit {
  if (!key) return 'plain';
  const known = BY_KEY.get(key);
  if (known) return known.unit;
  if (key.endsWith('temp_c') || key.startsWith('temp.')) return 'celsius';
  if (key.startsWith('mem.') && !key.startsWith('mem.psi') && !key.endsWith('_pct')) return 'gib';
  if (key.endsWith('_pct') || key.endsWith('.util') || key.includes('.psi')) return 'percent';
  if (key.endsWith('power_w')) return 'watts';
  if (key.endsWith('_mhz') || key.endsWith('.mhz')) return 'mhz';
  return 'plain';
}

export function metricMeta(key: string | null): MetricMeta {
  if (!key) return { key: '', label: 'No metric', unit: 'plain' };
  return BY_KEY.get(key) ?? { key, label: key, unit: unitFor(key) };
}

/** Wire value -> the number shown in the editor. */
export function toDisplay(value: number | null, unit: RuleUnit): string {
  if (value == null || !Number.isFinite(value)) return '';
  const v = unit === 'gib' ? value / GIB : value;
  return String(Math.round(v * 100) / 100);
}

/** Editor text -> wire value, or null when it is not a number. */
export function fromDisplay(text: string, unit: RuleUnit): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return unit === 'gib' ? Math.round(n * GIB) : n;
}

const RANGE: Record<RuleUnit, [number, number]> = {
  celsius: [0, 150],
  gib: [0, 4096],
  percent: [0, 100],
  watts: [0, 10_000],
  mhz: [0, 10_000],
  plain: [-1e9, 1e9],
};

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
    const unit = unitFor(rule.metric);
    const v = fromDisplay(d.thresholdText, unit);
    const [lo, hi] = RANGE[unit];
    const suffix = UNIT_SUFFIX[unit] ? ` ${UNIT_SUFFIX[unit]}` : '';
    if (v === null) e.threshold = 'Enter a number.';
    else {
      const shown = unit === 'gib' ? v / GIB : v;
      if (shown < lo || shown > hi) e.threshold = `Use ${lo} to ${hi}${suffix}.`;
    }
  }
  if (rule.kind === 'throttle' && !(rule.threshold && Math.trunc(rule.threshold) > 0)) e.mask = 'Pick at least one reason.';
  return e;
}

export const hasErrors = (e: RuleErrors) => Object.keys(e).length > 0;

/** Draft -> wire rule. Only call when validateDraft returned no errors. */
export function fromDraft(d: RuleDraft): AlertRule {
  const r = { ...d.rule, name: d.rule.name.trim() };
  r.for_s = fromDisplay(d.forText, 'plain') ?? r.for_s;
  if (r.kind === 'threshold') r.threshold = fromDisplay(d.thresholdText, unitFor(r.metric)) ?? r.threshold;
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
