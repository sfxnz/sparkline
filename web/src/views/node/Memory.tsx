import { CircleCheck, Hourglass, TriangleAlert } from 'lucide-react';
import { TimeSeriesChart, type SeriesSpec } from '../../charts/TimeSeriesChart';
import { Panel } from '../../design/components/Panel';
import { Skeleton } from '../../design/components/Skeleton';
import { Unsupported } from '../../design/components/Unsupported';
import { bytesParts, formatBytes, formatPercent } from '../../lib/format';
import type { Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useLatest } from '../../store/live';
import { useBufferTs, useFreshness } from './parts/hooks';
import { BYTE_INCRS } from '../../charts/theme';
import { lastKnownValue } from '../shared/live';
import { LiveStat } from './parts/LiveStat';
import { memoryPressure } from './parts/memory';
import { MemoryHero } from './parts/MemoryHero';
import { CollectorErrors } from './parts/Notices';
import { ProcTable } from './parts/ProcTable';
import { memSwapUsed } from './parts/selectors';
import { StackedAreaChart, type StackSeries } from './parts/StackedAreaChart';
import type { NodeTabProps } from './tabs';

const STACK: readonly StackSeries[] = [
  { key: 'mem.gpu', label: 'GPU-allocated', className: 'mem-c-gpu' },
  { key: 'mem.anon', label: 'Processes', className: 'mem-c-anon' },
  { key: 'mem.shmem', label: 'Shared', className: 'mem-c-shmem' },
  { key: 'mem.kernel', label: 'Kernel', className: 'mem-c-kernel' },
  { key: 'mem.other', label: 'Other', className: 'mem-c-other' },
  { key: 'mem.cache', label: 'Page cache', className: 'mem-c-cache', hatched: true },
];
const PSI: readonly SeriesSpec[] = [
  { key: 'mem.psi_some', label: 'Some stalled' },
  { key: 'mem.psi_full', label: 'All stalled' },
];
const pct1 = (n: number) => formatPercent(n, n > 0 && n < 10 ? 1 : 0);
const PSI_UNSUPPORTED = 'Pressure stall information (/proc/pressure/memory) is not available on this kernel.';

export default function Memory({ nodeId }: NodeTabProps) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const total = info?.mem_total;
  const swapTotal = info?.swap_total ?? null;

  return (
    <div className="view">
      <CollectorErrors nodeId={nodeId} only={['memory']} />
      <Panel label="Unified memory">
        <MemoryHero nodeId={nodeId} total={total ?? null} />
      </Panel>

      <div className="nmem__grid">
        <Panel title="Breakdown over time" subtitle="Stacked: each layer sits on the ones below; the space above is free memory">
          <StackedAreaChart node={nodeId} title="Unified memory breakdown" series={STACK} format={formatBytes} yMax={total} yIncrs={BYTE_INCRS} height={292} />
        </Panel>
        <div className="nmem__side">
          <Panel title="Memory pressure" subtitle="Share of time processes waited for memory">
            <PressureNow nodeId={nodeId} />
            <TimeSeriesChart node={nodeId} title="Memory pressure" series={PSI} format={pct1} yMin={0} yMax={5} height={120} />
          </Panel>
          <Panel title="Swap">
            {swapTotal === 0 ? (
              <p className="nmuted">No swap is configured on {nodeId}.</p>
            ) : (
              <div className="nswap">
                <LiveStat nodeId={nodeId} label="Swap used" select={memSwapUsed} metric="mem.swap_used" format={bytesParts} footer={() => (swapTotal ? `of ${formatBytes(swapTotal)}` : null)} />
                <SwapBar nodeId={nodeId} total={swapTotal} />
              </div>
            )}
          </Panel>
        </div>
      </div>

      <Panel title="Top memory consumers" subtitle="Resident memory plus GPU allocations, which share the same pool" flush>
        <ProcTable nodeId={nodeId} mode="memory" />
      </Panel>
    </div>
  );
}

const selectPsi = (s: Sample | null) => (s ? `${s.mem.psi_some ?? 'x'}|${s.mem.psi_full ?? 'x'}` : null);

function PressureNow({ nodeId }: { nodeId: string }) {
  const live = useLatest(nodeId, selectPsi);
  const { waiting, stale } = useFreshness(nodeId);
  useBufferTs(nodeId, live === null && stale);
  const key = live ?? (stale ? `${lastKnownValue(nodeId, 'mem.psi_some') ?? 'x'}|${lastKnownValue(nodeId, 'mem.psi_full') ?? 'x'}` : null);
  if (key === null) {
    return waiting ? (
      <div className="npsi" aria-busy="true">
        <Skeleton width={28} height={28} radius={10} />
        <Skeleton width={180} height={14} />
      </div>
    ) : null;
  }
  const [some, full] = key.split('|').map((x) => (x === 'x' ? null : Number(x)));
  const p = memoryPressure(some ?? null, full ?? null);
  if (!p) return <div className="npsi"><Unsupported reason={PSI_UNSUPPORTED} /></div>;
  const tone = p.level === 'none' ? 'tone-ok' : p.level === 'some' ? 'tone-warn' : 'tone-crit';
  const Icon = p.level === 'none' ? CircleCheck : p.level === 'some' ? Hourglass : TriangleAlert;
  return (
    <div className={`npsi ${tone}${stale ? ' npsi--stale' : ''}`}>
      <span className="npsi__icon" aria-hidden="true"><Icon /></span>
      <p className="npsi__text">{p.text}</p>
    </div>
  );
}

function SwapBar({ nodeId, total }: { nodeId: string; total: number | null }) {
  const live = useLatest(nodeId, memSwapUsed);
  useBufferTs(nodeId, live === null);
  const used = live ?? lastKnownValue(nodeId, 'mem.swap_used');
  if (!total || used == null) return <div className="nswap__bar" aria-hidden="true" />;
  const pct = Math.min(100, (100 * used) / total);
  return (
    <div className="nswap__bar" role="img" aria-label={`Swap ${formatPercent(pct)} used`}>
      <span style={{ width: `${pct.toFixed(2)}%` }} />
    </div>
  );
}
