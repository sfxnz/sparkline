import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Skeleton } from '../../../design/components/Skeleton';
import { Stat } from '../../../design/components/Stat';
import type { Formatter } from '../../../lib/format';
import type { Sample } from '../../../lib/types';
import { liveStore, useLatest } from '../../../store/live';
import { lastKnownValue } from '../../shared/live';
import { useBufferTs, useFreshness } from './hooks';

interface Props {
  nodeId: string;
  label: string;
  /** Must be a stable function (module scope or memoised): it is the subscription's identity. */
  select: (s: Sample | null) => number | null;
  format: Formatter;
  /** Flattened metric key(s) (summed) to fall back on when no full sample has arrived since the page loaded
   *  but the ring buffer holds recent history, e.g. opening an offline node: its last known value, dimmed. */
  metric?: string | readonly string[];
  unsupported?: string | null;
  unsupportedLabel?: string;
  /** Makes the whole stat a link to the tab with the detail. */
  href?: string;
  /** Secondary line under the value; receives the current value. */
  footer?: (value: number | null) => ReactNode;
  size?: 'md' | 'lg';
}

/** A Stat bound to one value of the node's latest sample: only this leaf re-renders when that value changes.
 *  Skeleton until the first sample; when the node goes quiet it keeps the last value, dimmed, with its age. */
export function LiveStat({ nodeId, label, select, format, metric, unsupported, unsupportedLabel, href, footer, size }: Props) {
  const live = useLatest(nodeId, select);
  const { stale, waiting } = useFreshness(nodeId);
  const fallback = live === null && stale && metric !== undefined;
  useBufferTs(nodeId, fallback);
  const value = live ?? (fallback ? lastKnownValue(nodeId, metric) : null);

  if (waiting && !unsupported) {
    return (
      <div className={`stat stat--${size ?? 'md'} nstat--loading`}>
        <div className="stat__label">{label}</div>
        <Skeleton width={size === 'lg' ? 112 : 84} height={size === 'lg' ? 30 : 24} radius={8} />
        <Skeleton width={96} height={10} />
      </div>
    );
  }

  const stat = (
    <Stat
      label={label}
      value={value}
      format={format}
      stale={stale}
      updatedAt={stale ? liveStore.lastTs(nodeId) : null}
      unsupported={unsupported ?? undefined}
      unsupportedLabel={unsupportedLabel}
      footer={footer?.(value)}
      size={size}
    />
  );
  if (!href || unsupported) return stat;
  return (
    <Link href={href} className="nstat-link">
      {stat}
      <ChevronRight className="nstat-link__chevron" aria-hidden="true" />
    </Link>
  );
}
