// Overview ('/'): is my cluster healthy and what is it doing?
// Hero sentence -> living node cards -> cluster totals + interconnect -> recent events -> GPU activity over time.
import { Activity, ServerOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '../design/components/EmptyState';
import { isNewNode, needsSetup } from '../lib/onboarding';
import { useCluster } from '../store/cluster';
import { Guide } from './guide/Guide';
import { ClusterChart, ClusterChartSkeleton } from './overview/ClusterChart';
import { Hero, HeroSkeleton } from './overview/Hero';
import { InterconnectPanel, InterconnectSkeleton } from './overview/InterconnectPanel';
import { interconnectLinks } from './overview/model';
import { NodeCard, NodeCardSkeleton } from './overview/NodeCard';
import { RecentEvents, RecentEventsSkeleton } from './overview/RecentEvents';
import { SetupCard } from './overview/SetupCard';
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

  // Nodes that had never answered at some point while this page was open: their first reading is an arrival.
  const fresh = order.filter((id) => isNewNode(nodes[id]));
  const [arriving, setArriving] = useState<ReadonlySet<string>>(() => new Set(fresh));
  if (fresh.some((id) => !arriving.has(id))) setArriving(new Set([...arriving, ...fresh]));

  if (!ready) return <OverviewSkeleton />;
  if (!order.length) return <NoNodes />;

  // No node has ever reported: totals, events and charts would be a page of dashes. One quiet line instead.
  const nothingYet = fresh.length === order.length;
  return (
    <div className="view ov">
      <Hero />
      <div className="ov-cards">
        {order.map((id) => (needsSetup(nodes[id]) ? <SetupCard key={id} id={id} /> : <NodeCard key={id} id={id} arriving={arriving.has(id)} />))}
      </div>
      <Guide />
      {nothingYet ? (
        <NothingYet nodes={order} />
      ) : (
        <>
          <div className={`ov-pair${links.length ? '' : ' ov-pair--single'}`}>
            <Totals />
            {links.length ? <InterconnectPanel links={links} /> : null}
          </div>
          <RecentEvents />
          <ClusterChart nodes={order} />
        </>
      )}
    </div>
  );
}

function NothingYet({ nodes }: { nodes: readonly string[] }) {
  return (
    <div className="ov-quiet">
      <EmptyState icon={Activity} title="Totals, events and charts start with the first reading" compact>
        Nothing is missing from this page. It fills in by itself the moment {nodes.length === 1 ? nodes[0] : 'a node'} answers.
      </EmptyState>
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
      <div className="ov-pair">
        <TotalsSkeleton />
        <InterconnectSkeleton />
      </div>
      <RecentEventsSkeleton />
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
url = "http://192.168.1.11:9750"

[[nodes]]
id = "spark2"
url = "http://192.168.1.12:9750"`}</code>
          </pre>
          <p>Each node runs <code>sparkline-agent</code> on port 9750 with the shared agent token.</p>
        </EmptyState>
      </div>
    </div>
  );
}
