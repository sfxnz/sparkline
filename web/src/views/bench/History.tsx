// Run history: filter by benchmark / node / status, sort any column, tick 2–4 runs to compare them.
import { FilterX, GitCompareArrows, Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Button } from '../../design/components/Button';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { ProblemState } from '../../design/components/ProblemState';
import { Table, type Column } from '../../design/components/Table';
import { formatDuration } from '../../lib/format';
import type { BenchRun, BenchSpec, Problem, RunStatus } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { Select } from '../alerts/parts/Select';
import { RowsSkeleton } from '../placeholders';
import { runPath } from './hooks';
import { baselineSummary, filterRuns, nodesText, formatDateTime, headlineCaption, headlineDetail, headlineText, MAX_COMPARE, NO_HISTORY_FILTERS, paramsSummary, runDuration, STATUS_LOOK, type HistoryFilters } from './model';
import { DeltaBadge, RunStatusPill } from './parts';

interface Props {
  runs: readonly BenchRun[];
  specs: readonly BenchSpec[];
  load: { state: 'loading' | 'ready' | 'error'; problem: Problem | null; reload: () => void };
  onFirstBaseline: () => void;
}

const STATUSES: RunStatus[] = ['running', 'queued', 'succeeded', 'failed', 'cancelled'];

export function History({ runs, specs, load, onFirstBaseline }: Props) {
  const [filters, setFilters] = useState<HistoryFilters>(NO_HISTORY_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const [, navigate] = useLocation();
  const regressionPct = useCluster((s) => s.cluster?.settings.regression_pct ?? 5);
  const order = useCluster((s) => s.order);
  const byId = useMemo(() => new Map(specs.map((s) => [s.id, s])), [specs]);
  const shown = useMemo(() => filterRuns(runs, filters), [runs, filters]);
  const filtered = filters.bench !== '' || filters.node !== '' || filters.status !== '';
  const nodes = useMemo(() => [...new Set([...order, ...runs.flatMap((r) => r.nodes)])], [order, runs]);
  const benches = useMemo(() => [...new Set([...specs.map((s) => s.id), ...runs.map((r) => r.bench_id)])], [specs, runs]);
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const sel = selected.filter((id) => runs.some((r) => r.id === id));
  // Only runs of one benchmark compare: once one is ticked, the others' boxes are off.
  const selBench = runs.find((r) => r.id === sel[0])?.bench_id;

  const toggle = (id: string, on: boolean) => {
    setSelected((s) => (on ? [...s.filter((x) => x !== id), id].slice(-MAX_COMPARE) : s.filter((x) => x !== id)));
  };

  const columns: Column<BenchRun>[] = [
    {
      id: 'select',
      header: 'Compare',
      width: '4.5rem',
      render: (r) => (
        <input
          type="checkbox"
          className="bench-select"
          aria-label={`Select ${nameOf(r.bench_id)} run from ${formatDateTime(r.created_ts)} to compare`}
          title={selBench && r.bench_id !== selBench ? `Only ${nameOf(selBench)} runs can be compared with the ones ticked` : undefined}
          checked={sel.includes(r.id)}
          disabled={r.status !== 'succeeded' || r.id.startsWith('pending-') || (!!selBench && r.bench_id !== selBench)}
          onChange={(e) => { toggle(r.id, e.target.checked); }}
        />
      ),
    },
    {
      id: 'bench',
      header: 'Benchmark',
      sortValue: (r) => nameOf(r.bench_id),
      render: (r) => (
        <span className="bench-hist__bench">
          <Link href={runPath(r.id)} className="bench-hist__link">{nameOf(r.bench_id)}</Link>
          <span className="bench-hist__params">{paramsSummary(byId.get(r.bench_id), r.params, 2)}</span>
        </span>
      ),
    },
    { id: 'nodes', header: 'Nodes', sortValue: (r) => r.nodes.join(', '), render: (r) => nodesText(r.bench_id, r.nodes) },
    { id: 'status', header: 'Status', sortValue: (r) => STATUS_LOOK[r.status].label, render: (r) => <RunStatusPill status={r.status} size="sm" variant="inline" /> },
    {
      id: 'result',
      header: 'Headline result',
      align: 'end',
      sortValue: (r) => r.results[0]?.value ?? null,
      render: (r) =>
        r.status === 'succeeded' ? (
          <span className="bench-hist__result" title={headlineDetail(r.results)}>
            <span className="num">{headlineText(r.results)}</span>
            <span className="bench-hist__params">{headlineCaption(r.results)}</span>
          </span>
        ) : (
          <span className="t-tertiary">—</span>
        ),
    },
    {
      id: 'baseline',
      header: 'vs baseline',
      align: 'end',
      sortValue: (r) => baselineSummary(r.results, regressionPct)?.pct ?? null,
      render: (r) => (r.baseline_for ? <span className="bench-hist__is-baseline">Baseline</span> : <DeltaBadge delta={baselineSummary(r.results, regressionPct)} />),
    },
    { id: 'started', header: 'Started', align: 'end', sortValue: (r) => r.started_ts ?? r.created_ts, render: (r) => <time className="num bench-nowrap" dateTime={new Date((r.started_ts ?? r.created_ts) * 1000).toISOString()}>{formatDateTime(r.started_ts ?? r.created_ts)}</time> },
    { id: 'duration', header: 'Duration', align: 'end', sortValue: (r) => runDuration(r), render: (r) => <span className="num">{formatDuration(runDuration(r))}</span> },
  ];

  const compare = () => { navigate(`/benchmarks/compare?ids=${sel.map(encodeURIComponent).join(',')}`); };

  let body;
  if (load.state === 'loading' && !runs.length) body = <RowsSkeleton rows={4} />;
  else if (load.state === 'error' && !runs.length)
    body = <ProblemState compact message={load.problem?.message ?? 'Couldn’t load benchmark history'} cause={load.problem?.cause} fix={load.problem?.fix} onRetry={load.reload} />;
  else if (!runs.length)
    body = (
      <EmptyState icon={Gauge} title="No benchmark runs yet. Run your first baseline." action={<Button variant="primary" onClick={onFirstBaseline}>Configure GPU matmul…</Button>}>
        A baseline is the run later results are compared against, so a slowdown is flagged as a regression.
      </EmptyState>
    );
  else
    body = (
      <Table
        caption="Benchmark runs"
        columns={columns}
        rows={shown}
        rowKey={(r) => r.id}
        initialSort={{ id: 'started', dir: 'desc' }}
        empty={
          <span className="bench-hist__none">
            No runs match these filters.{' '}
            <Button size="sm" variant="ghost" icon={<FilterX />} onClick={() => { setFilters(NO_HISTORY_FILTERS); }}>Clear filters</Button>
          </span>
        }
      />
    );

  return (
    <Panel
      title="History"
      subtitle={runs.length ? `${shown.length} of ${runs.length} runs${sel.length ? ` · ${sel.length} selected` : ' · tick 2–4 runs to compare them'}` : undefined}
      flush={runs.length > 0}
      className="bench-hist"
      actions={
        runs.length ? (
          <div className="bench-hist__tools">
            <Select size="sm" aria-label="Filter by benchmark" value={filters.bench} onChange={(e) => { setFilters({ ...filters, bench: e.target.value }); }}>
              <option value="">All benchmarks</option>
              {benches.map((b) => <option key={b} value={b}>{nameOf(b)}</option>)}
            </Select>
            <Select size="sm" aria-label="Filter by node" value={filters.node} onChange={(e) => { setFilters({ ...filters, node: e.target.value }); }}>
              <option value="">All nodes</option>
              {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
            <Select size="sm" aria-label="Filter by status" value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value as RunStatus | '' }); }}>
              <option value="">Any status</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LOOK[s].label}</option>)}
            </Select>
            {filtered ? <Button size="sm" variant="ghost" icon={<FilterX />} onClick={() => { setFilters(NO_HISTORY_FILTERS); }}>Clear</Button> : null}
            <Button size="sm" variant={sel.length >= 2 ? 'primary' : 'secondary'} icon={<GitCompareArrows />} disabled={sel.length < 2} onClick={compare}>
              Compare{sel.length ? ` ${sel.length}` : ''}
            </Button>
          </div>
        ) : null
      }
    >
      {body}
    </Panel>
  );
}
