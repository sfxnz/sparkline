// Overview ('/'): is my cluster healthy and what is it doing?
// Hero sentence -> living node cards -> cluster totals -> interconnect + recent events -> GPU activity over time.
import { ServerOff } from 'lucide-react';
import { useMemo } from 'react';
import { EmptyState } from '../design/components/EmptyState';
import { useCluster } from '../store/cluster';
import { ClusterChart, ClusterChartSkeleton } from './overview/ClusterChart';
import { Hero, HeroSkeleton } from './overview/Hero';
import { InterconnectPanel, InterconnectSkeleton } from './overview/InterconnectPanel';
import { interconnectLinks } from './overview/model';
import { NodeCard, NodeCardSkeleton } from './overview/NodeCard';
import { RecentEvents, RecentEventsSkeleton } from './overview/RecentEvents';
import { Totals, TotalsSkeleton } from './overview/Totals';
import './views.css';
import './overview/overview.css';

/** Before the console's first hello, DISCOVERY's two nodes are the best guess for the skeleton. */
const SKELETON_NODES = 2;

export default function Overview() {
  const ready = useCluster((s) => s.cluster !== null);
  const order = useCluster((s) => s.order);
  const nodes = useCluster((s) => s.nodes);

  const infoKey = order.map((id) => `${id}:${nodes[id]?.info?.node_id ?? ''}`).join('|');
  const links = useMemo(
    () => interconnectLinks(order, Object.fromEntries(order.map((id) => [id, nodes[id]?.info]))),
    // Links change only when node membership or NodeInfo arrives, not on every status update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [infoKey],
  );

  if (!ready) return <OverviewSkeleton />;
  if (!order.length) return <NoNodes />;

  return (
    <div className="view ov">
      <Hero />
      <div className="ov-cards">
        {order.map((id) => (
          <NodeCard key={id} id={id} />
        ))}
      </div>
      <Totals />
      <div className={`ov-pair${links.length ? '' : ' ov-pair--single'}`}>
        {links.length ? <InterconnectPanel links={links} /> : null}
        <RecentEvents />
      </div>
      <ClusterChart nodes={order} />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="view ov" aria-busy="true">
      <HeroSkeleton />
      <div className="ov-cards">
        {Array.from({ length: SKELETON_NODES }, (_, i) => (
          <NodeCardSkeleton key={i} />
        ))}
      </div>
      <TotalsSkeleton />
      <div className="ov-pair">
        <InterconnectSkeleton />
        <RecentEventsSkeleton />
      </div>
      <ClusterChartSkeleton rows={SKELETON_NODES} />
    </div>
  );
}

function NoNodes() {
  return (
    <div className="view ov">
      <div className="ov-empty material-regular">
        <EmptyState icon={ServerOff} title="No nodes configured">
          <p>
            Sparkline is running, but it isn’t watching any DGX Spark yet. Add one <code>[[nodes]]</code> entry per node to
            <code>console.toml</code>, then restart <code>sparkline</code>.
          </p>
          <pre className="ov-empty__code">
            <code>{`[[nodes]]
id = "spark1"
url = "http://10.20.20.48:9750"

[[nodes]]
id = "spark2"
url = "http://10.20.20.195:9750"`}</code>
          </pre>
          <p>Each node runs <code>sparkline-agent</code> on port 9750 with the shared agent token.</p>
        </EmptyState>
      </div>
    </div>
  );
}
