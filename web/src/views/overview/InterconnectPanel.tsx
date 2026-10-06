// ConnectX-7 links between nodes: per rail, link state and rate, live throughput in both directions with a
// restrained flow animation (speed bucket set at most once per sample; CSS animates transform only), and
// errors/drops over the recent window when there are any.
import { ArrowLeft, ArrowRight, CircleCheck, CircleSlash, Server, TriangleAlert } from 'lucide-react';
import { Panel } from '../../design/components/Panel';
import { Skeleton } from '../../design/components/Skeleton';
import { StatusPill } from '../../design/components/StatusPill';
import { useNow } from '../../design/useNow';
import { bitrateParts, DASH, formatAgo, text } from '../../lib/format';
import type { NodeStatus } from '../../lib/types';
import { spanPhrase } from '../shared/live';
import { serverNow, useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { useNodeDisplayStatus } from '../../store/attention';
import { liveStore } from '../../store/live';
import { shallowEqual, useAcross } from './hooks';
import { flowLevel, linkLoad, type Link, type Rail } from './model';

const ERROR_WINDOW_S = 900;

/**
 * Which end a rail is read from: `a`, unless only `b` is live (then b's interface, with rx/tx swapped). `stale` when
 * the end it is read from is not live. The rail view and the summary line both use this, so they always agree.
 */
export function railSource(link: Link, rail: Rail, statusA: NodeStatus | undefined, statusB: NodeStatus | undefined, consoleLive: boolean) {
  const fromB = statusA !== 'online' && statusB === 'online' && rail.peerName !== null;
  return {
    fromB,
    src: fromB ? link.b : link.a,
    ifname: fromB ? (rail.peerName ?? rail.name) : rail.name,
    stale: !consoleLive || (fromB ? statusB : statusA) !== 'online',
  };
}

export function InterconnectPanel({ links }: { links: readonly Link[] }) {
  const anyLive = useCluster((s) => links.some((l) => s.nodes[l.a]?.status === 'online' || s.nodes[l.b]?.status === 'online'));
  const consoleLive = useConnection((s) => s.status === 'live');
  return (
    <Panel title="Interconnect" subtitle={`ConnectX-7 direct links${anyLive && consoleLive ? ' · live' : ''}`} className="ov-ic">
      <div className="ov-ic__links">
        {links.map((l) => (
          <LinkView key={`${l.a}-${l.b}`} link={l} />
        ))}
      </div>
      <LinkSummary links={links} />
    </Panel>
  );
}

/**
 * One line across all links: rails up, aggregate throughput each way, errors in the recent window. Each rail is read
 * from the same end as its rail view (railSource). Only rails read live count as up; when no end of any link is
 * live the line is dimmed and says how old it is, instead of passing frozen rates off as current.
 */
function LinkSummary({ links }: { links: readonly Link[] }) {
  const nodes = useCluster((s) => s.nodes);
  const consoleLive = useConnection((s) => s.status === 'live');
  const ids = [...new Set(links.flatMap((l) => [l.a, l.b]))];
  const statusKey = ids.map((id) => nodes[id]?.status ?? '').join();
  const sum = useAcross(
    ids,
    () => {
      let rails = 0;
      let up = 0;
      let live = 0;
      let ab = 0;
      let ba = 0;
      let errs = 0;
      let oldest: number | null = null;
      let last: number | null = null;
      const from = serverNow() - ERROR_WINDOW_S;
      for (const l of links) {
        for (const r of l.rails) {
          rails++;
          const s = railSource(l, r, nodes[l.a]?.status, nodes[l.b]?.status, consoleLive);
          const tx = liveStore.latestValue(s.src, `net.${s.ifname}.tx_bps`) ?? 0;
          const rx = liveStore.latestValue(s.src, `net.${s.ifname}.rx_bps`) ?? 0;
          ab += s.fromB ? rx : tx;
          ba += s.fromB ? tx : rx;
          if (!s.stale) {
            live++;
            if ((liveStore.latestValue(s.src, `net.${s.ifname}.up`) ?? 0) > 0) up++;
          }
          const w = liveStore.window(s.src, [`net.${s.ifname}.errors`, `net.${s.ifname}.drops`], from);
          for (const vs of w.values) for (const v of vs) errs += v ?? 0;
          if (w.ts.length && (oldest === null || (w.ts[0] ?? 0) < oldest)) oldest = w.ts[0] ?? null;
          const t = liveStore.lastTs(s.src);
          if (t !== null && (last === null || t > last)) last = t;
        }
      }
      return {
        rails,
        up,
        live,
        ab: text(bitrateParts(ab)),
        ba: text(bitrateParts(ba)),
        errs,
        span: spanPhrase('live', oldest === null ? null : Math.floor(oldest / 60) * 60, serverNow()).replace(/^last /, ''),
        last: last === null ? null : Math.floor(last),
      };
    },
    shallowEqual,
    `${links.map((l) => `${l.a}-${l.b}`).join()}|${statusKey}|${String(consoleLive)}`,
  );
  const single = links.length === 1 ? links[0] : undefined;
  const stale = sum.live === 0;
  useNow(stale ? 1000 : 60_000); // the age only shows while stale
  return (
    <p className={`ov-ic__summary num${stale ? ' ov-ic__summary--stale' : ''}`}>
      {stale ? `No end is reporting · last values ${sum.last ? formatAgo(sum.last, serverNow()) : 'unknown'} · ` : `${sum.up} of ${sum.rails} ${sum.rails === 1 ? 'rail' : 'rails'} up · `}
      {single ? `${single.a} → ${single.b} ${sum.ab} · ${single.b} → ${single.a} ${sum.ba}` : `${sum.ab} out · ${sum.ba} in`} ·{' '}
      {sum.errs ? `${sum.errs.toFixed(0)} errors or drops in ${sum.span}` : `no errors in ${sum.span}`}
    </p>
  );
}

function NodeEnd({ id }: { id: string }) {
  const status = useNodeDisplayStatus(id);
  const known = useCluster((s) => id in s.nodes);
  return (
    <div className="ov-ic__end">
      <Server aria-hidden="true" className="ov-ic__end-icon" />
      <span className="ov-ic__end-name">{id}</span>
      {known ? <StatusPill status={status} variant="inline" size="sm" /> : <span className="ov-dim t-caption">Not monitored</span>}
    </div>
  );
}

function LinkView({ link }: { link: Link }) {
  return (
    <div className="ov-ic__link">
      <NodeEnd id={link.a} />
      <div className="ov-ic__rails">
        {link.rails.map((r) => (
          <RailView key={r.name} link={link} rail={r} />
        ))}
      </div>
      <NodeEnd id={link.b} />
    </div>
  );
}

interface RailState {
  /** Measured on this node (the other end when the first is not live). */
  source: string;
  up: boolean | null;
  state: string | null;
  rate: string | null;
  ab: string | null;
  ba: string | null;
  abLevel: number;
  baLevel: number;
  errors: number;
  drops: number;
  stale: boolean;
}

function RailView({ link, rail }: { link: Link; rail: Rail }) {
  const statusA = useCluster((s) => s.nodes[link.a]?.status);
  const statusB = useCluster((s) => s.nodes[link.b]?.status);
  const consoleLive = useConnection((s) => s.status === 'live');
  const { fromB, src, ifname, stale } = railSource(link, rail, statusA, statusB, consoleLive);

  const st = useAcross<RailState>(
    [src],
    () => {
      const sample = liveStore.latest(src)?.net.find((n) => n.name === ifname) ?? null;
      const rx = liveStore.latestValue(src, `net.${ifname}.rx_bps`);
      const tx = liveStore.latestValue(src, `net.${ifname}.tx_bps`);
      const upV = liveStore.latestValue(src, `net.${ifname}.up`);
      const w = liveStore.window(src, [`net.${ifname}.errors`, `net.${ifname}.drops`], serverNow() - ERROR_WINDOW_S);
      const sum = (vs: readonly (number | null)[] | undefined) => (vs ?? []).reduce<number>((a, v) => a + (v ?? 0), 0);
      const ab = fromB ? rx : tx;
      const ba = fromB ? tx : rx;
      const live = !stale;
      return {
        source: src,
        up: sample ? sample.up : upV === null ? null : upV > 0,
        state: sample?.rdma_state ?? null,
        rate: sample?.rdma_rate ?? null,
        ab: ab === null ? null : text(bitrateParts(ab)),
        ba: ba === null ? null : text(bitrateParts(ba)),
        abLevel: live ? flowLevel(linkLoad(ab, rail.speedMbps)) : 0,
        baLevel: live ? flowLevel(linkLoad(ba, rail.speedMbps)) : 0,
        errors: sum(w.values[0]),
        drops: sum(w.values[1]),
        stale,
      };
    },
    shallowEqual,
    `${ifname}|${String(fromB)}|${String(stale)}`,
  );

  const speed = rail.speedMbps ? `${rail.speedMbps / 1000} Gb/s` : null;
  const rateText = st.rate ? st.rate.replace(/\s*\(.*\)$/, '').replace('Gb/sec', 'Gb/s') : speed;
  const linkUp = st.up === true && (st.state === null || st.state.toUpperCase() === 'ACTIVE');
  const waiting = st.up === null && st.ab === null;

  return (
    <div className={`ov-rail${st.stale ? ' ov-rail--stale' : ''}`}>
      <div className="ov-rail__head">
        <span className="ov-rail__name">{rail.label}</span>
        <span className="ov-rail__meta">
          {waiting ? (
            <Skeleton width={120} height={12} />
          ) : (
            <span className={`ov-flag ${linkUp ? 'tone-ok' : 'tone-crit'}`}>
              {linkUp ? <CircleCheck aria-hidden="true" /> : <CircleSlash aria-hidden="true" />}
              {linkUp ? 'Active' : st.state ? `Down (${st.state.toLowerCase()})` : 'Down'}
            </span>
          )}
          {rateText ? <span className="num ov-dim"> · {rateText}</span> : null}
          {st.errors || st.drops ? (
            <span className="ov-flag tone-warn">
              <TriangleAlert aria-hidden="true" />
              <span className="num">
                {st.errors ? `${st.errors.toFixed(0)} ${st.errors === 1 ? 'error' : 'errors'}` : ''}
                {st.errors && st.drops ? ' · ' : ''}
                {st.drops ? `${st.drops.toFixed(0)} ${st.drops === 1 ? 'drop' : 'drops'}` : ''}
              </span>
              <span className="ov-dim">in 15 min</span>
            </span>
          ) : null}
        </span>
      </div>
      <Lane from={link.a} to={link.b} value={st.ab} level={st.abLevel} dir="right" />
      <Lane from={link.b} to={link.a} value={st.ba} level={st.baLevel} dir="left" />
    </div>
  );
}

function Lane({ from, to, value, level, dir }: { from: string; to: string; value: string | null; level: number; dir: 'left' | 'right' }) {
  const Arrow = dir === 'right' ? ArrowRight : ArrowLeft;
  return (
    <div className="ov-lane">
      <span className="visually-hidden">{`${from} to ${to}: ${value ?? 'no data'}`}</span>
      <div className={`ov-lane__track ov-lane__track--${dir}`} data-level={level} aria-hidden="true">
        <span className="ov-lane__flow" />
      </div>
      <span className="ov-lane__value num" aria-hidden="true">
        <Arrow />
        {value ?? DASH}
      </span>
    </div>
  );
}

export function InterconnectSkeleton() {
  return (
    <Panel title="Interconnect" subtitle="ConnectX-7 direct links · live" className="ov-ic" busy>
      <div className="ov-ic__links">
        <div className="ov-ic__link">
          <div className="ov-ic__end"><Skeleton width={56} height={14} /></div>
          <div className="ov-ic__rails">
            {[0, 1].map((i) => (
              <div key={i} className="ov-rail">
                <div className="ov-rail__head"><Skeleton width={52} height={12} /><Skeleton width={140} height={12} /></div>
                <div className="ov-lane"><Skeleton height={6} radius={3} /></div>
                <div className="ov-lane"><Skeleton height={6} radius={3} /></div>
              </div>
            ))}
          </div>
          <div className="ov-ic__end"><Skeleton width={56} height={14} /></div>
        </div>
      </div>
    </Panel>
  );
}
