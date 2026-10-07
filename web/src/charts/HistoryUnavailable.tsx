import { Radio, Unplug } from 'lucide-react';
import { Button } from '../design/components/Button';
import { EmptyState } from '../design/components/EmptyState';
import { ProblemState } from '../design/components/ProblemState';
import { problemOf } from '../lib/api';
import { useCluster } from '../store/cluster';
import { usePrefs } from '../store/prefs';

/**
 * A history range the console could not load. When the node's agent is unreachable (offline or error) every chart
 * of the page would fail the same way, so this says so in one plain line and offers Live; the node banner carries
 * the cause and fix. Otherwise it shows the console's Problem (message, cause, fix), never the raw response body.
 */
export function HistoryUnavailable({ node, error, onRetry, offerLive = true }: { node: string; error: unknown; onRetry: () => void; offerLive?: boolean }) {
  const status = useCluster((s) => s.nodes[node]?.status);
  const range = usePrefs((s) => s.timeRange);
  const set = usePrefs((s) => s.set);
  if (status === 'offline' || status === 'error') {
    const showLive = offerLive && range !== 'live';
    return (
      <EmptyState
        icon={Unplug}
        title={`${node} is unreachable`}
        compact
        action={showLive ? <Button size="sm" variant="secondary" icon={<Radio />} onClick={() => { set({ timeRange: 'live' }); }}>Show live</Button> : undefined}
      >
        History is stored on {node}&apos;s agent, which the console cannot reach right now.
      </EmptyState>
    );
  }
  const p = problemOf(error, 'load history for this range');
  return <ProblemState compact message={p.message} cause={p.cause || undefined} fix={p.fix || undefined} onRetry={onRetry} />;
}
