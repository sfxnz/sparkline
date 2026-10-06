// A living node card: what the node runs, GPU load, heat, power, unified memory, CX7 traffic and recent trend.
// Every number is its own subscriber, so a tick re-renders only the leaves whose value changed. The ambient glow is
// driven by a CSS custom property (useBreath), never by React renders.
import { ArrowLeft, ArrowRight, Clock, OctagonAlert, RotateCw, TriangleAlert, Unplug } from 'lucide-react';
import { m } from 'motion/react';
import { createContext, useCallback, useContext, useRef, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { paths } from '../../app/routes';
import { unsupportedReason } from '../../charts/TimeSeriesChart';
import { AnimatedNumber } from '../../design/components/AnimatedNumber';
import { Button } from '../../design/components/Button';
import { InlineCode } from '../../design/components/InlineCode';
import { Panel } from '../../design/components/Panel';
import { RingGauge } from '../../design/components/RingGauge';
import { Skeleton } from '../../design/components/Skeleton';
import { Sparkline } from '../../design/components/Sparkline';
import { StatusPill } from '../../design/components/StatusPill';
import { Unsupported } from '../../design/components/Unsupported';
import { springs } from '../../design/motion';
import { useNow } from '../../design/useNow';
import { api } from '../../lib/api';
import { bitrateParts, DASH, formatAgo, formatBytes, formatPercent, formatWatts, text, wattsParts } from '../../lib/format';
import { HEADROOM_WARN_C } from '../../lib/condition';
import type { NodeInfo, Sample } from '../../lib/types';
import { serverNow, useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { useNodeDisplayStatus } from '../../store/attention';
import { liveStore, useLatest } from '../../store/live';
import { preloadSummary } from '../node/tabs';
import { shallowEqual, useAcross, useBreath, useFreshness, useLiveValue, type Freshness } from './hooks';
import { memSplit, topGpuProcess, workloadName } from './model';
import { spanPhrase } from '../shared/live';

interface CardCtx {
  id: string;
  freshness: Freshness;
  info: NodeInfo | null;
}
const Ctx = createContext<CardCtx>({ id: '', freshness: 'waiting', info: null });

/** Recent window for sparklines and the observed power peak. */
const PEAK_WINDOW_S = 900;

const preload = () => { void preloadSummary(); };

const intText = (n: number) => n.toFixed(0);
const wattsText = (n: number) => wattsParts(n, 'W').value;

export function NodeCard({ id }: { id: string }) {
  const info = useCluster((s) => s.nodes[id]?.info ?? null);
  const { freshness } = useFreshness(id);
  const display = useNodeDisplayStatus(id);
  const [, navigate] = useLocation();
  const surface = useRef<HTMLDivElement>(null);
  useBreath(surface, id, freshness === 'live');

  // The whole card is a pointer target; the title link is its keyboard equivalent (Enter), so the surface
  // itself is not an extra tab stop. Clicks on the card's own controls keep their meaning.
  const onClick = useCallback(
    (e: MouseEvent) => {
      if (e.defaultPrevented || (e.target as HTMLElement).closest('a, button')) return;
      navigate(paths.node(id));
    },
    [navigate, id],
  );

  const dim = freshness === 'stale' || freshness === 'down';
  return (
    <Ctx.Provider value={{ id, freshness, info }}>
      <m.div
        ref={surface}
        layoutId={`node-card-${id}`}
        transition={springs.layout}
        className={`ov-card${dim ? ' ov-card--dim' : ''}`}
        data-breath="0"
        onClick={onClick}
        onPointerEnter={preload}
        onFocus={preload}
      >
        <span className="ov-card__glow" aria-hidden="true" />
        <Panel
          className="ov-card__panel"
          label={`Node ${id}`}
          busy={freshness === 'waiting' || undefined}
          title={<CardTitle id={id} />}
          subtitle={<Workload />}
          actions={<StatusPill status={display} />}
        >
          <div className="ov-card__values">
            <div className="ov-card__top">
              <UtilRing />
              <div className="ov-card__stats">
                <Temperature />
                <Power />
              </div>
            </div>
            <MemoryBar />
          </div>
          {/* The stale/offline notice takes the place of the link and trend row (which are frozen anyway), inside a
              slot of fixed height, so a node changing state never resizes its card or the row of cards. */}
          <div className={`ov-card__foot${dim ? ' has-notice' : ''}`}>
            <div className="ov-card__foot-main">
              <Interconnect />
              <div className="ov-card__sparks">
                <Spark metric="gpu0.util" label="GPU utilisation" format={(n) => formatPercent(n)} min={0} max={100} />
                <Spark metric="gpu0.power_w" label="GPU power" format={formatWatts} min={0} />
              </div>
            </div>
            <CardNotice />
          </div>
        </Panel>
      </m.div>
    </Ctx.Provider>
  );
}

/** Loading placeholder with exactly the card's structure. */
export function NodeCardSkeleton() {
  return (
    <div className="ov-card">
      <Panel className="ov-card__panel" label="Loading node" busy title={<Skeleton width={92} height={18} />} subtitle={<Skeleton width={180} height={12} style={{ marginTop: 3 }} />} actions={<Skeleton width={78} height={24} radius={12} />}>
        <div className="ov-card__values">
          <div className="ov-card__top">
            <Skeleton width={RING} height={RING} radius={RING / 2} />
            <div className="ov-card__stats">
              <StatSkel />
              <StatSkel />
            </div>
          </div>
          <div className="ov-mem">
            <div className="ov-row"><Skeleton width={110} height={12} /><Skeleton width={96} height={12} /></div>
            <Skeleton height={8} radius={4} />
            <Skeleton width="70%" height={12} />
          </div>
        </div>
        <div className="ov-card__foot">
          <div className="ov-card__foot-main">
            <div className="ov-row ov-cx"><Skeleton width={84} height={12} /><Skeleton width={150} height={12} /></div>
            <div className="ov-card__sparks">
              {[0, 1].map((i) => (
                <div key={i} className="ov-spark"><Skeleton width={90} height={11} /><Skeleton height={SPARK_H} radius={6} /></div>
              ))}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

const RING = 96;
const SPARK_H = 36;

function StatSkel() {
  return (
    <div className="ov-stat">
      <Skeleton width={96} height={12} />
      <Skeleton width={72} height={24} radius={7} style={{ margin: '3px 0' }} />
      <Skeleton width={120} height={11} />
    </div>
  );
}

function CardTitle({ id }: { id: string }) {
  return (
    <Link href={paths.node(id)} className="ov-card__title">
      <m.span layoutId={`node-title-${id}`} transition={springs.layout} className="ov-card__name">{id}</m.span>
      <span className="visually-hidden">, open node details</span>
    </Link>
  );
}

const workloadSelector = (s: Sample | null): string | null | undefined => {
  if (!s?.procs) return undefined; // not reported yet
  const top = topGpuProcess(s.procs);
  if (!top) return null;
  const name = workloadName(top);
  return top.container && top.container !== name ? `${name} · ${top.container}` : name;
};

function Workload() {
  const { id, freshness } = useContext(Ctx);
  const w = useLatest(id, workloadSelector);
  // Processes refresh every few seconds: while live, wait for them; when not live, say we don't know.
  if (w === undefined) return freshness === 'waiting' || freshness === 'live' ? <Skeleton width={180} height={12} style={{ marginTop: 3 }} /> : <span className="ov-card__workload ov-dim">Workload unknown</span>;
  return <span className="ov-card__workload" title={w ?? undefined}>{w ?? 'No GPU processes'}</span>;
}

function CardNotice() {
  const { id, freshness } = useContext(Ctx);
  const node = useCluster((s) => s.nodes[id]);
  const consoleLive = useConnection((s) => s.status === 'live');
  const now = useNow(1000);
  if (freshness === 'live' || freshness === 'waiting' || !node) return null;
  const lastTs = liveStore.lastTs(id) ?? node.last_sample_ts;
  const ago = lastTs ? `updated ${formatAgo(lastTs, now / 1000 + useCluster.getState().clockOffset)}` : 'no data received';
  if (freshness === 'stale') {
    return (
      <div className="ov-notice ov-notice--stale">
        <Clock aria-hidden="true" />
        <strong className="ov-notice__msg">{consoleLive ? `${id} is not reporting` : 'Not live'}</strong>
        <span className="ov-notice__meta num">Showing the last values · {ago}</span>
      </div>
    );
  }
  const secs = node.next_retry_ts ? Math.max(0, Math.ceil(node.next_retry_ts - serverNow())) : null;
  return (
    <div className="ov-notice ov-notice--down">
      <Unplug aria-hidden="true" />
      <strong className="ov-notice__msg">{node.error?.message ?? (node.status === 'offline' ? `${id} is offline` : `${id} has a connection error`)}</strong>
      <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={() => { void api.retryNode(id).catch(() => undefined); }}>
        Retry
      </Button>
      {node.error?.fix ? <span className="ov-notice__fix"><InlineCode text={node.error.fix} /></span> : null}
      <span className="ov-notice__meta num">
        Last values {ago}
        {secs !== null ? (secs > 0 ? ` · auto-retry in ${secs}\u00a0s` : ' · retrying…') : ''}
      </span>
    </div>
  );
}

function UtilRing() {
  const { id, freshness } = useContext(Ctx);
  const util = useLiveValue(id, 'gpu0.util', 1);
  if (util === null && freshness === 'waiting') return <Skeleton width={RING} height={RING} radius={RING / 2} />;
  return (
    <RingGauge value={util === null ? null : util / 100} size={RING} stroke={8} label={`GPU utilisation ${util === null ? 'unknown' : `${util.toFixed(0)}%`}`}>
      <span className="ov-ring">
        <span className="ov-ring__value">
          <AnimatedNumber value={util} format={intText} />
          {util !== null ? <span className="ov-ring__unit">%</span> : null}
        </span>
        <span className="ov-ring__label">GPU</span>
      </span>
    </RingGauge>
  );
}

function StatBlock({ label, value, unit, format, footer, unsupported }: { label: string; value: number | null; unit: string; format: (n: number) => string; footer?: ReactNode; unsupported?: string | null }) {
  const { freshness } = useContext(Ctx);
  if (value === null && freshness === 'waiting' && !unsupported) return <StatSkel />;
  return (
    <div className="ov-stat">
      <span className="ov-stat__label">{label}</span>
      {unsupported ? (
        <Unsupported reason={unsupported} />
      ) : (
        <span className="ov-stat__value">
          <AnimatedNumber value={value} format={format} className="ov-stat__number" />
          {value !== null ? <span className="ov-stat__unit">{unit}</span> : null}
        </span>
      )}
      {footer && !unsupported ? <span className="ov-stat__footer">{footer}</span> : null}
    </div>
  );
}

function Temperature() {
  const { id, info } = useContext(Ctx);
  const temp = useLiveValue(id, 'gpu0.temp_c', 1);
  const slowdown = info?.gpus[0]?.temp_slowdown_c ?? null;
  const headroom = temp !== null && slowdown !== null ? slowdown - temp : null;
  let footer: ReactNode = null;
  if (headroom !== null) {
    const why = <span className="visually-hidden"> to the {slowdown} °C slowdown threshold</span>;
    footer =
      headroom <= 0 ? (
        <span className="ov-flag tone-crit"><OctagonAlert aria-hidden="true" />At slowdown{why}</span>
      ) : headroom <= HEADROOM_WARN_C ? (
        <span className="ov-flag tone-warn"><TriangleAlert aria-hidden="true" /><span className="num">{headroom.toFixed(0)} °C</span> headroom{why}</span>
      ) : (
        <><span className="num">{headroom.toFixed(0)} °C</span> headroom{why}</>
      );
  }
  return (
    <StatBlock
      label="GPU temp"
      value={temp}
      unit="°C"
      format={intText}
      footer={footer}
      unsupported={unsupportedReason(info, 'gpu0.temp_c')}
    />
  );
}

function Power() {
  const { id, info } = useContext(Ctx);
  const power = useLiveValue(id, 'gpu0.power_w', 0.1);
  const peak = useAcross(
    [id],
    () => {
      const w = liveStore.window(id, ['gpu0.power_w'], serverNow() - PEAK_WINDOW_S);
      let max: number | null = null;
      for (const v of w.values[0] ?? []) if (v !== null && (max === null || v > max)) max = v;
      // The span the browser really holds (to the minute), so the words never claim 15 minutes of 3.
      return { max: max === null ? null : Math.round(max * 10) / 10, phrase: spanPhrase('live', w.ts[0], serverNow()) };
    },
    shallowEqual,
  );
  return (
    <StatBlock
      label="GPU power"
      value={power}
      unit="W"
      format={wattsText}
      footer={peak.max !== null ? <>Peak <span className="num">{formatWatts(peak.max)}</span><span className="visually-hidden"> in the {peak.phrase}</span></> : null}
      unsupported={unsupportedReason(info, 'gpu0.power_w')}
    />
  );
}

const GIB = 1024 ** 3;

function MemoryBar() {
  const { id, info, freshness } = useContext(Ctx);
  const available = useLiveValue(id, 'mem.available', GIB / 20);
  const gpu = useLiveValue(id, 'mem.gpu', GIB / 20);
  const split = memSplit(info?.mem_total, available, gpu);
  if (!split && freshness === 'waiting') {
    return (
      <div className="ov-mem">
        <div className="ov-row"><Skeleton width={110} height={12} /><Skeleton width={96} height={12} /></div>
        <Skeleton height={8} radius={4} />
        <Skeleton width="70%" height={12} />
      </div>
    );
  }
  const used = split ? split.gpu + split.other : null;
  const pct = split && used !== null ? (100 * used) / split.total : null;
  const label = split
    ? `Unified memory: ${formatBytes(used)} of ${formatBytes(split.total)} in use (${formatPercent(pct)})${split.gpuKnown ? `, ${formatBytes(split.gpu)} GPU-allocated` : ''}, ${formatBytes(split.available)} available`
    : 'Unified memory: no data';
  return (
    <div className="ov-mem">
      <div className="ov-row">
        <span className="ov-label">Unified memory</span>
        <span className="ov-mem__total num">
          {split ? (
            <>
              {formatBytes(used)} <span className="ov-dim">of {formatBytes(split.total)}</span>
            </>
          ) : DASH}
        </span>
      </div>
      <div className="ov-mem__bar" role="img" aria-label={label}>
        {split ? (
          <>
            <span className="ov-mem__seg ov-mem__seg--gpu" style={{ width: `${split.gpuFrac * 100}%` }} />
            <span className="ov-mem__seg ov-mem__seg--other" style={{ width: `${split.otherFrac * 100}%` }} />
          </>
        ) : null}
      </div>
      <ul className="ov-legend" aria-hidden="true">
        {split?.gpuKnown ? <li><i className="ov-sw ov-sw--gpu" />GPU <span className="num">{formatBytes(split.gpu)}</span></li> : null}
        <li><i className="ov-sw ov-sw--other" />{split?.gpuKnown ? 'Other' : 'In use'} <span className="num">{split ? formatBytes(split.other) : DASH}</span></li>
        <li><i className="ov-sw ov-sw--free" />Available <span className="num">{split ? formatBytes(split.available) : DASH}</span></li>
      </ul>
    </div>
  );
}

function Interconnect() {
  const { id, info, freshness } = useContext(Ctx);
  const rails = (info?.net ?? []).filter((n) => n.role === 'interconnect' && n.peer);
  const names = rails.map((r) => r.name).join('|');
  const flow = useAcross(
    [id],
    () => {
      let rx: number | null = null;
      let tx: number | null = null;
      for (const name of names ? names.split('|') : []) {
        const r = liveStore.latestValue(id, `net.${name}.rx_bps`);
        const t = liveStore.latestValue(id, `net.${name}.tx_bps`);
        if (r !== null) rx = (rx ?? 0) + r;
        if (t !== null) tx = (tx ?? 0) + t;
      }
      // Quantise to what the display shows (3 significant figures).
      const q = (v: number | null) => (v === null ? null : text(bitrateParts(v)));
      return { rx: q(rx), tx: q(tx) };
    },
    shallowEqual,
    names,
  );
  const peers = [...new Set(rails.map((r) => r.peer))];
  if (!rails.length) {
    return (
      <div className="ov-row ov-cx">
        <span className="ov-label">ConnectX-7</span>
        <span className="ov-cx__none">{freshness === 'waiting' && !info ? <Skeleton width={150} height={12} /> : 'No direct link'}</span>
      </div>
    );
  }
  return (
    <div className="ov-row ov-cx">
      <span className="ov-label">
        <span className="ov-cx__long">ConnectX-7</span>
        <abbr className="ov-cx__short" title="ConnectX-7">CX7</abbr> <span className="ov-dim">↔ {peers.join(', ')}</span>
      </span>
      <span className="ov-cx__rates num">
        {/* Arrows point the way the data travels, as in the Interconnect panel: → out to the peer, ← in from it. */}
        <span className="ov-cx__rate">
          <ArrowRight aria-hidden="true" />
          <span className="visually-hidden">Out </span>
          {flow.tx ?? DASH}
        </span>
        <span className="ov-cx__rate">
          <ArrowLeft aria-hidden="true" />
          <span className="visually-hidden">In </span>
          {flow.rx ?? DASH}
        </span>
      </span>
    </div>
  );
}

function Spark({ metric, label, format, min, max }: { metric: string; label: string; format: (n: number) => string; min?: number; max?: number }) {
  const { id, freshness, info } = useContext(Ctx);
  const reason = unsupportedReason(info, metric);
  return (
    <div className="ov-spark">
      <span className="ov-spark__label">{label} <span className="ov-dim">· 3 min</span></span>
      {reason ? (
        <Unsupported reason={reason} />
      ) : freshness === 'waiting' ? (
        <Skeleton height={SPARK_H} radius={6} />
      ) : (
        <Sparkline label={`${id} ${label}`} source={{ node: id, metric }} format={format} height={SPARK_H} min={min} max={max} />
      )}
    </div>
  );
}

