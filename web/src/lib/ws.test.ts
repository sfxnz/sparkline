import { BACKOFF_CAP_MS, backoffDelay, HEARTBEAT_TIMEOUT_MS, ReconnectingSocket, type AuthResult, type SocketLike } from './ws';
import type { ClusterState, WsMessage } from './types';

class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  send(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose() {
    this.onclose?.({});
  }
}

const cluster: ClusterState = {
  nodes: [],
  settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
  demo: true,
  version: '0.1.0',
  server_time: 1000,
};

function setup(auth: AuthResult[] = ['ok']) {
  const sockets: FakeSocket[] = [];
  const messages: WsMessage[] = [];
  const authQueue = [...auth];
  const checkAuth = vi.fn(() => Promise.resolve(authQueue.length > 1 ? (authQueue.shift() as AuthResult) : (authQueue[0] ?? 'ok')));
  const s = new ReconnectingSocket({
    url: () => 'ws://test/api/v1/stream',
    checkAuth,
    onMessage: (m) => messages.push(m),
    createSocket: (url) => {
      const f = new FakeSocket(url);
      sockets.push(f);
      return f;
    },
    random: () => 1, // deterministic: the full ceiling
    now: () => Date.now(),
    isOnline: () => true,
  });
  return { s, sockets, messages, checkAuth };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('backoffDelay', () => {
  it('is full jitter over 1 s * 2^(n-1), capped at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map((n) => backoffDelay(n, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(backoffDelay(3, () => 0)).toBe(0);
    expect(backoffDelay(3, () => 0.5)).toBe(2000);
    for (let i = 0; i < 200; i++) expect(backoffDelay(20)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  });
});

describe('ReconnectingSocket', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('connects, becomes live on hello and delivers messages', async () => {
    const { s, sockets, messages } = setup();
    s.start();
    expect(s.getState().status).toBe('connecting');
    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0]?.send({ type: 'hello', cluster });
    expect(s.getState()).toMatchObject({ status: 'live', attempts: 0, everLive: true });
    sockets[0]?.send({ type: 'ping', ts: 1 });
    expect(messages.map((m) => m.type)).toEqual(['hello', 'ping']);
    s.stop();
  });

  it('ignores malformed frames', async () => {
    const { s, sockets, messages } = setup();
    s.start();
    await flush();
    sockets[0]?.onmessage?.({ data: '{not json' });
    sockets[0]?.onmessage?.({ data: JSON.stringify({ nope: 1 }) });
    expect(messages).toHaveLength(0);
    s.stop();
  });

  it('backs off exponentially while unreachable, then resets after hello', async () => {
    const { s, sockets, checkAuth } = setup(['unreachable', 'unreachable', 'unreachable', 'ok']);
    s.start();
    await flush();
    expect(s.getState()).toMatchObject({ status: 'reconnecting', attempts: 1, lastError: 'unreachable' });
    expect((s.getState().retryAt ?? 0) - Date.now()).toBe(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.getState().attempts).toBe(2);
    expect((s.getState().retryAt ?? 0) - Date.now()).toBe(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.getState().attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(checkAuth).toHaveBeenCalledTimes(4);
    expect(sockets).toHaveLength(1);
    sockets[0]?.send({ type: 'hello', cluster });
    expect(s.getState()).toMatchObject({ status: 'live', attempts: 0, retryAt: null });
    // A drop after being live retries quickly (attempt 1 => <= 1 s), shown as reconnecting.
    sockets[0]?.serverClose();
    expect(s.getState()).toMatchObject({ status: 'reconnecting', attempts: 1, lastError: 'socket' });
    expect((s.getState().retryAt ?? 0) - Date.now()).toBe(1000);
    s.stop();
  });

  it('treats 35 s without any message as a dead connection', async () => {
    const { s, sockets } = setup();
    s.start();
    await flush();
    sockets[0]?.send({ type: 'hello', cluster });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS - 1000);
    sockets[0]?.send({ type: 'ping', ts: 2 }); // resets the timer
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS - 1000);
    expect(s.getState().status).toBe('live');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[0]?.closed).toBe(true);
    expect(s.getState().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    s.stop();
  });

  it('stops on 401 with status unauthorized, and retry() resumes', async () => {
    const { s, sockets } = setup(['unauthorized', 'ok']);
    s.start();
    await flush();
    expect(s.getState().status).toBe('unauthorized');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(0); // no reconnect loop while signed out
    s.retry();
    await flush();
    expect(sockets).toHaveLength(1);
    s.stop();
  });

  it('manual retry skips the scheduled wait', async () => {
    const { s, checkAuth } = setup(['unreachable', 'unreachable', 'ok']);
    s.start();
    await flush();
    expect(checkAuth).toHaveBeenCalledTimes(1);
    s.retry();
    await flush();
    expect(checkAuth).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('reports offline and does not spin while the browser is offline', async () => {
    let online = false;
    const checkAuth = vi.fn(() => Promise.resolve<AuthResult>('ok'));
    const s = new ReconnectingSocket({ url: () => 'ws://x', checkAuth, onMessage: () => undefined, createSocket: (u) => new FakeSocket(u), isOnline: () => online });
    s.start();
    await flush();
    expect(s.getState().status).toBe('offline');
    expect(checkAuth).not.toHaveBeenCalled();
    online = true;
    s.retry();
    await flush();
    expect(checkAuth).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('stop() closes the socket and ignores late events', async () => {
    const { s, sockets, messages } = setup();
    s.start();
    await flush();
    const sock = sockets[0];
    s.stop();
    expect(sock?.closed).toBe(true);
    sock?.send({ type: 'hello', cluster });
    expect(messages).toHaveLength(0);
  });
});
