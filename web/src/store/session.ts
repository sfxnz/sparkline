// Bootstrap: auth check -> WebSocket -> dispatch messages into the stores.
import { ApiError, api, streamUrl } from '../lib/api';
import { ReconnectingSocket, type AuthResult } from '../lib/ws';
import type { WsMessage } from '../lib/types';
import { announce } from '../design/components/LiveAnnouncer';
import { useBench } from './bench';
import { useCluster } from './cluster';
import { useConnection } from './connection';
import { MAX_EVENTS, mergeEvents, useEvents } from './events';
import { historyCache, seedLive } from './history';
import { liveStore } from './live';

async function checkAuth(): Promise<AuthResult> {
  try {
    await api.me();
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError) return e.kind === 'unauthorized' ? 'unauthorized' : e.kind === 'unreachable' ? 'unreachable' : 'server';
    return 'unreachable';
  }
}

export function dispatch(msg: WsMessage): void {
  switch (msg.type) {
    case 'hello': {
      const known = new Set(msg.cluster.nodes.map((n) => n.node_id));
      for (const id of useCluster.getState().order) if (!known.has(id)) liveStore.removeNode(id);
      useCluster.getState().setHello(msg.cluster);
      historyCache.clear();
      void seedLive([...known]);
      void loadEvents(); // every (re)connect: events raised while disconnected are back-filled too
      break;
    }
    case 'sample':
      liveStore.pushSample(msg.sample);
      break;
    case 'node_status':
      useCluster.getState().setNode(msg.node);
      break;
    case 'event':
      useEvents.getState().upsert(msg.event);
      if (msg.event.severity !== 'info' && msg.event.kind !== 'recovered') {
        announce(`${msg.event.severity === 'critical' ? 'Critical' : 'Warning'}: ${msg.event.title}`, msg.event.severity);
      }
      break;
    case 'bench':
      useBench.getState().upsert(msg.run);
      break;
    case 'settings':
      useCluster.getState().setSettings(msg.settings);
      break;
    case 'ping':
      break;
  }
}

const EVENTS_RETRY_MS = 10_000;
let eventsRequest = 0;
let eventsRetry: ReturnType<typeof setTimeout> | null = null;

/**
 * Back-fill the events store from /api/v1/events, merged under whatever the stream already delivered. A refetch
 * after a reconnect keeps the timeline on screen ('ready' stays 'ready'); a failure is retried after 10 s.
 */
export function loadEvents(): Promise<void> {
  const id = ++eventsRequest;
  if (eventsRetry) clearTimeout(eventsRetry);
  eventsRetry = null;
  const st = useEvents.getState();
  if (st.load.status !== 'ready') useEvents.setState({ load: { status: 'loading' } });
  return api.events(MAX_EVENTS).then(
    (fetched) => {
      if (id !== eventsRequest) return;
      useEvents.setState((s) => ({ events: mergeEvents(s.events, fetched).slice(0, MAX_EVENTS), load: { status: 'ready' } }));
    },
    (error: unknown) => {
      if (id !== eventsRequest) return;
      if (useEvents.getState().load.status !== 'ready') useEvents.setState({ load: { status: 'error', error } });
      eventsRetry = setTimeout(() => { void loadEvents(); }, EVENTS_RETRY_MS);
    },
  );
}

let socket: ReconnectingSocket | null = null;

export function startSession(): ReconnectingSocket {
  if (socket) return socket;
  const s = new ReconnectingSocket({ url: () => streamUrl(), checkAuth, onMessage: dispatch });
  let lost = false;
  s.subscribe((state) => {
    // Announce the live -> lost transition and the recovery once each; the countdown itself stays silent.
    if (!lost && useConnection.getState().status === 'live' && (state.status === 'reconnecting' || state.status === 'offline')) {
      lost = true;
      announce('Connection to Sparkline lost. Reconnecting…', 'warning');
    } else if (lost && state.status === 'live') {
      lost = false;
      announce('Reconnected to Sparkline.', 'warning'); // 'info' is filtered by the announcer
    }
    useConnection.setState(state);
  });
  socket = s;
  window.addEventListener('online', retryConnection);
  s.start();
  return s;
}

export function retryConnection(): void {
  socket?.retry();
}

export function stopSession(): void {
  socket?.stop();
  socket = null;
  window.removeEventListener('online', retryConnection);
}
