export type Loadable<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  | { state: 'refresh-failed'; data: T; error: unknown }
  | { state: 'error'; error: unknown };

export const LOADING: Loadable<never> = { state: 'loading' };

/** An unchanged success returns `prev`, so a caller that settles every frame re-renders only on a change. */
export function settle<T>(prev: Loadable<T>, outcome: { data: T } | { error: unknown }): Loadable<T> {
  if ('data' in outcome) return prev.state === 'ready' && Object.is(prev.data, outcome.data) ? prev : { state: 'ready', data: outcome.data };
  return 'data' in prev ? { state: 'refresh-failed', data: prev.data, error: outcome.error } : { state: 'error', error: outcome.error };
}

/** State tagged with the identity of the data it belongs to (node, keys, range). */
export interface Tagged<T> {
  id: string;
  value: Loadable<T>;
}

export function settleFor<T>(id: string, outcome: { data: T } | { error: unknown }) {
  return (prev: Tagged<T>): Tagged<T> => {
    const value = settle(prev.id === id ? prev.value : LOADING, outcome);
    return prev.id === id && value === prev.value ? prev : { id, value };
  };
}

export const dataOf = <T>(l: Loadable<T>): T | null => ('data' in l ? l.data : null);

export function mapLoadable<T, U>(l: Loadable<T>, f: (data: T) => U): Loadable<U> {
  if (l.state === 'ready') return { state: 'ready', data: f(l.data) };
  if (l.state === 'refresh-failed') return { state: 'refresh-failed', data: f(l.data), error: l.error };
  return l;
}
