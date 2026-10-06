import { Check, CircleCheck } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'wouter';
import { paths } from '../../app/routes';
import { Button } from '../../design/components/Button';
import { Panel } from '../../design/components/Panel';
import { formatDuration } from '../../lib/format';
import { serverNow, useCluster } from '../../store/cluster';
import { useEvents } from '../../store/events';
import type { Event } from '../../lib/types';
import { RowsSkeleton } from '../placeholders';
import { openAlerts } from './model';
import { ProblemBanner } from './parts/Banner';
import { ClockTime } from './parts/RelTime';
import { SeverityBadge } from './parts/SeverityBadge';
import { useTick } from './parts/tick';
import type { useAck } from './useAck';

/** "for 3 min"; "just now" for an alert that has only just fired (never "for 0 s"). */
function Since({ ts }: { ts: number }) {
  useTick(5_000);
  const age = serverNow() - ts;
  return <span className="num">{age < 5 ? 'just now' : `for ${formatDuration(age)}`}</span>;
}

interface Props {
  loading: boolean;
  acker: ReturnType<typeof useAck>;
}

export function OpenAlerts({ loading, acker }: Props) {
  const events = useEvents((s) => s.events);
  const open = useMemo(() => openAlerts(events), [events]);
  const nodeCount = useCluster((s) => s.order.length);
  const unacked = open.filter((e) => !e.acked).length;
  const subtitle = open.length === 0 ? 'Nothing is firing' : `${open.length} firing${unacked < open.length ? ` · ${open.length - unacked} acknowledged` : ''}`;

  return (
    <Panel title="Open alerts" subtitle={loading && !open.length ? 'Loading…' : subtitle} busy={loading && !open.length} flush={open.length > 0}>
      {loading && !open.length ? (
        <RowsSkeleton rows={2} />
      ) : open.length === 0 ? (
        <div className="open-empty">
          <span className="open-empty__glyph tone-ok" aria-hidden="true"><CircleCheck strokeWidth={2} /></span>
          <div>
            <p className="t-headline">No open alerts</p>
            <p className="t-footnote t-secondary">
              Every enabled rule is quiet{nodeCount ? ` on ${nodeCount === 1 ? 'the node' : `all ${nodeCount} nodes`}` : ''}. New alerts appear here and in the timeline below.
            </p>
          </div>
        </div>
      ) : (
        <ul className="open-list">
          {open.map((e) => (
            <OpenAlertRow key={e.id} e={e} acker={acker} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function OpenAlertRow({ e, acker }: { e: Event; acker: ReturnType<typeof useAck> }) {
  const pending = acker.pending.has(e.id);
  const failed = acker.failed?.id === e.id ? acker.failed.problem : null;
  return (
    <li className={`open-row${e.acked ? ' is-acked' : ''}`}>
      <div className="open-row__sev">
        <SeverityBadge severity={e.severity} size="md" />
      </div>
      <div className="open-row__main">
        <p className="open-row__title">{e.title}</p>
        <p className="open-row__detail">{e.detail}</p>
      </div>
      <div className="open-row__node">
        {e.node_id ? <Link href={paths.node(e.node_id)} className="node-chip">{e.node_id}</Link> : <span className="t-tertiary">Cluster</span>}
      </div>
      <div className="open-row__since">
        <span className="open-row__since-dur">
          <Since ts={e.ts} />
        </span>
        <span className="t-footnote t-tertiary">
          since <ClockTime ts={e.ts} />
        </span>
      </div>
      <div className="open-row__action">
        {e.acked ? (
          // Optimistic: shown as soon as it is clicked; rolled back with an inline error if the console refuses.
          <span className="acked">
            <Check aria-hidden="true" />
            Acknowledged
          </span>
        ) : (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => { void acker.ack(e); }} aria-label={`Acknowledge: ${e.title}`}>
            Acknowledge
          </Button>
        )}
      </div>
      {failed ? (
        <div className="open-row__error">
          <ProblemBanner problem={failed} action={<Button size="sm" variant="ghost" onClick={acker.dismiss}>Dismiss</Button>} />
        </div>
      ) : null}
    </li>
  );
}
