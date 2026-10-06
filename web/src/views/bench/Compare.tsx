// /benchmarks/compare?ids=a,b,c — runs side by side: a column per run (date, driver, params), a row per metric with
// its value and delta against the first run. Runs with different parameters are flagged as not directly comparable
// (deltas, never a regression flag); runs of different benchmarks get no deltas at all.
import { ArrowLeft, GitCompareArrows, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { ProblemState } from '../../design/components/ProblemState';
import { ApiError, benchApi, problemOf } from '../../lib/api';
import type { BenchCompare, BenchSpec } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { RowsSkeleton } from '../placeholders';
import { runPath, useCatalog, type Load } from './hooks';
import { compareMatrix, differingParams, formatDateTime, paramText, parseCompareIds, runFacts, valueWithUnit } from './model';
import { BetterHint, DeltaBadge, RunStatusPill } from './parts';

export function Compare() {
  const search = useSearch();
  const ids = useMemo(() => parseCompareIds(search), [search]);
  const idsKey = ids.join(',');
  const [load, setLoad] = useState<{ key: string; value: Load<BenchCompare>; missingIds?: string[] }>({ key: '', value: { state: 'loading' } });
  const [nonce, setNonce] = useState(0);
  const catalog = useCatalog().load;
  const specs = catalog.state === 'ready' ? catalog.data : [];
  const regressionPct = useCluster((s) => s.cluster?.settings.regression_pct ?? 5);

  useEffect(() => {
    if (ids.length < 2) return;
    let cancelled = false;
    benchApi.compare(ids).then(
      (data) => { if (!cancelled) setLoad({ key: idsKey, value: { state: 'ready', data } }); },
      (e: unknown) => {
        if (cancelled) return;
        const problem = problemOf(e, 'compare these runs');
        if (!(e instanceof ApiError && e.status === 404)) {
          setLoad({ key: idsKey, value: { state: 'error', problem } });
          return;
        }
        // Some ids no longer exist: find which, so the rest can still be compared.
        void Promise.all(ids.map((id) => benchApi.run(id).then(() => null, (err: unknown) => (err instanceof ApiError && err.status === 404 ? id : null)))).then((gone) => {
          if (!cancelled) setLoad({ key: idsKey, value: { state: 'error', problem }, missingIds: gone.filter((x): x is string => x !== null) });
        });
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, nonce]);

  const back = (
    <Link href="/benchmarks" className="bench-back">
      <ArrowLeft aria-hidden="true" />
      All benchmarks
    </Link>
  );

  if (ids.length < 2) {
    return (
      <div className="view">
        {back}
        <Panel label="Compare runs">
          <EmptyState icon={GitCompareArrows} title="Pick two to four runs to compare" action={<Link href="/benchmarks" className="btn btn--secondary btn--md">Open history</Link>}>
            Tick runs in the history table, then choose Compare.
          </EmptyState>
        </Panel>
      </div>
    );
  }

  const value = load.key === idsKey ? load.value : ({ state: 'loading' } as const);
  const missingIds = load.key === idsKey ? (load.missingIds ?? []) : [];
  const remaining = ids.filter((id) => !missingIds.includes(id));
  return (
    <div className="view bench-compare">
      {back}
      <h2 className="t-title1">Compare {ids.length} runs</h2>
      {value.state === 'loading' ? (
        <Panel title="Results" busy><RowsSkeleton rows={5} /></Panel>
      ) : value.state === 'error' && missingIds.length ? (
        <Panel label="Compare runs">
          <ProblemState
            message={missingIds.length === 1 ? `Run ${missingIds[0] ?? ''} no longer exists` : `${missingIds.length} of these runs no longer exist`}
            cause={`It may have been deleted: ${missingIds.join(', ')}.`}
            fix={remaining.length >= 2 ? 'Compare the remaining runs, or pick others in the history.' : 'Pick other runs in the history.'}
            footnote={
              <span className="bench-compare__ways">
                {remaining.length >= 2 ? <Link href={`/benchmarks/compare?ids=${remaining.map(encodeURIComponent).join(',')}`} className="btn btn--primary btn--md">Compare the remaining {remaining.length} runs</Link> : null}
                <Link href="/benchmarks" className="btn btn--secondary btn--md">Open history</Link>
              </span>
            }
            as="h2"
          />
        </Panel>
      ) : value.state === 'error' ? (
        <Panel label="Compare runs">
          <ProblemState message={value.problem.message} cause={value.problem.cause} fix={value.problem.fix} onRetry={() => { setNonce((n) => n + 1); }} as="h2" />
        </Panel>
      ) : (
        <Matrix data={value.data} specs={specs} regressionPct={regressionPct} />
      )}
    </div>
  );
}

function Matrix({ data, specs, regressionPct }: { data: BenchCompare; specs: readonly BenchSpec[]; regressionPct: number }) {
  const rows = compareMatrix(data, regressionPct);
  const differ = differingParams(data.runs);
  const specOf = (id: string) => specs.find((s) => s.id === id);
  const multiNode = new Set(rows.map((r) => r.node_id)).size > 1;
  const mixed = new Set(data.runs.map((r) => r.bench_id)).size > 1;
  // Each parameter's label from whichever run's own benchmark has it.
  const labelOf = (name: string) => data.runs.map((r) => specOf(r.bench_id)?.params.find((p) => p.name === name)?.label).find(Boolean) ?? name.replaceAll('_', ' ');
  const names = [...new Set(data.runs.map((r) => specOf(r.bench_id)?.name ?? r.bench_id))];

  return (
    <>
      {mixed ? (
        <div className="ops-banner tone-warn" role="note">
          <TriangleAlert aria-hidden="true" />
          <div>
            <p className="ops-banner__title">Different benchmarks — not comparable</p>
            <p className="ops-banner__text">These runs are of {names.join(', ')}. Values are shown side by side without deltas; compare runs of one benchmark to see changes.</p>
          </div>
          <span />
        </div>
      ) : differ.length ? (
        <div className="ops-banner tone-warn" role="note">
          <TriangleAlert aria-hidden="true" />
          <div>
            <p className="ops-banner__title">Different parameters — not directly comparable</p>
            <p className="ops-banner__text">These runs differ in {differ.map((d) => (d === 'parameters' ? 'parameters' : labelOf(d))).join(', ')}. Deltas are shown for reference, but no result is flagged as a regression: they mix the effect of the change with the parameters.</p>
          </div>
          <span />
        </div>
      ) : null}
      <Panel title="Side by side" subtitle={mixed ? 'Values only: different benchmarks' : differ.length ? 'Deltas are against the first run · no regression flags: parameters differ' : `Deltas are against the first run · regression beyond ${regressionPct}%`} flush>
        {/* Focusable so keyboard users can scroll a wide comparison sideways. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="table-wrap bench-cmp__wrap" role="region" aria-label="Comparison table, scrolls sideways" tabIndex={0}>
          <table className="table bench-cmp">
            <caption className="visually-hidden">Benchmark results compared across {data.runs.length} runs, deltas against the first run</caption>
            <thead>
              <tr>
                <th scope="col" className="bench-cmp__corner">Metric</th>
                {data.runs.map((r, i) => {
                  const spec = specOf(r.bench_id);
                  const f = runFacts(r);
                  return (
                    <th key={r.id} scope="col" className="bench-cmp__run">
                      <span className="bench-cmp__ref">{i === 0 ? 'Reference' : `Run ${i + 1}`}</span>
                      <Link href={runPath(r.id)} className="bench-cmp__name">{spec?.name ?? r.bench_id}</Link>
                      <span className="bench-cmp__meta num">{formatDateTime(r.started_ts ?? r.created_ts)}</span>
                      <span className="bench-cmp__meta">{r.nodes.join(', ')}{f.driver ? ` · driver ${f.driver}` : ''}{f.cuda ? ` · CUDA ${f.cuda}` : ''}</span>
                      <span className="bench-cmp__params">
                        {spec
                          ? spec.params.map((p) => (
                              <span key={p.name} className={!mixed && differ.includes(p.name) ? 'is-diff' : undefined}>
                                {p.label} {paramText(p, r.params[p.name])}
                              </span>
                            ))
                          : Object.entries(r.params).map(([k, v]) => <span key={k}>{k} {paramText(undefined, v)}</span>)}
                      </span>
                      {r.status !== 'succeeded' ? <RunStatusPill status={r.status} size="sm" variant="inline" /> : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="bench-cmp__metric">
                      <span>{row.label}{multiNode && row.node_id ? <span className="t-tertiary"> · {row.node_id}</span> : null}</span>
                      <BetterHint better={row.better} />
                    </th>
                    {row.cells.map((cell) => (
                      <td key={cell.runId} className="bench-cmp__cell">
                        <span className="num bench-cmp__value">{valueWithUnit(cell.value, row.unit)}</span>
                        {cell.delta ? <DeltaBadge delta={cell.delta} /> : null}
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={data.runs.length + 1} className="table__empty">These runs have no results in common.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
