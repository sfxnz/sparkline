// The five most recent events, each with severity icon + label, and a way into the full timeline.
import { BellOff, ChevronRight, CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'wouter';
import { paths } from '../../app/routes';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { useNow } from '../../design/useNow';
import { formatAgo, formatClock, formatDuration } from '../../lib/format';
import type { Event } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useEvents } from '../../store/events';
import { RowsSkeleton } from '../placeholders';
import { recentIncidents } from './model';

const COUNT = 5;

function severityMeta(e: Event, resolved: boolean): { label: string; icon: LucideIcon; tone: string } {
  // Resolved incidents are neutral: green would read as a status, and their old severity is in the detail.
  if (resolved || e.kind === 'recovered') return { label: 'Resolved', icon: CircleCheck, tone: 'ov-tone-info' };
  if (e.severity === 'critical') return { label: 'Critical', icon: OctagonAlert, tone: 'tone-crit' };
  if (e.severity === 'warning') return { label: 'Warning', icon: TriangleAlert, tone: 'tone-warn' };
  return { label: 'Info', icon: Info, tone: 'ov-tone-info' };
}

const viewAll = (
  <Link href={paths.alerts} className="btn btn--ghost btn--sm ov-events__all">
    View all
    <ChevronRight aria-hidden="true" />
  </Link>
);

export function RecentEvents() {
  const all = useEvents((s) => s.events);
  const incidents = useMemo(() => recentIncidents(all, COUNT), [all]);
  const now = useNow(15_000) / 1000 + useCluster.getState().clockOffset;
  return (
    <Panel title="Recent events" actions={viewAll} className="ov-events">
      {incidents.length ? (
        <ol className="ov-events__list">
          {incidents.map(({ event: e, recovery, at }) => {
            const resolved = e.kind === 'alert' && e.resolved_ts != null;
            const m = severityMeta(e, resolved);
            const Icon = m.icon;
            const open = e.kind === 'alert' && !resolved;
            return (
              <li key={e.id} className={`ov-event${resolved ? ' ov-event--resolved' : ''}`}>
                <span className={`ov-event__sev ${m.tone}`}>
                  <Icon aria-hidden="true" strokeWidth={2.25} />
                  <span>{m.label}</span>
                </span>
                <span className="ov-event__body">
                  <span className="ov-event__title" title={e.title}>{e.title}</span>
                  <span className="ov-event__detail">
                    {open ? <span className="ov-event__open">Open · </span> : null}
                    {resolved && e.resolved_ts != null
                      ? `Was ${e.severity} · lasted ${formatDuration(e.resolved_ts - e.ts)}${recovery ? ` · ${recovery.detail.split(' · ')[0] ?? ''}` : ''}`
                      : e.detail}
                  </span>
                </span>
                <time className="ov-event__time" dateTime={new Date(at * 1000).toISOString()} title={formatClock(at)}>
                  {formatAgo(at, now)}
                </time>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState
          icon={BellOff}
          title="No alerts. Everything’s quiet."
          compact
          action={<Link href={paths.alerts} className="btn btn--secondary btn--sm">Review alert rules</Link>}
        >
          Threshold breaches, node outages and recoveries will appear here.
        </EmptyState>
      )}
    </Panel>
  );
}

export function RecentEventsSkeleton() {
  return (
    <Panel title="Recent events" actions={viewAll} className="ov-events" busy>
      <RowsSkeleton rows={COUNT} />
    </Panel>
  );
}
