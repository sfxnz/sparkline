import { Clock, Unplug } from 'lucide-react';
import { useLocation, useParams } from 'wouter';
import { Panel } from '../design/components/Panel';
import { ProblemState } from '../design/components/ProblemState';
import { useNow } from '../design/useNow';
import { api } from '../lib/api';
import { formatAgo } from '../lib/format';
import { serverNow, useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { Tabs } from '../design/components/Tabs';
import { isNodeTab, NODE_TABS, paths, type NodeTab } from '../app/routes';
import { ChartPanelSkeleton, StatSkeleton } from './placeholders';
import './views.css';

export default function Node() {
  const params = useParams<{ id: string; tab?: string }>();
  const [, navigate] = useLocation();
  const id = decodeURIComponent(params.id);
  const tab: NodeTab = isNodeTab(params.tab) ? params.tab : 'summary';
  const tabLabel = NODE_TABS.find((t) => t.id === tab)?.label ?? 'Summary';

  return (
    <div className="view">
      <Tabs label={`${id} sections`} items={NODE_TABS} value={tab} onChange={(t) => { navigate(paths.node(id, t)); }}>
        <div className="view view--flush" aria-busy="true">
          <NodeNotice id={id} />
          <Panel label={`${tabLabel} summary`} busy>
            <div className="ph-statrow">
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
            </div>
          </Panel>
          <div className="grid grid--2">
            <ChartPanelSkeleton title={`${tabLabel} · utilisation`} />
            <ChartPanelSkeleton title={`${tabLabel} · detail`} />
          </div>
        </div>
      </Tabs>
    </div>
  );
}

/** Why this node has no live data (stale, offline or error), using the console's Problem copy. */
export function NodeNotice({ id }: { id: string }) {
  const node = useCluster((s) => s.nodes[id]);
  const consoleLive = useConnection((s) => s.status === 'live');
  useNow(1000);
  if (!node) return null;
  const now = serverNow();
  const last = node.last_sample_ts ? `Last sample ${formatAgo(node.last_sample_ts, now)}.` : 'No samples received yet.';
  if (!consoleLive) {
    return (
      <Panel label={`${id} status`}>
        <ProblemState compact icon={Clock} message={`No new data from ${id}`} cause={`Lost the connection to Sparkline. ${last} Values are not live.`} />
      </Panel>
    );
  }
  if (node.status === 'online' || node.status === 'connecting') return null;
  if (node.status === 'stale' || !node.error) {
    return (
      <Panel label={`${id} status`}>
        <ProblemState compact icon={Clock} message={`No new data from ${id}`} cause={`${last} Values are not live.`} />
      </Panel>
    );
  }
  const secs = node.next_retry_ts ? Math.max(0, Math.ceil(node.next_retry_ts - now)) : null;
  return (
    <Panel label={`${id} status`}>
      <ProblemState
        compact
        icon={Unplug}
        message={node.error.message}
        cause={node.error.cause}
        fix={node.error.fix}
        onRetry={() => { void api.retryNode(id).catch(() => undefined); }}
        retryLabel="Retry now"
        footnote={`${last}${secs === null ? '' : secs > 0 ? ` Retrying automatically in ${secs} s.` : ' Retrying…'}`}
      />
    </Panel>
  );
}
