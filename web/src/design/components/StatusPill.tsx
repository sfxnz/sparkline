import { CircleCheck, CircleHelp, CircleSlash, CircleX, Clock, LoaderCircle, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { NodeStatus } from '../../lib/types';
import './StatusPill.css';

export type Status = 'healthy' | 'warning' | 'critical' | 'error' | 'stale' | 'offline' | 'connecting' | 'unknown';

const META: Record<Status, { label: string; icon: LucideIcon; tone: 'ok' | 'warn' | 'crit' | 'stale' }> = {
  healthy: { label: 'Healthy', icon: CircleCheck, tone: 'ok' },
  warning: { label: 'Warning', icon: TriangleAlert, tone: 'warn' },
  critical: { label: 'Critical', icon: OctagonAlert, tone: 'crit' },
  /** The console reaches the agent but cannot use it (token mismatch, protocol version, refused stream): a setup fault
   *  that needs a fix, not a hardware emergency, so it is not called "Critical". */
  error: { label: 'Error', icon: CircleX, tone: 'crit' },
  stale: { label: 'Not reporting', icon: Clock, tone: 'stale' },
  offline: { label: 'Offline', icon: CircleSlash, tone: 'stale' },
  connecting: { label: 'Connecting', icon: LoaderCircle, tone: 'stale' },
  unknown: { label: 'Unknown', icon: CircleHelp, tone: 'stale' },
};

/**
 * Map a console NodeStatus to a display status. An open alert on the node raises 'online' to warning/critical, and
 * while the browser has lost the console (`consoleLive` false) the last NodeState is not current, so it shows 'stale'.
 */
export function nodeDisplayStatus(status: NodeStatus | undefined, alert: 'warning' | 'critical' | null = null, consoleLive = true): Status {
  if (status && !consoleLive) return 'stale';
  switch (status) {
    case 'online':
      return alert ?? 'healthy';
    case 'stale':
      return 'stale';
    case 'offline':
      return 'offline';
    case 'error':
      return 'error';
    case 'connecting':
      return 'connecting';
    default:
      return 'unknown';
  }
}

interface Props {
  status: Status;
  /** Override the default label ("Healthy"), e.g. "Offline for 2 min". */
  label?: string;
  /** 'pill' = tinted capsule; 'inline' = icon + text without a capsule (lists, sidebar). */
  variant?: 'pill' | 'inline';
  size?: 'sm' | 'md';
}

/** Status is always icon + text + colour, never colour alone. */
export function StatusPill({ status, label, variant = 'pill', size = 'md' }: Props) {
  const m = META[status];
  const Icon = m.icon;
  return (
    <span className={`status status--${variant} status--${size} tone-${m.tone}`} data-status={status}>
      <Icon className={`status__icon${status === 'connecting' ? ' status__icon--spin' : ''}`} aria-hidden="true" strokeWidth={2.25} />
      <span className="status__label">{label ?? m.label}</span>
    </span>
  );
}
