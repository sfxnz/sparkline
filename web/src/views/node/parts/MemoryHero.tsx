import { Info } from 'lucide-react';
import { useCallback } from 'react';
import { AnimatedNumber } from '../../../design/components/AnimatedNumber';
import { Skeleton } from '../../../design/components/Skeleton';
import { useNow } from '../../../design/useNow';
import { bytesParts, formatAgo, formatBytes, formatPercent } from '../../../lib/format';
import { serverNow } from '../../../store/cluster';
import type { MemSample } from '../../../lib/types';
import { liveStore, useLatest } from '../../../store/live';
import { lastKnownValue } from '../../shared/live';
import { useBufferTs, useFreshness } from './hooks';
import { memoryBreakdown, type MemSegment } from './memory';
import { mem as selectMem } from './selectors';

const share = (s: MemSegment) => formatPercent(s.fraction * 100, s.fraction > 0 && s.fraction < 0.01 ? 1 : 0);

/** The unified-memory story: how much is available, and one bar of everything it is used for. */
export function MemoryHero({ nodeId, total }: { nodeId: string; total: number | null }) {
  const latest = useLatest(nodeId, selectMem);
  const { stale, waiting } = useFreshness(nodeId);
  const fallback = latest === null && stale && !!total;
  useBufferTs(nodeId, fallback);
  const m = latest ?? (fallback && total ? memFromBuffer(nodeId, total) : null);
  // Keep the headline unit fixed while the number animates.
  const unit = m ? bytesParts(m.total).unit : 'GiB';
  const fmt = useCallback((n: number) => bytesParts(n, unit).value, [unit]);

  if (!m) return waiting ? <HeroSkeleton /> : <p className="nmuted">No memory data has been received from {nodeId}.</p>;

  const b = memoryBreakdown(m);
  const seg = (k: MemSegment['key']) => b.segments.find((s) => s.key === k);
  const gpu = seg('gpu');
  const cache = seg('cache');
  const used = b.segments.filter((s) => s.group === 'used');
  const avail = b.segments.filter((s) => s.group === 'available');
  const sum = (xs: MemSegment[]) => xs.reduce((a, s) => a + s.fraction, 0);
  const label = `Unified memory: ${formatBytes(b.available)} available of ${formatBytes(b.total)}. ${b.segments.map((s) => `${s.label} ${formatBytes(s.bytes)} (${share(s)})`).join(', ')}.`;

  return (
    <div className={`nmem-hero${stale ? ' nmem-hero--stale' : ''}`}>
      <div className="nmem-hero__head">
        <div>
          <p className="t-eyebrow">Unified memory · shared by CPU and GPU</p>
          <p className="nmem-hero__headline">
            <span className="nmem-hero__big">
              <AnimatedNumber value={b.available} format={fmt} /> {unit}
            </span>
            <span className="nmem-hero__of num">available of {formatBytes(b.total)}</span>
          </p>
          <p className="nmem-hero__sub num">
            {gpu ? `The GPU holds ${formatBytes(gpu.bytes)} (${share(gpu)}). ` : ''}
            {formatBytes(b.used)} in use{cache && cache.bytes > 0 ? `; ${formatBytes(cache.bytes)} of page cache can be reclaimed on demand.` : '.'}
          </p>
        </div>
        {stale ? <StaleAge nodeId={nodeId} /> : null}
      </div>

      <div>
        <div className="membar" role="img" aria-label={label}>
          {b.segments.map((s) => (
            <span key={s.key} className={`membar__seg mem-c-${s.key}`} style={{ width: `calc(${(s.fraction * 100).toFixed(3)}% - 2px)` }} />
          ))}
        </div>
        <div className="membar__groups" aria-hidden="true">
          <span className="membar__group" style={{ width: `calc(${(sum(used) * 100).toFixed(3)}% - 2px)` }}>
            <span className="membar__group-name">In use</span> <span className="num">{formatBytes(b.used)}</span>
          </span>
          <span className="membar__group" style={{ width: `${(sum(avail) * 100).toFixed(3)}%` }}>
            <span className="membar__group-name">Available</span> <span className="num">{formatBytes(b.available)}</span>
          </span>
        </div>
      </div>

      <ul className="memlegend" aria-label="Memory breakdown">
        {b.segments.map((s) => (
          <li key={s.key} className="memlegend__item" title={s.help}>
            <span className={`memlegend__swatch mem-c-${s.key}`} aria-hidden="true" />
            <span className="memlegend__label">{s.label}</span>
            <span className="memlegend__value num">
              {formatBytes(s.bytes)}
              <span className="memlegend__pct">{share(s)}</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="nmem-note">
        <Info aria-hidden="true" />
        <span>
          CPU and GPU share one pool of memory, so GPU allocations come out of the same {formatBytes(b.total)}. Page cache is file data the kernel
          keeps for speed and gives back when programs need it, which is why it counts toward available.
        </span>
      </p>
    </div>
  );
}

function StaleAge({ nodeId }: { nodeId: string }) {
  useNow(1000);
  const last = liveStore.lastTs(nodeId);
  return <span className="nmem-hero__stale num">{last ? `Updated ${formatAgo(last, serverNow())}` : 'No recent data'}</span>;
}

function HeroSkeleton() {
  return (
    <div className="nmem-hero" aria-busy="true">
      <div className="nmem-hero__head">
        <div style={{ display: 'grid', gap: 8 }}>
          <Skeleton width={220} height={10} />
          <Skeleton width={340} height={30} radius={8} />
          <Skeleton width={420} height={12} />
        </div>
      </div>
      <div>
        <Skeleton height={28} radius={10} />
        <Skeleton width="100%" height={10} style={{ marginTop: 8 }} />
      </div>
      <div className="memlegend">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} style={{ display: 'grid', gap: 6 }}>
            <Skeleton width={80} height={10} />
            <Skeleton width={110} height={16} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Last known breakdown from the ring buffer (history seeded on connect), for a node that is not reporting. */
function memFromBuffer(nodeId: string, total: number): MemSample | null {
  const v = (k: string) => lastKnownValue(nodeId, `mem.${k}`);
  const available = v('available');
  if (available === null) return null;
  return {
    total,
    available,
    used: v('used') ?? total - available,
    free: 0,
    gpu: v('gpu'),
    anon: v('anon') ?? 0,
    cache: v('cache') ?? 0,
    shmem: v('shmem') ?? 0,
    kernel: v('kernel') ?? 0,
    other: v('other') ?? 0,
    swap_total: 0,
    swap_used: v('swap_used') ?? 0,
    psi_some: v('psi_some'),
    psi_full: v('psi_full'),
  };
}
