import { CircleCheck, CircleDashed, CircleHelp, CircleSlash, CircleX, Clock, LoaderCircle, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { NodeStatus } from '../../lib/types';
import './StatusPill.css';

export type Status = 'healthy' | 'warning' | 'critical' | 'error' | 'stale' | 'offline' | 'connecting' | 'setup' | 'unknown';

const META: Record<Status, { label: string; icon: LucideIcon; tone: 'ok' | 'warn' | 'crit' | 'stale' | 'setup' }> = {
  healthy: { label: 'Healthy', icon: CircleCheck, tone: 'ok' },
  warning: { label: 'Warning', icon: TriangleAlert, tone: 'warn' },
  critical: { label: 'Critical', icon: OctagonAlert, tone: 'crit' },
  /** The console reaches the agent but cannot use it (token mismatch, protocol version, refused stream): a setup fault
   *  that needs a fix, not a hardware emergency, so it is not called "Critical". */
  error: { label: 'Error', icon: CircleX, tone: 'crit' },
  stale: { label: 'Not reporting', icon: Clock, tone: 'stale' },
  offline: { label: 'Offline', icon: CircleSlash, tone: 'stale' },
  connecting: { label: 'Connecting', icon: LoaderCircle, tone: 'stale' },
  /** A node this console has never heard from and cannot reach yet: a step in setting up, not an outage. */
  setup: { label: 'Not connected yet', icon: CircleDashed, tone: 'setup' },
  unknown: { label: 'Unknown', icon: CircleHelp, tone: 'stale' },
};

/**
 * Map a console NodeStatus to a display status. An open alert on the node raises 'online' to warning/critical, and
 * while the browser has lost the console (`consoleLive` false) the last NodeState is not current, so it shows 'stale'.
 * A node that has never answered this console (`isNew`, see lib/onboarding.ts) and cannot be reached is 'setup':
 * never Offline, Error or Critical, because it was never online. Every surface that names a node's status asks here.
 */
export const shownNodeStatus = (status: NodeStatus | undefined, consoleLive: boolean): NodeStatus | undefined => (status && !consoleLive ? 'stale' : status);

export function nodeDisplayStatus(status: NodeStatus | undefined, alert: 'warning' | 'critical' | null = null, consoleLive = true, isNew = false): Status {
  if (isNew && (status === 'offline' || status === 'error')) return 'setup';
  switch (shownNodeStatus(status, consoleLive)) {
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
