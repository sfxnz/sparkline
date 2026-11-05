// A living node card: what the node runs, GPU load, heat, power, memory, CX7 traffic and recent trend.
// Every number is its own subscriber, so a tick re-renders only the leaves whose value changed. The ambient glow is
// driven by a CSS custom property (useBreath), never by React renders.
import { ArrowLeft, ArrowRight, Clock, OctagonAlert, RotateCw, TriangleAlert, Unplug } from 'lucide-react';
import { m } from 'motion/react';
import { createContext, useCallback, useContext, useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { paths } from '../../app/routes';
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
import { headroomGpu, tempRoom } from '../../lib/condition';
import { memoryLayout } from '../../lib/memoryLayout';
import type { GpuInfo, NodeInfo, Sample } from '../../lib/types';
import { interconnectGap, notReported, type NotReported } from '../../lib/capabilities';
import { serverNow, useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { quietGpusOf, silentForOf, useNodeDisplayStatus } from '../../store/attention';
import { liveStore, useLatest } from '../../store/live';
import { preloadSummary } from '../node/tabs';
import { shallowEqual, useAcross, useBreath, useFreshness, useLiveValue, type Freshness } from './hooks';
import { memSplit, topGpuProcess, workloadName } from './model';
import { spanPhrase } from '../shared/live';
import { sameGap, useTotalFrom, useTotalGap } from '../shared/totalGap';
import { useNodeGpuGap } from '../node/parts/useGpuGap';
import { gpuProcessesGap, nodeGpuKey } from '../../lib/gpu';
import { gpuKey } from '../../lib/metrics';

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
  const layout = memoryLayout(info);
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
            <MemoryBar name={layout.name} sharesRam={layout.sharesRam} />
            {layout.sharesRam ? null : <GpuMemory gpus={layout.dedicated} />}
          </div>
          {/* The stale/offline notice takes the place of the link and trend row (which are frozen anyway), inside a
              slot of fixed height, so a node changing state never resizes its card or the row of cards. */}
          <div className={`ov-card__foot${dim ? ' has-notice' : ''}`}>
            <div className="ov-card__foot-main">
              <Interconnect />
              <div className="ov-card__sparks">
                <UtilSpark />
                <Spark metric={nodeGpuKey(info, 'power_w')} label="GPU power" format={formatWatts} min={0} />
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

type WorkloadSeen = NotReported | string | null | undefined;

const workloadSelector = (id: string, info: NodeInfo | null) => (s: Sample | null): WorkloadSeen => {
  const gap = gpuProcessesGap(info, s, quietGpusOf(id, info), silentForOf(id, info));
  if (gap) return gap;
  if (!s?.procs) return undefined; // not reported yet
  const top = topGpuProcess(s.procs);
  if (!top) return null;
  const name = workloadName(top);
  return top.container && top.container !== name ? `${name} · ${top.container}` : name;
};
const sameWorkload = (a: WorkloadSeen, b: WorkloadSeen) => a === b || (typeof a === 'object' && typeof b === 'object' && sameGap(a, b));

function Workload() {
  const { id, freshness, info } = useContext(Ctx);
  const w = useLatest(id, useMemo(() => workloadSelector(id, info), [id, info]), sameWorkload);
  if (w && typeof w === 'object') return <>GPU processes <Unsupported gap={w} /></>;
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
        {lastTs ? `Last values ${ago}` : 'No data received yet'}
        {secs !== null ? (secs > 0 ? ` · auto-retry in ${secs}\u00a0s` : ' · retrying…') : ''}
      </span>
    </div>
  );
}

function UtilRing() {
  const { id, freshness, info } = useContext(Ctx);
  const util = useLiveValue(id, nodeGpuKey(info, 'util'), 1);
  const from = useTotalFrom(id, 'util');
  const utilGap = useNodeGpuGap(id, 'util');
  const gap = util === null ? utilGap : null;
  if (util === null && freshness === 'waiting' && !gap) return <Skeleton width={RING} height={RING} radius={RING / 2} />;
  const said = gap ? gap.label.toLowerCase() : util === null ? 'unknown' : `${util.toFixed(0)}%${from ? `, from ${from}` : ''}`;
  return (
    <RingGauge value={util === null ? null : util / 100} size={RING} stroke={8} label={`GPU utilisation ${said}`}>
      <span className="ov-ring">
        {gap ? (
          <span className="ov-ring__gap">{gap.label}</span>
        ) : (
          <span className="ov-ring__value">
            <AnimatedNumber value={util} format={intText} />
            {util !== null ? <span className="ov-ring__unit">%</span> : null}
          </span>
        )}
        {from && !gap ? <span className="ov-ring__label ov-ring__label--from">{from}</span> : <span className="ov-ring__label">GPU</span>}
      </span>
    </RingGauge>
  );
}

function StatBlock({ label, value, unit, format, footer, unsupported }: { label: string; value: number | null; unit: string; format: (n: number) => string; footer?: ReactNode; unsupported?: NotReported | null }) {
  const { freshness } = useContext(Ctx);
  if (value === null && freshness === 'waiting' && !unsupported) return <StatSkel />;
  return (
    <div className="ov-stat">
      <span className="ov-stat__label">{label}</span>
      {unsupported ? (
        <Unsupported gap={unsupported} />
      ) : (
        <span className="ov-stat__value">
          <AnimatedNumber value={value} format={format} scale={unit} className="ov-stat__number" />
          {value !== null ? <span className="ov-stat__unit">{unit}</span> : null}
        </span>
      )}
      {footer && !unsupported ? <span className="ov-stat__footer">{footer}</span> : null}
    </div>
  );
}

function Temperature() {
  const { id, info } = useContext(Ctx);
  const temp = useLiveValue(id, nodeGpuKey(info, 'temp_c'), 1);
  const gpu = useAcross([id], () => headroomGpu(info, temp, (i) => liveStore.latestValue(id, gpuKey(i, 'temp_c'))), shallowEqual, `${String(temp)}|${info?.node_id ?? ''}`);
  const gap = useNodeGpuGap(id, 'temp_c');
  const from = useTotalFrom(id, 'temp_c');
  const room = tempRoom(gpu.temp, gpu.slowdown);
  const why = room ? <span className="visually-hidden"> to the {gpu.slowdown} °C slowdown threshold</span> : null;
  const flag =
    room?.level === 'crit' ? (
      <span className="ov-flag tone-crit"><OctagonAlert aria-hidden="true" />At slowdown{why}</span>
    ) : room?.level === 'warn' ? (
      <span className="ov-flag tone-warn"><TriangleAlert aria-hidden="true" /><span className="num">{room.degrees}&nbsp;°C</span> headroom{why}</span>
    ) : null;
  const headroom = room && !flag ? <><span className="num">{room.degrees}&nbsp;°C</span> headroom{why}</> : null;
  const name = flag && gpu.name ? gpu.name : null;
  const toRowWhenNarrow = !!flag || (!!headroom && !!from);
  const footer = flag || headroom || from ? (
    <>
      {flag ?? (headroom ? <span className={toRowWhenNarrow ? 'ov-stat__to-row' : 'ov-stat__headroom'}>{headroom}</span> : null)}
      {name ? <span className="ov-stat__who ov-stat__to-row">{name}</span> : null}
      {from ? <span className="ov-stat__who">{from}</span> : null}
    </>
  ) : null;
  return (
    <>
      <StatBlock label="GPU temp" value={temp} unit="°C" format={intText} footer={footer} unsupported={gap} />
      {gap ? null : toRowWhenNarrow ? (
        <p className="ov-card__flag">{flag ?? headroom}{name ? <span className="ov-stat__who">{name}</span> : null}</p>
      ) : headroom ? (
        <p className="ov-card__headroom">{headroom}</p>
      ) : null}
    </>
  );
}

function Power() {
  const { id, info } = useContext(Ctx);
  const key = nodeGpuKey(info, 'power_w');
  const power = useLiveValue(id, key, 0.1);
  const gap = useNodeGpuGap(id, 'power_w');
  const peak = useAcross(
    [id],
    () => {
      const w = liveStore.window(id, [key], serverNow() - PEAK_WINDOW_S);
      let max: number | null = null;
      for (const v of w.values[0] ?? []) if (v !== null && (max === null || v > max)) max = v;
      // The span the browser really holds (to the minute), so the words never claim 15 minutes of 3.
      return { max: max === null ? null : Math.round(max * 10) / 10, phrase: spanPhrase('live', w.ts[0], serverNow()) };
    },
    shallowEqual,
    key,
  );
  return (
    <StatBlock
      label="GPU power"
      value={power}
      unit="W"
      format={wattsText}
      footer={peak.max !== null ? <>Peak <span className="num">{formatWatts(peak.max)}</span><span className="visually-hidden"> in the {peak.phrase}</span></> : null}
      unsupported={gap}
    />
  );
}

const GIB = 1024 ** 3;

function MemoryBar({ name, sharesRam }: { name: string; sharesRam: boolean }) {
  const { id, info, freshness } = useContext(Ctx);
  const available = useLiveValue(id, 'mem.available', GIB / 20);
  const gpu = useLiveValue(id, 'mem.gpu', GIB / 20);
  const split = memSplit(info?.mem_total, available, sharesRam ? gpu : null);
  const gap = notReported(info, 'mem.available');
  if (gap) {
    return (
      <div className="ov-mem">
        <div className="ov-row"><span className="ov-label">{name}</span></div>
        <Unsupported gap={gap} />
      </div>
    );
  }
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
    ? `${name}: ${formatBytes(used)} of ${formatBytes(split.total)} in use (${formatPercent(pct)})${split.gpuKnown ? `, ${formatBytes(split.gpu)} GPU-allocated` : ''}, ${formatBytes(split.available)} available`
    : `${name}: no data`;
  return (
    <div className="ov-mem">
      <div className="ov-row">
        <span className="ov-label">{name}</span>
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

function GpuMemory({ gpus }: { gpus: readonly GpuInfo[] }) {
  const { id, info, freshness } = useContext(Ctx);
  const used = useLiveValue(id, nodeGpuKey(info, 'mem_used'), GIB / 20);
  const gap = useTotalGap(id, 'mem_used');
  const total = gpus.every((g) => g.vram_total != null) ? gpus.reduce((sum, g) => sum + (g.vram_total ?? 0), 0) : null;
  if (used === null && freshness === 'waiting' && !gap) {
    return (
      <div className="ov-mem">
        <div className="ov-row"><Skeleton width={90} height={12} /><Skeleton width={96} height={12} /></div>
        <Skeleton height={8} radius={4} />
      </div>
    );
  }
  const share = used !== null && total ? Math.min(1, used / total) : null;
  const label = used === null ? 'GPU memory: no data' : `GPU memory: ${formatBytes(used)}${total ? ` of ${formatBytes(total)} in use (${formatPercent(100 * (share ?? 0))})` : ' in use'}`;
  return (
    <div className="ov-mem">
      <div className="ov-row">
        <span className="ov-label">GPU memory</span>
        {gap ? (
          <Unsupported gap={gap} />
        ) : (
          <span className="ov-mem__total num">
            {used === null ? DASH : <>{formatBytes(used)} <span className="ov-dim">{total ? `of ${formatBytes(total)}` : 'in use'}</span></>}
          </span>
        )}
      </div>
      {gap ? null : (
        <div className="ov-mem__bar" role="img" aria-label={label}>
          {share !== null ? <span className="ov-mem__seg ov-mem__seg--gpu" style={{ width: `${share * 100}%` }} /> : null}
        </div>
      )}
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
  const gap = interconnectGap(info);
  if (!rails.length) {
    return (
      <div className="ov-row ov-cx">
        <span className="ov-label">
          {gap ? <><span className="ov-cx__long">ConnectX-7</span><abbr className="ov-cx__short" title="ConnectX-7">CX7</abbr></> : 'ConnectX-7'}
        </span>
        <span className="ov-cx__none">{gap ? <Unsupported gap={gap} /> : freshness === 'waiting' && !info ? <Skeleton width={150} height={12} /> : 'No direct link'}</span>
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

function UtilSpark() {
  const { id, info } = useContext(Ctx);
  const from = useTotalFrom(id, 'util');
  return <Spark metric={nodeGpuKey(info, 'util')} label="GPU utilisation" from={from} format={(n) => formatPercent(n)} min={0} max={100} />;
}

function Spark({ metric, label, from, format, min, max }: { metric: string; label: string; from?: string; format: (n: number) => string; min?: number; max?: number }) {
  const { id, freshness, info } = useContext(Ctx);
  const reason = notReported(info, metric);
  return (
    <div className="ov-spark">
      <span className="ov-spark__label">{label} <span className="ov-dim">{from ? `· ${from.replaceAll(' ', '\u00a0')}\u00a0· 3 min` : '· 3 min'}</span></span>
      {reason ? (
        <Unsupported gap={reason} />
      ) : freshness === 'waiting' ? (
        <Skeleton height={SPARK_H} radius={6} />
      ) : (
        <Sparkline label={`${id} ${label}${from ? ` (${from})` : ''}`} source={{ node: id, metric }} format={format} height={SPARK_H} min={min} max={max} />
      )}
    </div>
  );
}

