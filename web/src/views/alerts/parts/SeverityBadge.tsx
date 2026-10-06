import { CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Event, Severity } from '../../../lib/types';
import '../../../design/components/StatusPill.css';

type Look = 'critical' | 'warning' | 'info' | 'recovered';
const META: Record<Look, { label: string; icon: LucideIcon; tone: 'ok' | 'warn' | 'crit' | 'stale' }> = {
  critical: { label: 'Critical', icon: OctagonAlert, tone: 'crit' },
  warning: { label: 'Warning', icon: TriangleAlert, tone: 'warn' },
  info: { label: 'Info', icon: Info, tone: 'stale' },
  recovered: { label: 'Recovered', icon: CircleCheck, tone: 'ok' },
};

export const lookOf = (e: Pick<Event, 'kind' | 'severity'>): Look => (e.kind === 'recovered' ? 'recovered' : e.severity);

/** Severity as icon + word + tone (reuses the StatusPill styles), never colour alone. */
export function SeverityBadge({ severity, kind = 'alert', variant = 'pill', size = 'sm' }: { severity: Severity; kind?: Event['kind']; variant?: 'pill' | 'inline'; size?: 'sm' | 'md' }) {
  const m = META[lookOf({ kind, severity })];
  const Icon = m.icon;
  return (
    <span className={`status status--${variant} status--${size} tone-${m.tone}`}>
      <Icon className="status__icon" aria-hidden="true" strokeWidth={2.25} />
      <span className="status__label">{m.label}</span>
    </span>
  );
}

export function SeverityIcon({ severity, kind = 'alert' }: { severity: Severity; kind?: Event['kind'] }) {
  const m = META[lookOf({ kind, severity })];
  const Icon = m.icon;
  return <Icon className={`ops-sev-icon tone-${m.tone}`} aria-hidden="true" strokeWidth={2.25} />;
}
