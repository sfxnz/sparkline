// Storage helpers: capacity levels (from the configured disk-space alert rules) and throughput/IOPS formatting.
import { DASH, type Formatter } from '../../../lib/format';
import type { AlertRule, FsSample } from '../../../lib/types';

/** One disk-space alert threshold that applies to a filesystem. */
export interface CapacityRule {
  pct: number;
  severity: AlertRule['severity'];
  name: string;
}

/**
 * The enabled "used above N %" rules for one filesystem on one node (metric `fs.<key>.used_pct`), lowest first. The
 * Storage tab colours and marks capacity with exactly these, so it never states a policy the alerts do not follow.
 */
export function capacityRules(rules: readonly AlertRule[], node: string, fsKey: string): CapacityRule[] {
  return rules
    .filter((r) => r.enabled && r.kind === 'threshold' && r.op === '>' && r.threshold != null && r.metric === `fs.${fsKey}.used_pct` && (!r.nodes || r.nodes.includes(node)))
    .map((r) => ({ pct: r.threshold ?? 0, severity: r.severity, name: r.name }))
    .sort((a, b) => a.pct - b.pct);
}

/** "Alerts at 90% used on / (Disk almost full)" / "…, critical at 95%…" / "No disk-space alert is set for /". */
export function capacityPolicy(rules: readonly CapacityRule[], mount = ''): string {
  const on = mount ? ` on ${mount}` : '';
  if (!rules.length) return `No disk-space alert is set${on || ' for this filesystem'}`;
  const parts = rules.map((r, i) => `${i === 0 ? '' : `${r.severity} `}at ${+r.pct.toFixed(1)}%`);
  return `Alerts ${parts.join(', ')} used${on} (${rules.map((r) => r.name).join(', ')})`;
}

/** Used share like `df`: used / (used + free); reserved blocks are excluded. Null when the size is unknown. */
export function fsUsedPct(fs: Pick<FsSample, 'used' | 'free'>): number | null {
  const denom = fs.used + fs.free;
  return denom > 0 ? (100 * fs.used) / denom : null;
}

export type CapacityLevel = 'ok' | 'warn' | 'crit';

/** The level of the most severe rule the usage is above (rules fire on "> threshold"). */
export function capacityLevel(pct: number | null | undefined, rules: readonly CapacityRule[]): CapacityLevel {
  if (pct == null || Number.isNaN(pct)) return 'ok';
  let level: CapacityLevel = 'ok';
  for (const r of rules) {
    if (pct <= r.pct) continue;
    if (r.severity === 'critical') return 'crit';
    if (r.severity === 'warning') level = 'warn';
  }
  return level;
}

export const CAPACITY_LABEL: Record<CapacityLevel, string> = { ok: 'OK', warn: 'Getting full', crit: 'Almost full' };

/** df-style figures on one denominator: usable = used + free (what the % is of); reserved = blocks kept for root. */
export function fsFigures(fs: Pick<FsSample, 'used' | 'free' | 'total'>): { pct: number | null; usable: number; reserved: number } {
  const usable = fs.used + fs.free;
  return { pct: fsUsedPct(fs), usable, reserved: Math.max(0, fs.total - usable) };
}

const RATE_UNITS = ['B/s', 'kB/s', 'MB/s', 'GB/s', 'TB/s'] as const;
/**
 * Bytes per second, SI like drive datasheets, 3 significant figures: "412 MB/s", "2.05 GB/s". Decimal units also
 * give round chart ticks. Keeps a requested unit while a number animates across a boundary.
 */
export const bytesRateParts: Formatter = (n, unit) => {
  if (!Number.isFinite(n)) return { value: DASH, unit: '' };
  let i = unit ? Math.max(0, RATE_UNITS.indexOf(unit as (typeof RATE_UNITS)[number])) : 0;
  if (!unit) while (i < RATE_UNITS.length - 1 && Math.abs(n) >= 1000 ** (i + 1) * 0.9995) i++;
  const v = n / 1000 ** i;
  const a = Math.abs(v);
  return { value: i === 0 ? v.toFixed(0) : v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2), unit: RATE_UNITS[i] ?? 'B/s' };
};
export const formatBytesRate = (n: number) => {
  const p = bytesRateParts(n);
  return p.value === DASH ? DASH : `${p.value} ${p.unit}`;
};

/** Operations per second: "842", "12.4k". */
export const iopsParts: Formatter = (n, unit) => {
  if (!Number.isFinite(n)) return { value: DASH, unit: '' };
  if (unit === 'k IOPS' || (!unit && n >= 9999.5)) return { value: (n / 1000).toFixed(1), unit: 'k IOPS' };
  return { value: Math.round(n).toString(), unit: 'IOPS' };
};
export const formatIops = (n: number) => {
  const p = iopsParts(n);
  return p.value === DASH ? DASH : p.unit === 'k IOPS' ? `${p.value}k` : p.value;
};
