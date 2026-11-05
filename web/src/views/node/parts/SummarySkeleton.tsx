// Suspense fallback for the Summary tab: the same grid as Summary.tsx (8 stats, then the chart panels with their real
// titles), so nothing moves when the chunk lands. Lives in the main chunk because it shows while Summary loads.
import { Panel } from '../../../design/components/Panel';
import { Skeleton } from '../../../design/components/Skeleton';
import { nicHeading, nicModel } from '../../../lib/interconnect';
import { useCluster } from '../../../store/cluster';
import { ChartSkeleton } from '../../placeholders';

const statLabels = (nic: string) => ['GPU utilisation', 'GPU temperature', 'GPU power', 'Memory available', 'CPU utilisation', `${nic} in`, `${nic} out`, 'Root disk used'];
const charts = (nic: string): { title: string; wide?: boolean }[] => [
  { title: 'GPU utilisation' },
  { title: 'GPU power' },
  { title: 'Unified memory' },
  { title: 'CPU utilisation' },
  { title: `${nic} throughput`, wide: true },
];
/** TimeSeriesChart at height 168: legend row (26) + gap (8) + plot. */
const CHART_H = 168 + 34;

export function SummarySkeleton({ nodeId }: { nodeId: string }) {
  const nic = nicHeading(useCluster((s) => nicModel(s.nodes[nodeId]?.info?.net)));
  return (
    <div className="view nsum" aria-busy="true">
      <Panel label="At a glance" busy>
        <div className="nstats nstats--8">
          {statLabels(nic).map((label) => (
            <div key={label} className="stat stat--md nstat--loading">
              <div className="stat__label">{label}</div>
              <Skeleton width={84} height={24} radius={8} />
              <Skeleton width={96} height={10} />
            </div>
          ))}
        </div>
      </Panel>
      <div className="nsum__charts">
        {charts(nic).map((c) => (
          <Panel key={c.title} title={c.title} className={c.wide ? 'nsum__wide' : undefined} busy>
            <ChartSkeleton height={CHART_H} />
          </Panel>
        ))}
      </div>
    </div>
  );
}
