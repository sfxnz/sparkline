import { create } from 'zustand';
import type { Event } from '../lib/types';

export const MAX_EVENTS = 500;

interface EventsStore {
  /** Newest first, at most MAX_EVENTS. */
  events: Event[];
  upsert: (e: Event) => void;
  replace: (events: Event[]) => void;
}

const sortNewest = (a: Event, b: Event) => b.ts - a.ts || b.id - a.id;

export const useEvents = create<EventsStore>()((set) => ({
  events: [],
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
