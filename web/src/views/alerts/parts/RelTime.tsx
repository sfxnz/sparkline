import { formatAgo, formatClock } from '../../../lib/format';
import { serverNow } from '../../../store/cluster';
import { useTick } from './tick';

const fullDate = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** "4 min ago" in a <time> carrying the absolute timestamp; ticks on a shared timer. */
export function RelTime({ ts, className }: { ts: number; className?: string }) {
  useTick(10_000);
  return (
    <time dateTime={new Date(ts * 1000).toISOString()} title={fullDate(ts)} className={className}>
      {formatAgo(ts, serverNow())}
    </time>
  );
}

/** Absolute wall-clock time ("14:32:05") with the full date as its title. */
export function ClockTime({ ts, className }: { ts: number; className?: string }) {
  return (
    <time dateTime={new Date(ts * 1000).toISOString()} title={fullDate(ts)} className={className}>
      {formatClock(ts)}
    </time>
  );
}
