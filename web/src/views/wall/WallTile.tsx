// One node on the wall. The tile shell re-renders only on status changes; every number is its own live leaf
// (useLiveValue) and the glow is written straight to the DOM by useBreath, so a tick costs a few text updates.
import { CircleSlash, Clock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatedNumber } from '../../design/components/AnimatedNumber';
import { Skeleton } from '../../design/components/Skeleton';
import { Sparkline } from '../../design/components/Sparkline';
import { StatusPill } from '../../design/components/StatusPill';
import { Unsupported } from '../../design/components/Unsupported';
import { bytesParts, DASH, formatAgo, formatPercent, tempParts, wattsParts, type Formatter } from '../../lib/format';
import type { NodeInfo } from '../../lib/types';
import { serverNow, useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { useNodeDisplayStatus } from '../../store/attention';
import { liveStore } from '../../store/live';
import { useTick } from '../alerts/parts/tick';
import { shallowEqual, useAcross, useBreath, useFreshness, useLiveValue, type Freshness } from '../overview/hooks';
import { cx7Throughput, gbpsParts, interconnectNames } from './model';

const unsupportedReason = (info: NodeInfo | null, key: string) => info?.unsupported.find((u) => u.metric === key)?.reason;

/** Big number + unit; the unit is fixed while a value animates so the digits never jump between units. */
function BigValue({ value, parts, className }: { value: number | null; parts: Formatter; className?: string }) {
  const unit = value == null ? '' : parts(value).unit;
  const text = useCallback((n: number) => parts(n, unit || undefined).value, [parts, unit]);
  return (
    <span className={`wall-value ${className ?? ''}`}>
      <AnimatedNumber value={value} format={text} scale={unit} className="wall-value__num" />
      {unit && value != null ? <span className="wall-value__unit">{unit}</span> : null}
    </span>
  );
}

const pctParts: Formatter = (n) => ({ value: n.toFixed(0), unit: '%' });
const gibParts: Formatter = (n) => bytesParts(n, 'GiB');
const wParts: Formatter = (n) => wattsParts(n, 'W');

function LiveMetric({ node, metric, parts, quantum, info }: { node: string; metric: string; parts: Formatter; quantum?: number; info: NodeInfo | null }) {
  const value = useLiveValue(node, metric, quantum);
  const reason = unsupportedReason(info, metric);
  if (reason) return <Unsupported reason={reason} />;
  return <BigValue value={value} parts={parts} />;
}

function Cx7({ node, info }: { node: string; info: NodeInfo | null }) {
  const names = useMemo(() => interconnectNames(info?.net), [info]);
  const v = useAcross([node], () => {
    const t = cx7Throughput((k) => liveStore.latestValue(node, k), names);
    // 0.8 Mb/s steps (below display precision), but any traffic at all stays above zero.
    return { v: t === null ? null : t > 0 ? Math.max(1, Math.round(t / 1e5) * 1e5) : 0 };
  }, shallowEqual, names.join(','));
  if (!names.length) return <Unsupported reason="No ConnectX-7 rail on this node is cabled to another node." label="No direct link" />;
  return <BigValue value={v.v} parts={gbpsParts} />;
}

/** "Updated 12 s ago", "Offline · last seen 2 min ago": what makes old numbers obviously old. */
function Freshness({ id, freshness }: { id: string; freshness: Freshness }) {
  useTick(1000);
  const node = useCluster((s) => s.nodes[id]);
  const consoleLive = useConnection((s) => s.status === 'live');
  const last = node?.last_sample_ts ?? liveStore.lastTs(id);
  if (freshness === 'live') return <p className="wall-tile__fresh" aria-hidden="true" />; // keeps tiles aligned
  if (freshness === 'waiting') return <p className="wall-tile__fresh">Waiting for the first sample…</p>;
  const ago = last ? formatAgo(last, serverNow()) : null;
  if (freshness === 'down') {
    return (
      <p className="wall-tile__fresh">
        <CircleSlash aria-hidden="true" />
        <span>{ago ? `Last seen ${ago} · ` : ''}{node?.error?.message ?? `${id} is not responding`}</span>
      </p>
    );
  }
  return (
    <p className="wall-tile__fresh">
      <Clock aria-hidden="true" />
      <span>{consoleLive ? 'No new data' : 'Not live'}{ago ? ` · updated ${ago}` : ''}</span>
    </p>
  );
}

/** Sparkline height follows the viewport (the wall is often 4K). */
function useVh(fraction: number, min: number): number {
  const [h, setH] = useState(() => Math.max(min, Math.round(window.innerHeight * fraction)));
  useEffect(() => {
    const on = () => { setH(Math.max(min, Math.round(window.innerHeight * fraction))); };
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('resize', on); };
  }, [fraction, min]);
  return h;
}

export function WallTile({ id }: { id: string }) {
  const info = useCluster((s) => s.nodes[id]?.info ?? null);
  const { freshness } = useFreshness(id);
  const display = useNodeDisplayStatus(id);
  const ref = useRef<HTMLElement>(null);
  useBreath(ref, id, freshness === 'live');
  const sparkH = useVh(0.075, 48);
  const dim = freshness === 'stale' || freshness === 'down';

  return (
    <section ref={ref} className={`wall-tile${dim ? ' is-dim' : ''}${freshness === 'down' ? ' is-down' : ''}`} data-breath="0" aria-label={`Node ${id}`} aria-busy={freshness === 'waiting' || undefined}>
      <span className="wall-tile__glow" aria-hidden="true" />
      <header className="wall-tile__head">
        <h2 className="wall-tile__name">{id}</h2>
        <span className="wall-tile__status">
          <StatusPill status={display} />
        </span>
      </header>
      <Freshness id={id} freshness={freshness} />

      {freshness === 'waiting' ? (
        <TileSkeleton sparkH={sparkH} />
      ) : (
        <div className="wall-tile__body">
          <div className="wall-tile__hero">
            <span className="wall-label">GPU utilisation</span>
            <LiveMetric node={id} metric="gpu0.util" parts={pctParts} quantum={1} info={info} />
          </div>
          <div className="wall-tile__spark">
            <Sparkline label={`${id} GPU utilisation, last 5 minutes`} source={{ node: id, metric: 'gpu0.util', windowS: 300 }} format={(n) => formatPercent(n)} min={0} max={100} height={sparkH} />
          </div>
          <dl className="wall-tile__stats">
            <div>
              <dt className="wall-label">GPU temperature</dt>
              <dd><LiveMetric node={id} metric="gpu0.temp_c" parts={tempParts} quantum={1} info={info} /></dd>
            </div>
            <div>
              <dt className="wall-label">GPU power</dt>
              <dd><LiveMetric node={id} metric="gpu0.power_w" parts={wParts} quantum={0.5} info={info} /></dd>
            </div>
            <div>
              <dt className="wall-label">Memory available</dt>
              <dd><LiveMetric node={id} metric="mem.available" parts={gibParts} quantum={0.1 * 1024 ** 3} info={info} /></dd>
            </div>
            <div>
              <dt className="wall-label">ConnectX-7 in + out</dt>
              <dd><Cx7 node={id} info={info} /></dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}

function TileSkeleton({ sparkH }: { sparkH: number }) {
  return (
    <div className="wall-tile__body" aria-hidden="true">
      <div className="wall-tile__hero">
        <span className="wall-label">GPU utilisation</span>
        <Skeleton width="40%" height="1em" radius={12} className="wall-skel-hero" />
      </div>
      <Skeleton height={sparkH} radius={10} />
      <dl className="wall-tile__stats">
        {['GPU temperature', 'GPU power', 'Memory available', 'ConnectX-7 in + out'].map((l) => (
          <div key={l}>
            <dt className="wall-label">{l}</dt>
            <dd><span className="wall-value"><span className="wall-value__num">{DASH}</span></span></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
