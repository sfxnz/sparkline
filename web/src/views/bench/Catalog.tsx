// The catalog: one card per benchmark, grouped by category, with expected impact, per-node availability and the
// latest result. "Configure…" opens the configure → confirm flow.
import { Clock, SlidersHorizontal } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link } from 'wouter';
import { Button } from '../../design/components/Button';
import type { BenchRun, BenchSpec } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { formatAgo } from '../../lib/format';
import { useNow } from '../../design/useNow';
import { runPath } from './hooks';
import { aboutDuration, groupCatalog, headlineText, runnableNodes, splitDescription } from './model';
import { Availability, CATEGORY_ICON, ImpactChips, RunStatusPill } from './parts';

interface Props {
  specs: readonly BenchSpec[];
  /** Latest run per bench id (any status). */
  latest: Record<string, BenchRun | undefined>;
  onConfigure: (spec: BenchSpec) => void;
}

export function Catalog({ specs, latest, onConfigure }: Props) {
  const groups = groupCatalog(specs);
  return (
    <div className="bench-catalog">
      {groups.map((g) => (
        <section key={g.category} className="bench-group" aria-labelledby={`bench-cat-${g.category}`} style={{ '--n': g.specs.length } as CSSProperties}>
          <h2 id={`bench-cat-${g.category}`} className="t-eyebrow bench-group__label">{g.label}</h2>
          <ul className="bench-group__cards">
            {g.specs.map((s) => (
              <li key={s.id}>
                <BenchCard spec={s} last={latest[s.id]} onConfigure={() => { onConfigure(s); }} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function BenchCard({ spec, last, onConfigure }: { spec: BenchSpec; last: BenchRun | undefined; onConfigure: () => void }) {
  const order = useCluster((s) => s.order);
  const statuses = useCluster((s) => s.nodes);
  const now = useNow(30_000) / 1000;
  const Icon = CATEGORY_ICON[spec.category];
  const nodes = [...order.filter((id) => id in spec.availability), ...Object.keys(spec.availability).filter((id) => !order.includes(id))];
  const runnable = runnableNodes(spec, nodes).length >= spec.min_nodes;
  const span = spec.min_nodes === 2 ? 'Needs 2 nodes' : spec.max_nodes === 1 ? 'One node' : `Up to ${spec.max_nodes ?? 'all'} nodes`;
  const headingId = `bench-card-${spec.id}`;

  return (
    <article className="bench-card material-regular" aria-labelledby={headingId}>
      <header className="bench-card__head">
        <span className="bench-card__icon" aria-hidden="true"><Icon strokeWidth={1.75} /></span>
        <div className="bench-card__titles">
          <h3 id={headingId} className="bench-card__name">{spec.name}</h3>
          <p className="bench-card__meta">
            <span className="bench-card__dur num"><Clock aria-hidden="true" />{aboutDuration(spec.est_duration_s)}</span>
            <span aria-hidden="true">·</span>
            <span>{span}</span>
          </p>
        </div>
      </header>
      <p className="bench-card__desc">{splitDescription(spec.description).summary}</p>
      <ImpactChips impact={spec.impact} />
      <ul className="bench-avails" aria-label={`${spec.name} availability`}>
        {nodes.map((id) => <Availability key={id} node={id} problem={spec.availability[id]} nodeStatus={statuses[id]?.status} />)}
      </ul>
      <footer className="bench-card__foot">
        {last ? (
          <Link href={runPath(last.id)} className="bench-card__last">
            {last.status === 'succeeded' ? (
              <>
                <span className="bench-card__last-value num">{headlineText(last.results)}</span>
                <span className="bench-card__last-when">{formatAgo(last.finished_ts ?? last.created_ts, now)}</span>
              </>
            ) : (
              <>
                <RunStatusPill status={last.status} size="sm" variant="inline" />
                <span className="bench-card__last-when">{formatAgo(last.created_ts, now)}</span>
              </>
            )}
            <span className="visually-hidden">, open the latest {spec.name} run</span>
          </Link>
        ) : (
          <span className="bench-card__last bench-card__last--none">Not run yet</span>
        )}
        <Button variant="secondary" size="sm" className={runnable ? 'bench-card__cta' : undefined} icon={<SlidersHorizontal />} onClick={onConfigure} aria-label={`Configure ${spec.name}…`}>
          Configure…
        </Button>
      </footer>
    </article>
  );
}
