import { Panel } from '../design/components/Panel';
import { Skeleton } from '../design/components/Skeleton';
import { useCluster } from '../store/cluster';
import { RowsSkeleton, StatSkeleton } from './placeholders';
import './views.css';

export default function Overview() {
  const nodes = useCluster((s) => s.order);
  const cards = nodes.length ? nodes : ['a', 'b'];
  return (
    <div className="view" aria-busy="true">
      <div className="view__hero">
        <Skeleton width={420} height={26} radius={8} />
        <Skeleton width={260} height={14} />
      </div>
      <div className="grid grid--nodes">
        {cards.map((id) => (
          <Panel key={id} label={`Node ${id}`} busy>
            <div className="ph-node">
              <div className="ph-node__head">
                <Skeleton width={96} height={18} />
                <Skeleton width={76} height={22} radius={11} />
              </div>
              <div className="ph-node__stats">
                <StatSkeleton />
                <StatSkeleton />
                <StatSkeleton />
                <Skeleton width={72} height={72} radius={36} />
              </div>
              <Skeleton height={40} radius={8} />
            </div>
          </Panel>
        ))}
      </div>
      <div className="grid grid--4">
        {['Cluster compute', 'GPU power', 'Memory pressure', 'Active processes'].map((t) => (
          <Panel key={t} title={t} busy>
            <StatSkeleton wide />
          </Panel>
        ))}
      </div>
      <div className="grid grid--2-1">
        <Panel title="Interconnect" subtitle="ConnectX-7 rails between nodes" busy>
          <Skeleton height={84} radius={12} />
        </Panel>
        <Panel title="Recent events" busy>
          <RowsSkeleton rows={4} />
        </Panel>
      </div>
    </div>
  );
}
