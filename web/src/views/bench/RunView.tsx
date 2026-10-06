// /benchmarks/runs/:id — one run: live progress with telemetry overlaid, cancellation, then the completion moment,
// results against the baseline, soak analysis, metadata, export, share card and delete.
import { ArrowLeft, CircleSlash, Download, ImageDown, RotateCw, ScrollText, Square, Star, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { AnimatedNumber } from '../../design/components/AnimatedNumber';
import { Button } from '../../design/components/Button';
import { ConfirmDialog } from '../../design/components/Dialog';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { ProblemState } from '../../design/components/ProblemState';
import { Skeleton } from '../../design/components/Skeleton';
import { Table, type Column } from '../../design/components/Table';
import { useNow } from '../../design/useNow';
import { benchApi, problemOf } from '../../lib/api';
import type { BenchResult, BenchRun, BenchSpec, Problem } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useBench } from '../../store/bench';
import { ProblemBanner } from '../alerts/parts/Banner';
import { listNodes } from '../overview/model';
import { PENDING_PREFIX, runPath, useCatalog, useRun, useRunList } from './hooks';
import {
  aboutDuration,
  cancelSentence,
  elapsed,
  estimateDuration,
  eta,
  formatDateTime,
  headlineResults,
  isActive,
  isSmoke,
  isUnsupported,
  baselineCoverage,
  metaLabel,
  metaText,
  nodeMeta,
  nodesText,
  servedModel,
  signedFormat,
  unitText,
  orderedMeta,
  paramText,
  paramsSummary,
  projectedTotal,
  resultDelta,
  resultText,
  stopwatch,
  valueWithUnit,
} from './model';
import { BetterHint, DeltaBadge, RunStatusPill } from './parts';
import { RunTelemetry } from './RunTelemetry';
import { ShareCardDialog } from './ShareCard';
import { SoakPanel } from './SoakPanel';

export function RunView({ id }: { id: string }) {
  const { run, missing, gone, refetch } = useRun(id);
  const { load } = useCatalog();
  useRunList(); // the other runs: which one is the current baseline
  const spec = load.state === 'ready' ? load.data.find((s) => s.id === run?.bench_id) : undefined;

  if (!run) {
    if (missing || id.startsWith(PENDING_PREFIX)) {
      // A pending id outlives its placeholder only across a reload: the console either refused the run (the reason was
      // on this page) or had not answered yet; a run it accepted is in the history under its own id.
      const p: Problem = missing ?? {
        message: 'This run did not start',
        cause: 'The console refused it, or the page was reloaded before the console answered.',
        fix: 'Open the history: a run that started is listed there. Otherwise start it again from the catalog.',
      };
      return (
        <div className="view">
          <BackLink />
          <Panel label="Benchmark run">
            <ProblemState
              message={p.message}
              cause={p.cause}
              fix={p.fix}
              onRetry={gone ? undefined : refetch}
              footnote={gone ? <Link href="/benchmarks" className="btn btn--secondary btn--md">Open history</Link> : undefined}
              as="h2"
            />
          </Panel>
        </div>
      );
    }
    return <RunSkeleton />;
  }
  return <RunBody key={run.id} run={run} spec={spec} />;
}

function BackLink() {
  return (
    <Link href="/benchmarks" className="bench-back">
      <ArrowLeft aria-hidden="true" />
      All benchmarks
    </Link>
  );
}

function RunSkeleton() {
  return (
    <div className="view" aria-busy="true">
      <BackLink />
      <div className="bench-run__head">
        <Skeleton width={260} height={24} radius={8} />
        <Skeleton width={180} height={13} />
      </div>
      <Panel title="Progress" busy><Skeleton height={64} radius={12} /></Panel>
    </div>
  );
}

function RunBody({ run, spec }: { run: BenchRun; spec: BenchSpec | undefined }) {
  const [, navigate] = useLocation();
  const now = useNow(1000) / 1000 + useCluster.getState().clockOffset;
  const settingPct = useCluster((s) => s.cluster?.settings.regression_pct ?? 5);
  // The threshold the console flagged this run's regressions with; the setting may have changed since.
  const regressionPct = typeof run.metadata.regression_pct === 'number' ? run.metadata.regression_pct : settingPct;
  const active = isActive(run.status);
  // The agents' own estimate for these exact parameters once they report it, else the catalog-based guess.
  const agentEst = Math.max(0, ...Object.values(run.node_states ?? {}).map((st) => (typeof st.metadata.est_duration_s === 'number' ? st.metadata.est_duration_s : 0)));
  const estimate = agentEst > 0 ? agentEst : spec ? estimateDuration(spec, run.params as never) : 60;
  const name = spec?.name ?? run.bench_id;
  const pending = run.id.startsWith(PENDING_PREFIX);

  // The completion moment plays only for a run seen finishing here, not for one opened after the fact.
  const wasActive = useRef(active);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (wasActive.current && run.status === 'succeeded') setCelebrate(true);
    wasActive.current = active;
  }, [active, run.status]);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [actionProblem, setActionProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState('');
  if (cancelling && !active) setCancelling(false);
  if (cancelOpen && !active) {
    // Finished while the confirmation was open: there is nothing left to stop.
    setCancelOpen(false);
    setNotice(`${spec?.name ?? run.bench_id} finished before it could be stopped.`);
  }

  const cancel = () => {
    setCancelOpen(false);
    setCancelling(true);
    setActionProblem(null);
    benchApi.cancel(run.id).catch((e: unknown) => {
      setCancelling(false);
      setActionProblem(problemOf(e, 'cancel the benchmark'));
    });
  };
  const remove = () => {
    setDeleteOpen(false);
    benchApi.remove(run.id).then(
      () => {
        useBench.getState().remove(run.id);
        navigate('/benchmarks');
      },
      (e: unknown) => { setActionProblem(problemOf(e, 'delete this run')); },
    );
  };
  const runAgain = () => { navigate(`/benchmarks?configure=${encodeURIComponent(run.bench_id)}&from=${encodeURIComponent(run.id)}`); };

  const statusText = `${name} ${run.status === 'succeeded' ? 'finished' : run.status}`;

  return (
    <div className="view bench-run">
      <BackLink />
      <header className="bench-run__head">
        <div className="bench-run__titles">
          <div className="bench-run__title-row">
            <h2 className="t-title1 bench-run__title">{name}</h2>
            <RunStatusPill status={run.status} />
          </div>
          <p className="bench-run__sub">
            <span>{nodesText(run.bench_id, run.nodes)}</span>
            {servedModel(run.results) ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{servedModel(run.results)}</span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span>Started {formatDateTime(run.started_ts ?? run.created_ts)}</span>
            {spec?.params.length ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{paramsSummary(spec, run.params, 4)}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="bench-run__actions">
          {active ? (
            <Button variant="destructive" icon={<Square />} disabled={cancelling || pending} onClick={() => { setCancelOpen(true); }}>
              {cancelling ? 'Cancelling…' : 'Cancel run'}
            </Button>
          ) : (
            <>
              {run.status === 'succeeded' ? <Button variant="secondary" icon={<RotateCw />} onClick={runAgain}>Run again</Button> : null}
              {!pending ? <Button variant="ghost" icon={<Trash2 />} onClick={() => { setDeleteOpen(true); }}>Delete</Button> : null}
            </>
          )}
        </div>
      </header>
      {/* Status changes only (never progress ticks), politely. */}
      <p className="visually-hidden" role="status">{active ? '' : statusText}</p>

      {notice ? <p className="bench-run__notice" role="status">{notice}</p> : null}
      {actionProblem ? <ProblemBanner problem={actionProblem} action={<Button size="sm" variant="ghost" onClick={() => { setActionProblem(null); }}>Dismiss</Button>} /> : null}

      {active ? (
        <Panel title="Progress" className="bench-run__progress">
          <Progress run={run} now={now} estimate={estimate} cancelling={cancelling} />
        </Panel>
      ) : run.status === 'succeeded' ? (
        <Completion run={run} celebrate={celebrate} regressionPct={regressionPct} />
      ) : run.status === 'failed' ? (
        <Panel label="Benchmark failed">
          <ProblemState
            message={run.error?.message ?? `${name} failed`}
            cause={run.error?.cause}
            fix={run.error?.fix}
            onRetry={runAgain}
            retryLabel="Run again"
            as="h2"
          />
        </Panel>
      ) : (
        <Panel label="Benchmark cancelled">
          <EmptyState icon={CircleSlash} title="Cancelled" action={<Button variant="secondary" icon={<RotateCw />} onClick={runAgain}>Run again</Button>}>
            The benchmark was stopped after {stopwatch(elapsed(run, now))}. Its containers and temp files were removed, and partial results were discarded.
          </EmptyState>
        </Panel>
      )}

      {active || run.started_ts != null ? (
        <Panel title={active ? 'Live telemetry' : 'Telemetry during the run'} subtitle={run.nodes.length > 1 ? 'One line per node · dashed rules mark the run' : 'Dashed rules mark the run'}>
          <RunTelemetry run={run} category={spec?.category} expected={projectedTotal(run, now, estimate)} />
        </Panel>
      ) : null}

      {spec?.category === 'soak' || run.bench_id === 'thermal-soak' ? <SoakPanel run={run} expected={projectedTotal(run, now, estimate)} /> : null}

      {run.results.length ? <ResultsPanel run={run} regressionPct={regressionPct} onShare={() => { setShareOpen(true); }} /> : null}

      <MetadataPanel run={run} spec={spec} />
      <LogPanel lines={run.log_tail} active={active} />

      <ConfirmDialog
        open={cancelOpen}
        title={`Stop ${name}?`}
        consequences={[cancelSentence(run.nodes)]}
        confirmLabel="Stop benchmark"
        destructive
        onCancel={() => { setCancelOpen(false); }}
        onConfirm={cancel}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="Delete this run?"
        consequences={[
          'Removes the run, its results and its telemetry from the history.',
          ...(run.baseline_for ? ['It is the current baseline, so later runs with these parameters are not compared until you set a new one.'] : []),
          'This can’t be undone.',
        ]}
        confirmLabel="Delete run"
        destructive
        onCancel={() => { setDeleteOpen(false); }}
        onConfirm={remove}
      />
      {shareOpen ? <ShareCardDialog run={run} spec={spec} onClose={() => { setShareOpen(false); }} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ progress

function Progress({ run, now, estimate, cancelling }: { run: BenchRun; now: number; estimate: number; cancelling: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, run.progress)) * 100);
  const left = eta(run, now, estimate);
  const phase = cancelling ? 'Cancelling — stopping processes and removing containers…' : run.phase || (run.status === 'queued' ? 'Queued' : 'Starting…');
  const states = Object.values(run.node_states ?? {});
  return (
    <div className="bench-progress">
      <div className="bench-progress__top">
        <span className="bench-progress__phase">{phase}</span>
        <span className="bench-progress__pct num">{pct}%</span>
      </div>
      <div
        className={`bench-bar${cancelling ? ' is-cancelling' : ''}${run.status === 'queued' ? ' is-indeterminate' : ''}`}
        role="progressbar"
        aria-label="Benchmark progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%, ${phase}`}
      >
        <span className="bench-bar__fill" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <dl className="bench-progress__times">
        <div>
          <dt>Elapsed</dt>
          <dd className="num">{stopwatch(elapsed(run, now))}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd className="num">{left === null ? '—' : left < 1 ? 'Finishing…' : aboutDuration(left)}</dd>
        </div>
        <div>
          <dt>Expected total</dt>
          <dd className="num">{aboutDuration(projectedTotal(run, now, estimate))}</dd>
        </div>
      </dl>
      {states.length > 1 || run.nodes.length > 1 ? (
        <ul className="bench-nodeprog" aria-label="Progress per node">
          {run.nodes.map((n) => {
            const st = run.node_states?.[n];
            const p = Math.round(Math.min(1, Math.max(0, st?.progress ?? 0)) * 100);
            return (
              <li key={n} className="bench-nodeprog__row">
                <span className="bench-nodeprog__node">{n}</span>
                <span className="bench-nodeprog__role">{st?.role && st.role !== 'single' ? st.role : ''}</span>
                <span className="bench-nodeprog__phase">{st?.phase || (st ? '' : 'Waiting for the agent…')}</span>
                <span className="bench-bar bench-bar--sm" role="progressbar" aria-label={`${n} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
                  <span className="bench-bar__fill" style={{ transform: `scaleX(${p / 100})` }} />
                </span>
                <span className="num bench-nodeprog__pct">{p}%</span>
                {st ? <RunStatusPill status={st.status} size="sm" variant="inline" /> : <span />}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ completion

function Completion({ run, celebrate, regressionPct }: { run: BenchRun; celebrate: boolean; regressionPct: number }) {
  const heads = headlineResults(run.results);
  const dur = run.started_ts != null && run.finished_ts != null ? run.finished_ts - run.started_ts : null;
  const regressions = run.results.filter((r) => resultDelta(r, regressionPct)?.regression).length;
  const coverage = baselineCoverage(run.results);
  return (
    <section className={`bench-done material-regular${celebrate ? ' is-celebrating' : ''}`} aria-label="Result">
      <svg className="bench-done__check" viewBox="0 0 52 52" aria-hidden="true">
        <circle className="bench-done__ring" cx="26" cy="26" r="23" />
        <path className="bench-done__tick" d="M15 27 l7.5 7.5 L37 19" />
      </svg>
      <div className="bench-done__text">
        <p className="bench-done__title">Completed in {dur !== null ? stopwatch(dur) : '—'}</p>
        <p className="bench-done__sub">
          {run.baseline_for
            ? 'This run is the baseline for these parameters.'
            : coverage.with.length
              ? `${regressions ? `${regressions} ${regressions === 1 ? 'result is' : 'results are'} worse than the baseline by more than the ${regressionPct}% threshold` : `${coverage.without.length ? `${listNodes(coverage.with)} compared with ${coverage.with.length === 1 ? 'its' : 'their'} baseline` : 'Compared with the baseline'}: no regressions`}${coverage.without.length ? `; ${listNodes(coverage.without)} ${coverage.without.length === 1 ? 'has' : 'have'} no baseline yet` : ''}.`
              : 'No baseline yet for these parameters. Set this run as the baseline to compare future runs.'}
        </p>
        {isSmoke(run.results) ? <p className="bench-done__sub"><strong>Smoke run:</strong> the GPU payload ran on the CPU at tiny sizes to test the code path. These are not GPU measurements.</p> : null}
      </div>
      <ul className="bench-done__heads">
        {heads.map((r) => <Headline key={`${r.metric}|${r.node_id ?? ''}`} result={r} showNode={run.nodes.length > 1} celebrate={celebrate} regressionPct={regressionPct} />)}
      </ul>
    </section>
  );
}

function Headline({ result: r, showNode, celebrate, regressionPct }: { result: BenchResult; showNode: boolean; celebrate: boolean; regressionPct: number }) {
  // Count up from zero once, when the run finished while on screen (AnimatedNumber is instant under reduced motion).
  const [shown, setShown] = useState(celebrate ? 0 : r.value);
  useEffect(() => {
    const raf = requestAnimationFrame(() => { setShown(r.value); });
    return () => { cancelAnimationFrame(raf); };
  }, [r.value]);
  return (
    <li className="bench-head">
      <span className="bench-head__label">
        {r.label}
        {showNode && r.node_id ? <span className="bench-head__node"> · {r.node_id}</span> : null}
      </span>
      <span className="bench-head__value">
        <AnimatedNumber value={shown} format={signedFormat(r)} className="bench-head__num" />
        <span className={`bench-head__unit${r.unit === '%' ? ' is-tight' : ''}`}>{unitText(r.unit)}</span>
      </span>
      {/* The delta row is always there (empty without a baseline), so headlines line up. */}
      <span className="bench-head__delta">{r.baseline != null ? <DeltaBadge delta={resultDelta(r, regressionPct)} /> : <span className="visually-hidden">No baseline</span>}</span>
    </li>
  );
}

// ------------------------------------------------------------------------------------------------ results

function ResultsPanel({ run, regressionPct, onShare }: { run: BenchRun; regressionPct: number; onShare: () => void }) {
  const runs = useBench((s) => s.runs);
  const current = useMemo(
    () => Object.values(runs).find((r) => r.baseline_for && r.bench_id === run.bench_id && r.params_key === run.params_key && r.id !== run.id),
    [runs, run.bench_id, run.params_key, run.id],
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const multiNode = new Set(run.results.map((r) => r.node_id)).size > 1;

  const setBaseline = () => {
    setBusy(true);
    setProblem(null);
    benchApi.setBaseline(run.bench_id, run.id).then(
      (res) => {
        setBusy(false);
        const st = useBench.getState();
        const updates = Object.values(st.runs)
          .filter((r) => r.bench_id === run.bench_id && r.params_key === run.params_key && (r.baseline_for || r.id === run.id))
          .map((r) => ({ ...r, baseline_for: r.id === run.id }));
        useBench.setState((s) => ({ runs: { ...s.runs, ...Object.fromEntries(updates.map((r) => [r.id, r])) } }));
        if (res && typeof res === 'object' && 'id' in res && 'bench_id' in res) st.upsert(res as BenchRun);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(problemOf(e, 'set the baseline'));
      },
    );
  };

  const columns: Column<BenchResult>[] = [
    {
      id: 'metric',
      header: 'Metric',
      sortValue: (r) => r.label,
      render: (r) => (
        <span className="bench-res__metric">
          <span>{r.label}</span>
          <BetterHint better={r.better} />
        </span>
      ),
    },
    ...(multiNode ? [{ id: 'node', header: 'Node', sortValue: (r: BenchResult) => r.node_id ?? '', render: (r: BenchResult) => r.node_id ?? 'Cluster' }] : []),
    { id: 'value', header: 'Value', align: 'end', sortValue: (r) => r.value, render: (r) => <span className="num bench-res__value" title={isUnsupported(r) && typeof r.extras.reason === 'string' ? r.extras.reason : undefined}>{resultText(r)}</span> },
    { id: 'baseline', header: 'Baseline', align: 'end', sortValue: (r) => r.baseline, render: (r) => <span className="num t-secondary">{valueWithUnit(r.baseline, r.unit)}</span> },
    { id: 'delta', header: 'Δ vs baseline', align: 'end', sortValue: (r) => resultDelta(r, regressionPct)?.pct ?? null, render: (r) => <DeltaBadge delta={resultDelta(r, regressionPct)} /> },
  ];

  const succeeded = run.status === 'succeeded';
  return (
    <Panel
      title="Results"
      subtitle={
        run.baseline_for ? (
          <span className="bench-baseline-note"><Star aria-hidden="true" className="is-filled" /> This run is the baseline</span>
        ) : current ? (
          <span>
            Baseline: <Link href={runPath(current.id)}>{formatDateTime(current.finished_ts ?? current.created_ts)}</Link>
            {run.baseline_run_id && run.baseline_run_id !== current.id ? ' (compared against an earlier baseline)' : ''}
          </span>
        ) : run.baseline_run_id ? (
          <span>Compared against <Link href={runPath(run.baseline_run_id)}>the baseline run</Link></span>
        ) : (
          'No baseline for these parameters yet'
        )
      }
      flush
      actions={
        <div className="bench-res__actions">
          {succeeded && !run.baseline_for ? (
            <Button size="sm" variant="secondary" icon={<Star />} disabled={busy} onClick={setBaseline}>
              {busy ? 'Saving…' : 'Set as baseline'}
            </Button>
          ) : null}
          <a className="btn btn--ghost btn--sm" href={benchApi.exportUrl(run.id, 'json')} download>
            <span className="btn__icon" aria-hidden="true"><Download /></span>JSON
          </a>
          <a className="btn btn--ghost btn--sm" href={benchApi.exportUrl(run.id, 'csv')} download>
            <span className="btn__icon" aria-hidden="true"><Download /></span>CSV
          </a>
          {succeeded ? <Button size="sm" variant="ghost" icon={<ImageDown />} onClick={onShare}>Share card</Button> : null}
        </div>
      }
    >
      {problem ? <div className="bench-res__problem"><ProblemBanner problem={problem} action={<Button size="sm" variant="ghost" onClick={() => { setProblem(null); }}>Dismiss</Button>} /></div> : null}
      <Table caption={`Results of this run`} columns={columns} rows={run.results} rowKey={(r) => `${r.metric}|${r.node_id ?? ''}`} />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ metadata & log

/** Run metadata: environment per node (side by side when several), then parameters, times and the run id. */
function MetadataPanel({ run, spec }: { run: BenchRun; spec: BenchSpec | undefined }) {
  const perNode = nodeMeta(run);
  const nodes = Object.keys(perNode);
  const keys = [...new Set(nodes.flatMap((n) => Object.keys(perNode[n] ?? {})))].filter((k) => k !== 'params');
  const ordered = orderedMeta(Object.fromEntries(keys.map((k) => [k, null]))).map(([k]) => k);
  const times: [string, number | null][] = [
    ['Created', run.created_ts],
    ['Started', run.started_ts],
    ['Finished', run.finished_ts],
  ];
  return (
    <Panel title="Metadata" subtitle="Saved with the results">
      {nodes.length > 1 ? (
        <div className="table-wrap bench-meta-table">
          <table className="table">
            <caption className="visually-hidden">Environment per node</caption>
            <thead>
              <tr>
                <th scope="col">Environment</th>
                {nodes.map((n) => <th key={n} scope="col">{n}</th>)}
              </tr>
            </thead>
            <tbody>
              {ordered.map((k) => (
                <tr key={k}>
                  <th scope="row">{metaLabel(k)}</th>
                  {nodes.map((n) => <td key={n}><MetaValue k={k} v={perNode[n]?.[k]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <dl className="bench-meta">
        {nodes.length === 1
          ? ordered.map((k) => (
              <div key={k}>
                <dt>{metaLabel(k)}</dt>
                <dd><MetaValue k={k} v={perNode[nodes[0] ?? '']?.[k]} /></dd>
              </div>
            ))
          : null}
        <div>
          <dt>Parameters</dt>
          <dd>
            {Object.keys(run.params).length ? (
              <dl className="bench-meta bench-meta--nested">
                {Object.entries(run.params).map(([k, v]) => {
                  const p = spec?.params.find((x) => x.name === k);
                  return (
                    <div key={k}>
                      <dt>{p?.label ?? metaLabel(k)}</dt>
                      <dd>{paramText(p, v)}</dd>
                    </div>
                  );
                })}
              </dl>
            ) : 'Defaults'}
          </dd>
        </div>
        {times.map(([label, ts]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{ts == null ? '—' : <time className="num" dateTime={new Date(ts * 1000).toISOString()}>{formatDateTime(ts)}:{String(new Date(ts * 1000).getSeconds()).padStart(2, '0')}</time>}</dd>
          </div>
        ))}
        <div>
          <dt>Run ID</dt>
          <dd><code>{run.id}</code></dd>
        </div>
      </dl>
    </Panel>
  );
}

/** A metadata value; an object of several values (the start/end telemetry snapshots, core counts) as a nested list. */
function MetaValue({ k, v }: { k: string; v: unknown }) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 1) {
    return (
      <dl className="bench-meta bench-meta--nested">
        {Object.entries(v as Record<string, unknown>).map(([kk, vv]) => (
          <div key={kk}>
            <dt>{metaLabel(kk)}</dt>
            <dd>{metaText(kk, vv)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <>{metaText(k, v)}</>;
}

function LogPanel({ lines, active }: { lines: readonly string[]; active: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(false);
  const count = lines.length;
  useEffect(() => {
    const el = ref.current;
    if (el && open) el.scrollTop = el.scrollHeight; // follow the tail
  }, [count, open, lines]);
  return (
    <Panel title="Log" subtitle={count ? `Last ${count} ${count === 1 ? 'line' : 'lines'}${active ? ' · live' : ''}` : 'Nothing logged yet'}>
      {count ? (
        <details className="bench-log" open={open} onToggle={(e) => { setOpen(e.currentTarget.open); }}>
          <summary>
            <ScrollText aria-hidden="true" />
            {open ? 'Hide log' : 'Show log'}
          </summary>
          {/* Not a live region: a screen reader must not read every new log line. */}
          {/* Focusable so keyboard users can scroll it. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <pre ref={ref} className="bench-log__pre" aria-live="off" tabIndex={0} role="region" aria-label="Benchmark log">
            {lines.join('\n')}
          </pre>
        </details>
      ) : (
        <p className="bench-log__empty">{active ? 'Log lines will appear here as the benchmark reports them.' : 'This run did not log anything.'}</p>
      )}
    </Panel>
  );
}
