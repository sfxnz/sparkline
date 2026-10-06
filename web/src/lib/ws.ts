// Reconnecting WebSocket client for /api/v1/stream.
// - Before every connection attempt it asks GET /api/v1/auth/me (a WebSocket cannot see an HTTP 401), so an expired
//   session lands on 'unauthorized' instead of looping.
// - Exponential backoff with full jitter: delay = random() * min(30 s, 1 s * 2^(attempt-1)); reset by a 'hello'.
// - Heartbeat: no message for 35 s (the console pings) => the socket is considered dead and replaced.
import type { WsMessage } from './types';

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'unauthorized';
export type ConnError = 'unreachable' | 'server' | 'socket' | null;

export interface ConnState {
  status: ConnStatus;
  /** Epoch ms of the next scheduled attempt, when one is scheduled. */
  retryAt: number | null;
  /** Consecutive failed attempts since the last successful hello. */
  attempts: number;
  lastError: ConnError;
  /** True once any hello was received in this page session. */
  everLive: boolean;
}

export type AuthResult = 'ok' | 'unauthorized' | 'unreachable' | 'server';

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface SocketOptions {
  url: () => string;
  checkAuth: () => Promise<AuthResult>;
  onMessage: (msg: WsMessage) => void;
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  random?: () => number;
  isOnline?: () => boolean;
}

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 35_000;

/** Full-jitter backoff for the n-th consecutive failure (n >= 1). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}

function isWsMessage(x: unknown): x is WsMessage {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}

export class ReconnectingSocket {
  private state: ConnState = { status: 'connecting', retryAt: null, attempts: 0, lastError: null, everLive: false };
  private readonly listeners = new Set<(s: ConnState) => void>();
  private socket: SocketLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incremented on every attempt/stop so late async results from an older attempt are ignored. */
  private generation = 0;
  private running = false;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly isOnline: () => boolean;

  constructor(private readonly opts: SocketOptions) {
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.isOnline = opts.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  }

  getState = (): ConnState => this.state;

  subscribe = (fn: (s: ConnState) => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.attempt();
  }

  /** Try now, cancelling any scheduled attempt (Retry button, browser came back online). */
  retry(): void {
    if (!this.running) {
      this.start();
      return;
    }
    if (this.state.status === 'live') return;
    void this.attempt();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.clearTimers();
    this.closeSocket();
  }

  private set(patch: Partial<ConnState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.retryTimer = this.heartbeatTimer = null;
  }

  private closeSocket(): void {
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  private async attempt(): Promise<void> {
    const gen = ++this.generation;
    this.clearTimers();
    this.closeSocket();
    if (!this.isOnline()) {
      this.set({ status: 'offline', retryAt: null });
      return; // the owner calls retry() on the browser 'online' event
    }
    this.set({ status: this.state.attempts > 0 || this.state.everLive ? 'reconnecting' : 'connecting', retryAt: null });

    const auth = await this.opts.checkAuth();
    if (gen !== this.generation) return;
    if (auth === 'unauthorized') {
      this.set({ status: 'unauthorized', retryAt: null, lastError: null });
      return;
    }
    if (auth !== 'ok') {
      this.scheduleRetry(auth);
      return;
    }

    const ws = this.createSocket(this.opts.url());
    this.socket = ws;
    this.armHeartbeat(gen); // also bounds a connect that never produces a hello
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      this.armHeartbeat(gen);
      let msg: unknown;
      try {
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
      } catch {
        return; // malformed frame: ignore, the stream continues
      }
      if (!isWsMessage(msg)) return;
      if (msg.type === 'hello') this.set({ status: 'live', attempts: 0, retryAt: null, lastError: null, everLive: true });
      this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      if (gen === this.generation) this.drop();
    };
    ws.onerror = () => {
      /* a close event always follows */
    };
  }

  private armHeartbeat(gen: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (gen === this.generation) this.drop();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private drop(): void {
    this.closeSocket();
    this.scheduleRetry('socket');
  }

  private scheduleRetry(error: Exclude<ConnError, null>): void {
    this.clearTimers();
    const attempts = this.state.attempts + 1;
    const delay = backoffDelay(attempts, this.random);
    const gen = this.generation;
    this.set({ status: 'reconnecting', attempts, retryAt: this.now() + delay, lastError: error });
    this.retryTimer = setTimeout(() => {
      if (gen === this.generation) void this.attempt();
    }, delay);
  }
}
