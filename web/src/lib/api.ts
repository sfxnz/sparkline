// REST client for the console. Same-origin (dev/preview proxy /api to the console); auth is an HttpOnly cookie.
import type { HistoryResponse, NodeState } from './types';

export type ApiErrorKind = 'unauthorized' | 'unreachable' | 'server' | 'client';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    message: string,
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
    throw new ApiError(kind, res.status, body.slice(0, 300) || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

export const api = {
  /** 200 when the session is valid; throws ApiError('unauthorized') on 401. Body shape is not relied on. */
  me: () => request<unknown>('/api/v1/auth/me'),
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
};

export function streamUrl(loc: Location = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/api/v1/stream`;
}
