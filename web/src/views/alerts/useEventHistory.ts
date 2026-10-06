import { problemOf } from '../../lib/api';
import type { Problem } from '../../lib/types';
import { useEvents } from '../../store/events';
import { loadEvents } from '../../store/session';

export type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; problem: Problem };

const retry = () => { void loadEvents(); };

/** The timeline's back-fill state. The session loads the history on every (re)connect; this only reads it. */
export function useEventHistory(): { state: LoadState; retry: () => void } {
  const load = useEvents((s) => s.load);
  const state: LoadState =
    load.status === 'error' ? { status: 'error', problem: problemOf(load.error, 'load the event history') } : load.status === 'ready' ? { status: 'ready' } : { status: 'loading' };
  return { state, retry };
}
