import { Clock, RotateCw, ServerOff, Unplug } from 'lucide-react';
import { m } from 'motion/react';
import { Suspense } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { isNodeTab, NODE_TABS, paths, type NodeTab } from '../app/routes';
import { EmptyState } from '../design/components/EmptyState';
import { ErrorBoundary } from '../design/components/ErrorBoundary';
import { Panel } from '../design/components/Panel';
import { Button } from '../design/components/Button';
import { InlineCode } from '../design/components/InlineCode';
import { Skeleton } from '../design/components/Skeleton';
import { StatusPill } from '../design/components/StatusPill';
import { Tabs } from '../design/components/Tabs';
import { springs } from '../design/motion';
import { useNow } from '../design/useNow';
import { api } from '../lib/api';
import { formatAgo, formatDuration } from '../lib/format';
import type { NodeState } from '../lib/types';
import { serverNow, useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { useNodeDisplayStatus } from '../store/attention';
import { TAB_COMPONENTS } from './node/tabs';
import { SummarySkeleton } from './node/parts/SummarySkeleton';
import { ChartPanelSkeleton, StatSkeleton } from './placeholders';
import './node/parts/node.css';
import './views.css';

export default function Node() {
  const params = useParams<{ id: string; tab?: string }>();
  const [, navigate] = useLocation();
  const id = decodeURIComponent(params.id);
  const tab: NodeTab = isNodeTab(params.tab) ? params.tab : 'summary';
  const tabLabel = NODE_TABS.find((t) => t.id === tab)?.label ?? 'Summary';
  const known = useCluster((s) => s.cluster !== null);
  const exists = useCluster((s) => id in s.nodes);

  if (known && !exists) return <NodeNotFound id={id} />;

  const TabComponent = TAB_COMPONENTS[tab];
  return (
    <div className="view node">
      <NodeHeader id={id} />
      <NodeNotice id={id} />
      <Tabs label={`${id} sections`} items={NODE_TABS} value={tab} onChange={(t) => { navigate(paths.node(id, t)); }}>
        {exists ? (
          <Suspense fallback={<TabSkeleton label={tabLabel} tab={tab} />}>
            <ErrorBoundary what={`The ${tabLabel} tab`} resetKey={`${id}/${tab}`}>
              <TabComponent nodeId={id} />
            </ErrorBoundary>
          </Suspense>
        ) : (
          <TabSkeleton label={tabLabel} tab={tab} />
        )}
      </Tabs>
    </div>
  );
}

function TabSkeleton({ label, tab }: { label: string; tab: NodeTab }) {
  if (tab === 'summary') return <SummarySkeleton />;
  return (
    <div className="view" aria-busy="true">
      <Panel label={`${label} summary`} busy>
        <div className="ph-statrow">
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
        </div>
      </Panel>
      <div className="grid grid--2">
        <ChartPanelSkeleton title={`${label} · loading`} />
        <ChartPanelSkeleton title={`${label} · loading`} />
      </div>
    </div>
  );
}

/** Agent host from the node URL ("http://10.20.20.48:9750" -> "10.20.20.48"). */
function agentHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function metaItems(node: NodeState, now: number): string[] {
  const info = node.info;
  if (!info) return [];
  const host = agentHost(node.url);
  return [
    info.hostname !== node.node_id ? info.hostname : null,
    host,
    info.gpus[0]?.name ?? null,
    info.driver ? `Driver ${info.driver}` : null,
    info.cuda ? `CUDA ${info.cuda}` : null,
    `Agent ${info.agent_version}`,
    info.boot_time ? `Up ${formatDuration(now - info.boot_time)}` : null,
  ].filter((x): x is string => !!x);
}

/** Node name, status and identity. Shares layout ids with the overview card for a continuous transition. */
function NodeHeader({ id }: { id: string }) {
  const node = useCluster((s) => s.nodes[id]);
  useNow(60_000); // uptime
  const status = useNodeDisplayStatus(id);
  const items = node ? metaItems(node, serverNow()) : [];

  return (
    // The frame morphs from the card; its children carry `layout` so Motion counter-scales them (text and pill keep
    // their shape during the flight instead of stretching with the frame).
    <m.header layoutId={`node-card-${id}`} transition={springs.layout} className="nhead material-regular">
      <div className="nhead__row">
        <m.h2 layoutId={`node-title-${id}`} transition={springs.layout} className="nhead__name t-title1">
          {id}
        </m.h2>
        <m.span layout="position" transition={springs.layout} className="nhead__pill">
          {node ? <StatusPill status={status} /> : <Skeleton width={84} height={24} radius={12} />}
        </m.span>
      </div>
      {items.length ? (
        <m.ul layout="position" transition={springs.layout} className="nhead__meta" aria-label={`${id} details`}>
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </m.ul>
      ) : (
        <m.div layout="position" transition={springs.layout} className="nhead__meta" aria-hidden="true">
          <Skeleton width={360} height={12} />
        </m.div>
      )}
    </m.header>
  );
}

function NodeNotFound({ id }: { id: string }) {
  const order = useCluster((s) => s.order);
  return (
    <Panel label="Node not found">
      <EmptyState
        icon={ServerOff}
        title={`There is no node called “${id}”`}
        action={
          <Link href={paths.overview} className="btn btn--secondary btn--md">
            Go to Overview
          </Link>
        }
      >
        {order.length ? (
          <>
            This console knows{' '}
            {order.map((n, i) => (
              <span key={n}>
                {i > 0 ? (i === order.length - 1 ? ' and ' : ', ') : null}
                <Link href={paths.node(n)}>{n}</Link>
              </span>
            ))}
            . Nodes are listed in the console configuration (<code>[[nodes]]</code> in console.toml).
          </>
        ) : (
          <>No nodes are configured. Add them under <code>[[nodes]]</code> in console.toml.</>
        )}
      </EmptyState>
    </Panel>
  );
}

/**
 * Why this node has no live data (stale, offline or error): one compact banner under the page identity, using the
 * console's Problem copy (cause, fix and Retry inline). It also labels every value below, once, as last known.
 */
export function NodeNotice({ id }: { id: string }) {
  const node = useCluster((s) => s.nodes[id]);
  const consoleLive = useConnection((s) => s.status === 'live');
  useNow(1000);
  if (!node) return null;
  if (consoleLive && (node.status === 'online' || node.status === 'connecting')) return null;
  const now = serverNow();
  const age = node.last_sample_ts ? `Last known values · ${formatAgo(node.last_sample_ts, now)}` : 'No samples received yet';
  const down = consoleLive && node.status !== 'stale' && node.error;
  const Icon = down ? Unplug : Clock;
  const message = !consoleLive ? 'Not live: the connection to Sparkline was lost' : down ? node.error?.message : `${id} is not reporting`;
  const secs = node.next_retry_ts ? Math.max(0, Math.ceil(node.next_retry_ts - now)) : null;
  return (
    <section className={`nbanner ${down ? 'tone-warn' : 'tone-stale'}`} aria-label={`${id} status`}>
      <Icon className="nbanner__icon" aria-hidden="true" />
      <div className="nbanner__body">
        <p className="nbanner__line">
          <strong>{message}</strong>
          {down && node.error?.cause ? <span className="nbanner__cause"><InlineCode text={node.error.cause} /></span> : null}
        </p>
        <p className="nbanner__meta num">
          {down && node.error?.fix ? <span className="nbanner__fix"><InlineCode text={node.error.fix} /> · </span> : null}
          {age}
          {down && secs !== null ? (secs > 0 ? ` · retrying in ${secs}\u00a0s` : ' · retrying…') : ''}
        </p>
      </div>
      {down ? (
        <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={() => { void api.retryNode(id).catch(() => undefined); }}>
          Retry now
        </Button>
      ) : null}
    </section>
  );
}
