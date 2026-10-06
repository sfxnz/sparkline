// Pure event-timeline logic: open alerts, filters, day groups and the alert <-> recovery links.
// Kept free of React so it is unit-tested directly. (Merging fetched + streamed events lives in store/events.)
import type { Event, Severity } from '../../lib/types';

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export const isOpenAlert = (e: Event) => e.kind === 'alert' && e.resolved_ts == null;

/** Firing alerts, worst first, then newest first. */
export function openAlerts(events: readonly Event[]): Event[] {
  return events.filter(isOpenAlert).sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.ts - a.ts);
}

export type KindFilter = 'all' | Event['kind'];
export type SeverityFilter = 'all' | Severity;
export interface Filters {
  node: string; // 'all' or a node id
  severity: SeverityFilter;
  kind: KindFilter;
}
export const NO_FILTERS: Filters = { node: 'all', severity: 'all', kind: 'all' };

export function filterEvents(events: readonly Event[], f: Filters): Event[] {
  return events.filter(
    (e) => (f.node === 'all' || e.node_id === f.node) && (f.severity === 'all' || e.severity === f.severity) && (f.kind === 'all' || e.kind === f.kind),
  );
}

export const isFiltered = (f: Filters) => f.node !== 'all' || f.severity !== 'all' || f.kind !== 'all';

export interface DayGroup {
  key: string; // YYYY-MM-DD (local)
  label: string; // "Today", "Yesterday", "Monday 5 October"
  events: Event[];
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function dayLabel(ts: number, now: number): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return 'Today';
  const y = new Date(now * 1000);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.getTime() / 1000)) return 'Yesterday';
  const d = new Date(ts * 1000);
  const sameYear = d.getFullYear() === new Date(now * 1000).getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Group newest-first events by local calendar day, preserving order. */
export function groupByDay(events: readonly Event[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const e of events) {
    const key = dayKey(e.ts);
    let g = groups[groups.length - 1];
    if (g?.key !== key) {
      g = { key, label: dayLabel(e.ts, now), events: [] };
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups;
}

export interface Links {
  /** alert id -> its recovery event */
  recoveryOf: Map<number, Event>;
  /** recovery id -> the alert it cleared */
  alertOf: Map<number, Event>;
}

/**
 * The engine resolves an alert and records its recovery with the same timestamp, rule, node and metric
 * (server/sparkline/console/alerts.py `_step`), so the pair is matched on those fields.
 */
export function linkRecoveries(events: readonly Event[]): Links {
  const recoveryOf = new Map<number, Event>();
  const alertOf = new Map<number, Event>();
  const pending = new Map<string, Event[]>();
  const sig = (e: Event) => `${e.rule_id ?? ''}|${e.node_id ?? ''}|${e.metric ?? ''}`;
  for (const e of events) {
    if (e.kind !== 'alert' || e.resolved_ts == null) continue;
    const list = pending.get(sig(e));
    if (list) list.push(e);
    else pending.set(sig(e), [e]);
  }
  for (const r of events) {
    if (r.kind !== 'recovered') continue;
    const match = pending.get(sig(r))?.find((a) => a.resolved_ts != null && Math.abs(a.resolved_ts - r.ts) < 0.5 && !recoveryOf.has(a.id));
    if (match) {
      recoveryOf.set(match.id, r);
      alertOf.set(r.id, match);
    }
  }
  return { recoveryOf, alertOf };
}

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };
export const KIND_LABEL: Record<Event['kind'], string> = { alert: 'Alert', recovered: 'Recovered', node: 'Node', bench: 'Benchmark', system: 'System' };
