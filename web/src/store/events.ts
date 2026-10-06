import { create } from 'zustand';
import type { Event } from '../lib/types';

export const MAX_EVENTS = 500;

/** Back-fill of the timeline from /api/v1/events (the stream only carries events raised from now on). */
export type EventsLoad = { status: 'idle' | 'loading' | 'ready' } | { status: 'error'; error: unknown };

interface EventsStore {
  /** Newest first, at most MAX_EVENTS. */
  events: Event[];
  load: EventsLoad;
  upsert: (e: Event) => void;
  replace: (events: Event[]) => void;
}

const sortNewest = (a: Event, b: Event) => b.ts - a.ts || b.id - a.id;

/** Two copies of one event: acked and resolved only ever move forward, so keep the most advanced state. */
export function mergeEvent(a: Event, b: Event): Event {
  return { ...a, ...b, acked: a.acked || b.acked, resolved_ts: b.resolved_ts ?? a.resolved_ts };
}

/** Union by id (newest first): /api/v1/events can arrive after the stream already delivered some events. */
export function mergeEvents(current: readonly Event[], fetched: readonly Event[]): Event[] {
  const byId = new Map<number, Event>();
  for (const e of fetched) byId.set(e.id, e);
  for (const e of current) {
    const f = byId.get(e.id);
    byId.set(e.id, f ? mergeEvent(f, e) : e);
  }
  return [...byId.values()].sort(sortNewest);
}

export const useEvents = create<EventsStore>()((set) => ({
  events: [],
  load: { status: 'idle' },
  upsert: (e) => {
    set((s) => {
      const rest = s.events.filter((x) => x.id !== e.id);
      return { events: [e, ...rest].sort(sortNewest).slice(0, MAX_EVENTS) };
    });
  },
  replace: (events) => {
    set({ events: [...events].sort(sortNewest).slice(0, MAX_EVENTS) });
  },
}));

/** Alerts that are still firing (not resolved). */
export const openAlertCount = (events: readonly Event[]) =>
  events.filter((e) => e.kind === 'alert' && e.resolved_ts == null && e.severity !== 'info').length;

/** Highest severity among the open warning/critical alerts on one node, or null when none is open. */
export function openAlertLevel(events: readonly Event[], nodeId: string): 'warning' | 'critical' | null {
  let level: 'warning' | null = null;
  for (const e of events) {
    if (e.kind !== 'alert' || e.resolved_ts != null || e.node_id !== nodeId) continue;
    if (e.severity === 'critical') return 'critical';
    if (e.severity === 'warning') level = 'warning';
  }
  return level;
}
