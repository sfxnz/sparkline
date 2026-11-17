import { Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../design/components/Dialog';
import { EmptyState } from '../design/components/EmptyState';
import { Panel } from '../design/components/Panel';
import { ProblemState } from '../design/components/ProblemState';
import type { NodeRecState, Recommendation } from '../lib/types';
import { useCluster } from '../store/cluster';
import { RowsSkeleton } from './placeholders';
import { confirmCopy, leadWithRecommended, nodeOrder, nodeRows, standing, type Verb } from './recommend/model';
import { RecCard } from './recommend/RecCard';
import { rowKey, useRecommendations } from './recommend/useRecommendations';
import './recommend/recommend.css';
import './views.css';

interface Ask {
  rec: Recommendation;
  node: string;
  item: NodeRecState;
  verb: Verb;
}

function Confirm({ ask, onCancel, onConfirm }: { ask: Ask; onCancel: () => void; onConfirm: () => void }) {
  const { commands, ...copy } = confirmCopy(ask.rec, ask.node, ask.verb);
  return (
    <ConfirmDialog
      open
      {...copy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      details={
        // Focusable so keyboard users can scroll it.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div className="rec-confirm" tabIndex={0} role="region" aria-label="Commands and known risks">
          <p className="rec-h">By hand, the same change is these commands</p>
          <pre className="rec-cmd__pre"><code>{commands.join('\n')}</code></pre>
          <p className="rec-h">Known risks of this setting</p>
          <ul className="rec-list">
            {ask.rec.risks.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      }
    />
  );
}

/** Recommendations: the settings DGX Spark owners recommend, what each node says about each one, and Apply or Undo
 *  where one click can do it. What is still recommended comes first. */
export default function Recommendations() {
  const { load, reload, rows: statuses, change } = useRecommendations();
  const order = useCluster((s) => s.order);
  const [ask, setAsk] = useState<Ask | null>(null);

  if (load.state === 'loading') {
    return (
      <div className="view view--narrow">
        <Panel title="Loading…" busy>
          <RowsSkeleton rows={4} />
        </Panel>
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <div className="view view--narrow">
        <Panel label="Recommendations">
          <ProblemState message={load.problem.message} cause={load.problem.cause} fix={load.problem.fix} onRetry={reload} />
        </Panel>
      </div>
    );
  }

  const view = load.data;
  const nodes = nodeOrder(view, order);
  const cards = leadWithRecommended(
    view.catalog.map((rec) => {
      const rows = nodeRows(view, nodes, rec);
      return { rec, rows, standing: standing(rows) };
    }),
  );
  const waiting = cards.filter((c) => c.standing === 'recommended').length;

  if (cards.length === 0) {
    return (
      <div className="view view--narrow">
        <Panel label="Recommendations">
          <EmptyState icon={Lightbulb} title="No recommendations">
            This release of Sparkline ships no recommended settings.
          </EmptyState>
        </Panel>
      </div>
    );
  }

  return (
    <div className="view view--narrow">
      <p className="rec-lead">
        {waiting > 0
          ? `${waiting} of ${cards.length} settings ${waiting === 1 ? 'has' : 'have'} something to apply on your nodes.`
          : 'Nothing here is waiting to be applied on the nodes that answered.'}{' '}
        These are settings that DGX Spark owners recommend to each other. Each one says whether Sparkline has measured it.
      </p>
      {cards.map(({ rec, rows, standing: s }) => (
        <RecCard
          key={rec.id}
          rec={rec}
          rows={rows}
          standing={s}
          statusOf={(node) => statuses[rowKey(node, rec.id)] ?? null}
          onAsk={(node, item, verb) => { setAsk({ rec, node, item, verb }); }}
        />
      ))}
      {ask ? <Confirm ask={ask} onCancel={() => { setAsk(null); }} onConfirm={() => { setAsk(null); void change(ask.rec, ask.node, ask.item, ask.verb); }} /> : null}
    </div>
  );
}
