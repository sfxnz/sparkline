// The overview card of a node that has never answered: in the node's place in the grid, sized to what it says.
import { m } from 'motion/react';
import { Link } from 'wouter';
import { paths } from '../../app/routes';
import { Panel } from '../../design/components/Panel';
import { StatusPill } from '../../design/components/StatusPill';
import { springs } from '../../design/motion';
import { agentAddress } from '../../lib/onboarding';
import { useCluster } from '../../store/cluster';
import { NodeSetup } from '../shared/NodeSetup';

export function SetupCard({ id }: { id: string }) {
  const node = useCluster((s) => s.nodes[id]);
  if (!node) return null;
  return (
    <m.div layoutId={`node-card-${id}`} transition={springs.layout} className="ov-card ov-card--setup">
      <Panel
        className="ov-card__panel"
        material="thin"
        label={`Node ${id}, not connected yet`}
        title={
          <Link href={paths.node(id)} className="ov-card__title">
            <m.span layoutId={`node-title-${id}`} transition={springs.layout} className="ov-card__name">{id}</m.span>
            <span className="visually-hidden">, open node details</span>
          </Link>
        }
        subtitle={<span className="num">Tried {agentAddress(node.url)}</span>}
        actions={<StatusPill status="setup" />}
      >
        <NodeSetup node={node} />
      </Panel>
    </m.div>
  );
}
