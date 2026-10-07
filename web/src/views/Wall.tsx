import { CircleCheck, Clock, Maximize, Minimize, X } from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useLocation } from 'wouter';
import { AnimatedNumber } from '../design/components/AnimatedNumber';
import { Button } from '../design/components/Button';
import { StatusPill } from '../design/components/StatusPill';
import { springs } from '../design/motion';
import { formatDuration, wattsParts } from '../lib/format';
import { serverNow, useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { useEvents } from '../store/events';
import { liveStore } from '../store/live';
import { SeverityBadge } from './alerts/parts/SeverityBadge';
import { useTick } from './alerts/parts/tick';
import { shallowEqual, useAcross, useClusterHealth, useOnlineIds } from './overview/hooks';
import { tickerAlerts, wallColumns } from './wall/model';
import { useFullscreen, useIdle, useWakeLock } from './wall/useWallChrome';
import { WallTile } from './wall/WallTile';
import './wall/wall.css';

/** Full-screen ambient display for a wall-mounted screen: no chrome, type that scales with the viewport. */
export default function Wall() {
  const [, navigate] = useLocation();
  const order = useCluster((s) => s.order);
  const idle = useIdle(3000);
  const fs = useFullscreen();
  useWakeLock();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [navigate]);

  const tiles = order.length ? order : ['…'];
  return (
    <main className="wall" id="main" data-idle={idle || undefined}>
      <h1 className="visually-hidden">Sparkline wall display</h1>
      <div className="wall-controls">
        {fs.supported ? (
          <Button variant="secondary" size="sm" icon={fs.on ? <Minimize /> : <Maximize />} onClick={fs.toggle}>
            {fs.on ? 'Exit full screen' : 'Enter full screen'}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" icon={<X />} onClick={() => { navigate('/'); }} aria-keyshortcuts="Escape">
          Exit wall mode
        </Button>
      </div>

      <header className="wall-top">
        <Hero />
        <WallClock />
      </header>

      <div className="wall-grid" style={{ '--wall-cols': wallColumns(tiles.length) } as CSSProperties}>
        {order.length ? order.map((id) => <WallTile key={id} id={id} />) : <WaitingTile />}
      </div>

      <AlertTicker />
    </main>
  );
}

function Hero() {
  const health = useClusterHealth();
  return (
    <div className="wall-hero">
      <span className="wall-hero__pill">
        <StatusPill status={health.status} label={health.label} />
      </span>
      <p className="wall-hero__sentence">{health.sentence}</p>
      <ClusterLine />
    </div>
  );
}

const pct = (n: number) => n.toFixed(0);
const watts = (n: number) => wattsParts(n, 'W').value;

/** Cluster-wide GPU load and GPU-rail power, from the nodes that are live right now. */
function ClusterLine() {
  const ids = useOnlineIds();
  const v = useAcross(
    ids,
    () => {
      let util = 0;
      let nUtil = 0;
      let power: number | null = null;
      for (const id of ids) {
        const u = liveStore.latestValue(id, 'gpu0.util');
        const p = liveStore.latestValue(id, 'gpu0.power_w');
        if (u !== null) {
          util += u;
          nUtil++;
        }
        if (p !== null) power = (power ?? 0) + p;
      }
      return { util: nUtil ? Math.round(util / nUtil) : null, power: power === null ? null : Math.round(power * 2) / 2 };
    },
    shallowEqual,
  );
  if (!ids.length) return <p className="wall-hero__line">No live data</p>;
  return (
    <p className="wall-hero__line">
      <span>GPU </span>
      <AnimatedNumber value={v.util} format={pct} />
      <span>% across {ids.length === 1 ? '1 live node' : `${ids.length} live nodes`}</span>
      <span className="wall-hero__sep" aria-hidden="true">·</span>
      <AnimatedNumber value={v.power} format={watts} />
      <span> W GPU power</span>
    </p>
  );
}

function WallClock() {
  const now = useTick(1000);
  const d = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className="wall-clock">
      <time className="wall-clock__time" dateTime={d.toISOString()}>{time}</time>
      <span className="wall-clock__date">{date}</span>
    </div>
  );
}

function WaitingTile() {
  const everLive = useConnection((s) => s.everLive);
  return (
    <section className="wall-tile wall-tile--empty" aria-label="No nodes">
      <p className="wall-hero__sentence">{everLive ? 'No nodes configured' : 'Connecting to Sparkline…'}</p>
    </section>
  );
}

const CYCLE_MS = 8000;

/** Open alerts, one at a time, changing calmly every 8 s. Visual only: alerts are announced once by the app. */
function AlertTicker() {
  const events = useEvents((s) => s.events);
  const alerts = useMemo(() => tickerAlerts(events), [events]);
  const [index, setIndex] = useState(0);
  const next = useCallback(() => { setIndex((i) => i + 1); }, []);
  useEffect(() => {
    if (alerts.length < 2) return;
    const t = setInterval(next, CYCLE_MS);
    return () => { clearInterval(t); };
  }, [alerts.length, next]);
  useTick(10_000);
  const health = useClusterHealth();

  if (!alerts.length) {
    // The all-clear only when the hero agrees: a node can be offline or flagged before its alert rule fires.
    const clear = health.status === 'healthy';
    return (
      <footer className={`wall-ticker wall-ticker--quiet${clear ? '' : ' wall-ticker--pending'}`}>
        {clear ? <CircleCheck className="wall-ticker__ok" aria-hidden="true" /> : <Clock className="wall-ticker__wait" aria-hidden="true" />}
        <span>{clear ? 'No open alerts' : 'No open alerts yet'}</span>
      </footer>
    );
  }
  const i = index % alerts.length;
  const a = alerts[i];
  if (!a) return null;
  return (
    <footer className="wall-ticker">
      <span className="wall-ticker__count num">
        {alerts.length} open {alerts.length === 1 ? 'alert' : 'alerts'}
        {alerts.length > 1 ? <span className="wall-ticker__pos"> · {i + 1} of {alerts.length}</span> : null}
      </span>
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={a.id} className="wall-ticker__item" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={springs.gentle}>
          <span className="wall-ticker__sev"><SeverityBadge severity={a.severity} size="md" /></span>
          <span className="wall-ticker__title">{a.title}</span>
          <span className="wall-ticker__detail">{a.detail}</span>
          <span className="wall-ticker__since num">{serverNow() - a.ts < 5 ? 'just now' : `for ${formatDuration(serverNow() - a.ts)}`}</span>
        </m.div>
      </AnimatePresence>
    </footer>
  );
}
