// REST client for the console. Same-origin (dev/preview proxy /api to the console); auth is an HttpOnly cookie.
import type { AlertRule, BenchCompare, BenchCreate, BenchRun, BenchSpec, ConsoleSettings, Event, HistoryResponse, NodeState, Problem, RunStatus } from './types';

export type ApiErrorKind = 'unauthorized' | 'unreachable' | 'server' | 'client';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    message: string,
    /** Full response body (the console answers errors with {"problem": {...}}). */
    readonly body = '',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// A dev/preview proxy answers 500/502/503/504 when the console behind it is down; treat those as unreachable.
const UNREACHABLE_STATUSES = new Set([500, 502, 503, 504]);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  } catch (e) {
    throw new ApiError('unreachable', 0, e instanceof Error ? e.message : String(e));
  }
  if (res.status === 401) throw new ApiError('unauthorized', 401, 'Not signed in');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const kind: ApiErrorKind =
      UNREACHABLE_STATUSES.has(res.status) && !res.headers.get('content-type')?.includes('json')
        ? 'unreachable'
        : res.status >= 500
          ? 'server'
          : 'client';
    throw new ApiError(kind, res.status, body.slice(0, 300) || res.statusText, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});
const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const api = {
  /** Always 200 from this console: `authenticated: false` when signed out (older consoles answered 401, which
   *  throws ApiError('unauthorized')). */
  me: () => request<{ authenticated?: boolean; auth_required?: boolean; demo?: boolean }>('/api/v1/auth/me'),
  login: (token: string) => request<unknown>('/api/v1/auth/login', json({ token })),
  logout: () => request<unknown>('/api/v1/auth/logout', { method: 'POST' }),
  /** Ask the console to reconnect to a node now instead of waiting for its backoff. */
  retryNode: (node: string) => request<NodeState>(`/api/v1/nodes/${encodeURIComponent(node)}/retry`, { method: 'POST' }),
  live: (node: string, seconds = 900) =>
    request<HistoryResponse>(`/api/v1/live?${new URLSearchParams({ node, seconds: String(seconds) }).toString()}`),
  history: (node: string, keys: readonly string[], from: number, to: number, points = 600) =>
    request<HistoryResponse>(
      `/api/v1/history?${new URLSearchParams({
        node,
        keys: keys.join(','),
        from: String(from),
        to: String(to),
        points: String(points),
      }).toString()}`,
    ),
  events: (limit = 500) => request<Event[]>(`/api/v1/events?${query({ limit: String(limit) })}`),
  ack: (id: number) => request<Event>(`/api/v1/events/${id}/ack`, { method: 'POST' }),
  rules: () => request<AlertRule[]>('/api/v1/alerts/rules'),
  putRules: (rules: AlertRule[]) => request<AlertRule[]>('/api/v1/alerts/rules', json(rules, 'PUT')),
  settings: () => request<ConsoleSettings>('/api/v1/settings'),
  putSettings: (s: ConsoleSettings) => request<ConsoleSettings>('/api/v1/settings', json(s, 'PUT')),
  /** Irreversible: deletes the node's stored history (the console requires the explicit confirm body). */
  clearHistory: (node: string) =>
    request<{ ok: boolean; demo?: boolean }>(`/api/v1/history?${query({ node })}`, json({ confirm: 'DELETE' }, 'DELETE')),
};

export interface BenchRunFilters {
  bench_id?: string;
  node?: string;
  status?: RunStatus;
  limit?: number;
}

const benchRun = (id: string) => `/api/v1/bench/runs/${encodeURIComponent(id)}`;

/** Benchmark suite (used only by the lazy benchmarks chunk). */
export const benchApi = {
  catalog: () => request<BenchSpec[]>('/api/v1/bench/catalog'),
  runs: (f: BenchRunFilters = {}) => {
    const q = query(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])));
    return request<BenchRun[]>(`/api/v1/bench/runs${q ? `?${q}` : ''}`);
  },
  run: (id: string) => request<BenchRun>(benchRun(id)),
  /** `confirm` must be true: the console refuses (400) otherwise. */
  create: (body: BenchCreate) => request<BenchRun>('/api/v1/bench/runs', json(body)),
  cancel: (id: string) => request<unknown>(`${benchRun(id)}/cancel`, { method: 'POST' }),
  remove: (id: string) => request<unknown>(benchRun(id), { method: 'DELETE' }),
  setBaseline: (benchId: string, runId: string) =>
    request<unknown>(`/api/v1/bench/baselines/${encodeURIComponent(benchId)}`, json({ run_id: runId }, 'PUT')),
  compare: (ids: readonly string[]) => request<BenchCompare>(`/api/v1/bench/compare?${query({ ids: ids.join(',') })}`),
  /** Download URL (the console answers with an attachment). */
  exportUrl: (id: string, format: 'json' | 'csv') => `${benchRun(id)}/export?${query({ format })}`,
};

/** Human-readable Problem for any failure: the console's own {problem} when present, else a sensible default. */
export function problemOf(err: unknown, what: string): Problem {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { problem?: Partial<Problem> };
      if (body.problem?.message) {
        return { message: body.problem.message, cause: body.problem.cause ?? '', fix: body.problem.fix ?? '' };
      }
    } catch {
      /* not JSON: fall through */
    }
    if (err.kind === 'unreachable') {
      return { message: `Couldn't ${what}`, cause: 'Sparkline is not reachable from this browser.', fix: 'Check that the console is running, then try again.' };
    }
    if (err.kind === 'unauthorized') {
      return { message: `Couldn't ${what}`, cause: 'Your session has expired.', fix: 'Sign in again, then retry.' };
    }
    return { message: `Couldn't ${what}`, cause: `HTTP ${err.status}: ${err.message.slice(0, 200)}`, fix: 'Try again. If it keeps failing, check the console log.' };
  }
  return { message: `Couldn't ${what}`, cause: err instanceof Error ? err.message : String(err), fix: 'Try again.' };
}

export function streamUrl(loc: Location = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/api/v1/stream`;
}
