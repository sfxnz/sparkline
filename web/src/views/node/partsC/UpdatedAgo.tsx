import { Clock } from 'lucide-react';
import { useNow } from '../../../design/useNow';
import { formatAgo } from '../../../lib/format';
import { useCluster } from '../../../store/cluster';

/** "Updated 12 s ago" that ticks once a second on its own, so the surrounding panel never re-renders for it. */
export function UpdatedAgo({ ts, stale, suffix }: { ts: number | null; stale?: boolean; suffix?: string }) {
  const now = useNow(1000) / 1000 + useCluster.getState().clockOffset;
  return (
    <span className={`tp-updated num${stale ? ' tp-updated--stale' : ''}`}>
      {stale ? <Clock aria-hidden="true" /> : null}
      <span>
        {ts ? `Updated ${formatAgo(ts, now)}` : 'No data yet'}
        {suffix && !stale ? <span className="tp-updated__suffix"> · {suffix}</span> : null}
        {stale ? <span className="tp-updated__suffix"> · not live</span> : null}
      </span>
    </span>
  );
}
