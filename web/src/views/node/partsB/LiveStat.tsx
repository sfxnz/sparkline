// A Stat bound to last known values of flattened metric keys. Only this leaf re-renders when its value changes, and
// it keeps showing the last value (dimmed, "updated X ago") when the node or the collector stops reporting.
import type { ReactNode } from 'react';
import { Stat } from '../../../design/components/Stat';
import type { Formatter } from '../../../lib/format';
import { liveStore } from '../../../store/live';
import { useNodeStale } from '../../shared/live';
import { useDerived, type KeyGetter } from './hooks';

interface Props {
  node: string;
  label: string;
  format: Formatter;
  /** One flattened key ("cpu.util")… */
  metric?: string;
  /** …or a value derived from several. */
  derive?: (get: KeyGetter) => number | null;
  /** Force the dimmed "updated X ago" state (e.g. this collector is failing while the node is fine). */
  stale?: boolean;
  /** When the value went stale, if not at the node's last sample. */
  updatedAt?: number | null;
  unsupported?: string | null;
  size?: 'md' | 'lg';
  footer?: ReactNode;
}

export function LiveStat({ node, label, format, metric, derive, stale, updatedAt, unsupported, size, footer }: Props) {
  const value = useDerived(node, derive ?? ((get) => (metric ? get(metric) : null)));
  const nodeStale = useNodeStale(node);
  const isStale = !unsupported && (nodeStale || !!stale);
  // Read, not subscribed: while stale no samples arrive, and subscribing would re-render this leaf every tick.
  const lastTs = isStale ? liveStore.lastTs(node) : null;
  return (
    <Stat
      label={label}
      value={value}
      format={format}
      size={size}
      stale={isStale}
      updatedAt={isStale ? (updatedAt ?? lastTs) : null}
      unsupported={unsupported ?? undefined}
      footer={footer}
    />
  );
}
