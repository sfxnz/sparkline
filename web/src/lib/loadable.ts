import { useCallback, useState } from 'react';

export type Loadable<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  | { state: 'refresh-failed'; data: T; error: unknown }
  | { state: 'error'; error: unknown };

export const LOADING: Loadable<never> = { state: 'loading' };

type Outcome<T> = { data: T } | { error: unknown };

/** An unchanged success returns `prev`, so a caller that settles every frame re-renders only on a change. */
function settle<T>(prev: Loadable<T>, outcome: Outcome<T>): Loadable<T> {
  if ('data' in outcome) return prev.state === 'ready' && Object.is(prev.data, outcome.data) ? prev : { state: 'ready', data: outcome.data };
  return 'data' in prev ? { state: 'refresh-failed', data: prev.data, error: outcome.error } : { state: 'error', error: outcome.error };
}

/**
 * Loadable state for the data `id` names. A change of `id` starts over at loading, so data from another id, or from
 * an earlier visit to this one, never shows as current or survives into 'refresh-failed'.
 * `update` ignores outcomes for an id that is no longer current.
 */
export function useLoadable<T>(id: string): [Loadable<T>, (next: Outcome<T> | 'loading') => void] {
  const [tagged, setTagged] = useState<{ id: string; value: Loadable<T> }>({ id, value: LOADING });
  if (tagged.id !== id) setTagged({ id, value: LOADING });
  const update = useCallback(
    (next: Outcome<T> | 'loading') => {
      setTagged((prev) => {
        if (prev.id !== id) return prev;
        const value = next === 'loading' ? LOADING : settle(prev.value, next);
        return value === prev.value ? prev : { id, value };
      });
    },
    [id],
  );
  return [tagged.id === id ? tagged.value : LOADING, update];
}

export const dataOf = <T>(l: Loadable<T>): T | null => ('data' in l ? l.data : null);

export function mapLoadable<T, U>(l: Loadable<T>, f: (data: T) => U): Loadable<U> {
  if (l.state === 'ready') return { state: 'ready', data: f(l.data) };
  if (l.state === 'refresh-failed') return { state: 'refresh-failed', data: f(l.data), error: l.error };
  return l;
}
