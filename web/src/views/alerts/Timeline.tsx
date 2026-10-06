import { ArrowDownRight, ArrowUpRight, Bell, Check, FilterX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { paths } from '../../app/routes';
import { Button } from '../../design/components/Button';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { SegmentedControl, type Segment } from '../../design/components/SegmentedControl';
import { prefersReducedMotion } from '../../design/motion';
import { formatClock, formatDuration } from '../../lib/format';
import type { Event } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useEvents } from '../../store/events';
import { RowsSkeleton } from '../placeholders';
import { filterEvents, groupByDay, isFiltered, KIND_LABEL, linkRecoveries, NO_FILTERS, type Filters, type KindFilter, type Links, type SeverityFilter } from './model';
import { ProblemBanner } from './parts/Banner';
import { ClockTime, RelTime } from './parts/RelTime';
import { Select } from './parts/Select';
import { SeverityIcon, lookOf } from './parts/SeverityBadge';
import { useTick } from './parts/tick';
import type { LoadState } from './useEventHistory';

const PAGE = 25;

const SEVERITIES: readonly Segment<SeverityFilter>[] = [
  { value: 'all', label: 'All', ariaLabel: 'All severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];
const KINDS: KindFilter[] = ['all', 'alert', 'recovered', 'node', 'bench', 'system'];
const LOOK_LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info', recovered: 'Recovered' } as const;

interface Props {
  load: LoadState;
  onRetry: () => void;
}

export function Timeline({ load, onRetry }: Props) {
  const events = useEvents((s) => s.events);
  const order = useCluster((s) => s.order);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [limit, setLimit] = useState(PAGE);
  const [target, setTarget] = useState<number | null>(null);
  const now = useTick(60_000) / 1000; // day labels ("Today") roll over at midnight

  const links = useMemo(() => linkRecoveries(events), [events]);
  const matching = useMemo(() => filterEvents(events, filters), [events, filters]);
  const shown = matching.slice(0, limit);
  const groups = useMemo(() => groupByDay(shown, now), [shown, now]);
  const nodes = useMemo(() => {
    const ids = new Set(order);
    for (const e of events) if (e.node_id) ids.add(e.node_id);
    return [...ids];
  }, [order, events]);

  // The count is announced only in response to a filter change, never as events stream in (the app already
  // announces alerts, and a count on every new event would talk over them).
  const [announced, setAnnounced] = useState('');
  const set = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    setLimit(PAGE);
    const n = filterEvents(events, next).length;
    setAnnounced(isFiltered(next) ? `${n} of ${events.length} events` : `${events.length} events`);
  };

  /** Bring a linked event into view: drop filters / page further if it is hidden, then scroll and focus it. */
  const jumpTo = (id: number) => {
    let idx = matching.findIndex((e) => e.id === id);
    if (idx < 0) {
      setFilters(NO_FILTERS);
      idx = events.findIndex((e) => e.id === id);
    }
    if (idx >= limit) setLimit(Math.ceil((idx + 1) / PAGE) * PAGE);
    setTarget(id);
  };

  useEffect(() => {
    if (target === null) return;
    const el = document.getElementById(`event-${target}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
    el.dataset.highlight = 'true';
    const t = setTimeout(() => {
      delete el.dataset.highlight;
      setTarget(null);
    }, 1800);
    return () => { clearTimeout(t); };
  }, [target, groups]);

  const loading = load.status === 'loading' && events.length === 0;
  const filtered = isFiltered(filters);
  const countText = loading ? '' : filtered ? `${matching.length} of ${events.length} events` : `${events.length} ${events.length === 1 ? 'event' : 'events'}`;

  return (
    <Panel title="Timeline" subtitle="Alerts, recoveries and node events, newest first" busy={loading}>
      <div className="tl">
        <div className="tl-filters" role="group" aria-label="Filter events">
          <Select size="sm" aria-label="Node" value={filters.node} onChange={(e) => { set({ node: e.target.value }); }}>
            <option value="all">All nodes</option>
            {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <SegmentedControl size="sm" label="Severity" options={SEVERITIES} value={filters.severity} onChange={(v) => { set({ severity: v }); }} />
          <Select size="sm" aria-label="Kind" value={filters.kind} onChange={(e) => { set({ kind: e.target.value as KindFilter }); }}>
            {KINDS.map((k) => <option key={k} value={k}>{k === 'all' ? 'All kinds' : KIND_LABEL[k]}</option>)}
          </Select>
          <span className="tl-filters__count t-footnote t-secondary">{countText}</span>
          <span className="visually-hidden" role="status">{announced}</span>
          {filtered ? (
            <Button size="sm" variant="ghost" icon={<FilterX />} onClick={() => { set(NO_FILTERS); }}>
              Clear filters
            </Button>
          ) : null}
        </div>

        {load.status === 'error' ? <ProblemBanner problem={load.problem} action={<Button size="sm" onClick={onRetry}>Retry</Button>} /> : null}

        {loading ? (
          <RowsSkeleton rows={8} />
        ) : events.length === 0 ? (
          <EmptyState icon={Bell} title="No events yet" compact>
            Alerts, recoveries and node status changes appear here as they happen. Events are kept for 30 days.
          </EmptyState>
        ) : matching.length === 0 ? (
          <EmptyState icon={FilterX} title="No events match these filters" compact action={<Button size="sm" onClick={() => { set(NO_FILTERS); }}>Clear filters</Button>}>
            Try another node, severity or kind.
          </EmptyState>
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.key} className="tl-day" aria-labelledby={`day-${g.key}`}>
                <h3 id={`day-${g.key}`} className="tl-day__label t-eyebrow">{g.label}</h3>
                <ol className="tl-list">
                  {g.events.map((e) => <TimelineRow key={e.id} e={e} links={links} onJump={jumpTo} />)}
                </ol>
              </section>
            ))}
            {matching.length > limit ? (
              <div className="tl-more">
                <Button size="sm" variant="secondary" onClick={() => { setLimit((l) => l + PAGE); }}>
                  Show {Math.min(PAGE, matching.length - limit)} older
                </Button>
                <span className="t-footnote t-tertiary">{matching.length - limit} more</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

function TimelineRow({ e, links, onJump }: { e: Event; links: Links; onJump: (id: number) => void }) {
  const look = lookOf(e);
  const recovery = links.recoveryOf.get(e.id);
  const alert = links.alertOf.get(e.id);
  const open = e.kind === 'alert' && e.resolved_ts == null;
  return (
    <li id={`event-${e.id}`} className={`tl-row tl-row--${look}`} tabIndex={-1}>
      <div className="tl-row__time">
        <ClockTime ts={e.ts} className="tl-row__clock" />
        <RelTime ts={e.ts} className="tl-row__ago" />
      </div>
      <div className="tl-row__rail" aria-hidden="true">
        <SeverityIcon severity={e.severity} kind={e.kind} />
      </div>
      <div className="tl-row__main">
        <p className="tl-row__title">
          <span className="visually-hidden">{LOOK_LABEL[look]}: </span>
          {e.title}
        </p>
        <p className="tl-row__detail">{e.detail}</p>
        <div className="tl-row__meta">
          <span className={`tl-tag tone-${look === 'critical' ? 'crit' : look === 'warning' ? 'warn' : look === 'recovered' ? 'ok' : 'stale'}`} aria-hidden="true">
            {LOOK_LABEL[look]}
          </span>
          {open ? <span className="tl-tag tl-tag--open">{e.acked ? 'Open · acknowledged' : 'Open'}</span> : null}
          {e.kind === 'alert' && e.acked && !open ? (
            <span className="tl-meta-text">
              <Check aria-hidden="true" /> Acknowledged
            </span>
          ) : null}
          {recovery ? (
            <button type="button" className="tl-link" onClick={() => { onJump(recovery.id); }}>
              Cleared after {formatDuration(recovery.ts - e.ts)} at {formatClock(recovery.ts)}
              <ArrowUpRight aria-hidden="true" />
            </button>
          ) : e.kind === 'alert' && e.resolved_ts != null ? (
            <span className="tl-meta-text">Cleared after {formatDuration(e.resolved_ts - e.ts)}</span>
          ) : null}
          {alert ? (
            <button type="button" className="tl-link" onClick={() => { onJump(alert.id); }}>
              Alert raised at {formatClock(alert.ts)}
              <ArrowDownRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="tl-row__node">
        {e.node_id ? <Link href={paths.node(e.node_id)} className="node-chip">{e.node_id}</Link> : <span className="t-footnote t-tertiary">Cluster</span>}
      </div>
    </li>
  );
}

