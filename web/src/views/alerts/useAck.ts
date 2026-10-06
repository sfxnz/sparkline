import { useCallback, useState } from 'react';
import type { Event, Problem } from '../../lib/types';
import { mergeEvent, useEvents } from '../../store/events';
import { api, problemOf } from '../../lib/api';

const current = (id: number) => useEvents.getState().events.find((e) => e.id === id);

/**
 * Acknowledge with optimistic UI: the store flips to acked immediately; on failure it rolls back and the error is
 * kept for inline display next to that alert.
 */
export function useAck() {
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const [failed, setFailed] = useState<{ id: number; problem: Problem } | null>(null);

  const ack = useCallback(async (e: Event) => {
    setFailed(null);
    setPending((s) => new Set(s).add(e.id));
    const before = current(e.id) ?? e;
    useEvents.getState().upsert({ ...before, acked: true });
    try {
      const updated = await api.ack(e.id);
      const now = current(e.id);
      useEvents.getState().upsert(now ? mergeEvent(now, updated) : updated);
    } catch (err) {
      const now = current(e.id);
      if (now) useEvents.getState().upsert({ ...now, acked: false });
      setFailed({ id: e.id, problem: problemOf(err, 'acknowledge this alert') });
    } finally {
      setPending((s) => {
        const n = new Set(s);
        n.delete(e.id);
        return n;
      });
    }
  }, []);

  return { ack, pending, failed, dismiss: () => { setFailed(null); } };
}
