// Temperature sensor grouping and headroom for the Thermals & Power tab. Pure; unit-tested in thermal.test.ts.
import type { NodeInfo, SensorInfo } from '../../../lib/types';

export type GroupId = 'gpu' | 'soc' | 'nvme' | 'nic' | 'other';

export interface Sensor {
  /** Flattened metric key: "gpu0.temp_c" or "temp.<sensor id>". */
  key: string;
  label: string;
  /** Limit the headroom is measured against, and what it is called. */
  limit: number | null;
  limitLabel: string;
  /** A second, harder limit drawn on the chart (GPU shutdown). */
  hardLimit: number | null;
}

export interface SensorGroup {
  id: GroupId;
  title: string;
  sensors: Sensor[];
}

const GROUPS: readonly { id: GroupId; title: string }[] = [
  { id: 'gpu', title: 'GPU' },
  { id: 'soc', title: 'SoC · ACPI zones' },
  { id: 'nvme', title: 'NVMe' },
  { id: 'nic', title: 'ConnectX-7' },
  { id: 'other', title: 'Other sensors' },
];

const groupOf = (s: SensorInfo): GroupId => (s.group === 'soc' || s.group === 'nvme' || s.group === 'nic' ? s.group : s.group === 'gpu' ? 'gpu' : 'other');

/** Sensors by group in display order (GPU first), empty groups dropped. GPU temperatures come from NodeInfo.gpus. */
export function buildGroups(info: NodeInfo | null | undefined): SensorGroup[] {
  if (!info) return [];
  const by = new Map<GroupId, Sensor[]>(GROUPS.map((g) => [g.id, []]));
  for (const g of info.gpus) {
    by.get('gpu')?.push({
      key: `gpu${g.index}.temp_c`,
      label: info.gpus.length > 1 ? `${g.name} #${g.index}` : g.name,
      limit: g.temp_slowdown_c,
      limitLabel: 'slowdown',
      hardLimit: g.temp_shutdown_c,
    });
  }
  for (const s of info.sensors) {
    by.get(groupOf(s))?.push({ key: `temp.${s.id}`, label: s.label, limit: s.crit_c, limitLabel: 'critical', hardLimit: null });
  }
  return GROUPS.map((g) => ({ ...g, sensors: by.get(g.id) ?? [] })).filter((g) => g.sensors.length > 0);
}

/** Reads the latest value of a metric key (from the LiveStore, which also holds seeded history). */
export type Reader = (key: string) => number | null;

export type HeadroomTone = 'ok' | 'warn' | 'crit';

/** Degrees below the limit, with a status tone: within 5 °C is a warning, at or past the limit is critical. */
export function headroom(current: number | null, limit: number | null): { degrees: number; tone: HeadroomTone } | null {
  if (current == null || limit == null || !Number.isFinite(current) || !Number.isFinite(limit)) return null;
  const degrees = limit - current;
  return { degrees, tone: degrees <= 0 ? 'crit' : degrees < 5 ? 'warn' : 'ok' };
}

/** The hottest current reading across groups, for the header. */
export function hottest(groups: readonly SensorGroup[], read: Reader): { label: string; c: number } | null {
  let best: { label: string; c: number } | null = null;
  for (const g of groups)
    for (const s of g.sensors) {
      const c = read(s.key);
      if (c != null && (best === null || c > best.c)) best = { label: s.label, c };
    }
  return best;
}

/** Charts use at most four series (the palette has four colours, never cycled): the hottest four at selection time. */
export const MAX_CHART_SERIES = 4;
export function chartSensors(group: SensorGroup, read: Reader): Sensor[] {
  if (group.sensors.length <= MAX_CHART_SERIES) return group.sensors;
  const scored = group.sensors.map((s, i) => ({ s, i, c: read(s.key) ?? -Infinity }));
  return scored
    .sort((a, b) => b.c - a.c || a.i - b.i)
    .slice(0, MAX_CHART_SERIES)
    .sort((a, b) => a.i - b.i) // keep sensor order so colours follow the sensor, not its rank
    .map((x) => x.s);
}

/** Min and max of a numeric window, nulls ignored. */
export function minMax(values: ArrayLike<number | null>): { min: number | null; max: number | null } {
  let min: number | null = null;
  let max: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) continue;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return { min, max };
}

/** Legend labels without a first word every sensor in the group shares ("ACPI zone 2" -> "Zone 2"). */
export function shortLabels(labels: readonly string[]): string[] {
  const first = labels.map((l) => l.split(' ')[0] ?? '');
  const shared = labels.length > 1 && first.every((w) => w === first[0]) && labels.every((l) => l.includes(' '));
  if (!shared) return [...labels];
  return labels.map((l) => {
    const rest = l.slice(l.indexOf(' ') + 1);
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  });
}
