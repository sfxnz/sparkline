// "Last updated 12 s ago" for a panel whose values are not live (node stale/offline, or a collector failing).
import { Clock } from 'lucide-react';
import { useNow } from '../../../design/useNow';
import { formatAgo } from '../../../lib/format';
import { useCluster } from '../../../store/cluster';
import { liveStore } from '../../../store/live';

export function StaleSince({ node, ts, label = 'Last updated' }: { node: string; ts?: number | null; label?: string }) {
  const now = useNow(1000) / 1000 + useCluster.getState().clockOffset;
  const last = ts ?? liveStore.lastTs(node);
  return (
    <span className="nb-stale num">
      <Clock aria-hidden="true" />
      {last ? `${label} ${formatAgo(last, now)}` : 'No recent data'}
    </span>
  );
}
