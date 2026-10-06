// /benchmarks: what the suite is, any run in progress, the catalog, and the history of runs.
// "?configure=<bench_id>[&from=<run_id>]" opens the configure dialog (Run again, the empty state's first baseline).
import { ArrowRight } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { Panel } from '../../design/components/Panel';
import { ProblemState } from '../../design/components/ProblemState';
import { Skeleton } from '../../design/components/Skeleton';
import { useNow } from '../../design/useNow';
import type { BenchRun, BenchSpec } from '../../lib/types';
import { serverNow } from '../../store/cluster';
import { useBench } from '../../store/bench';
import { ConfigureDialog } from './ConfigureDialog';
import { Catalog } from './Catalog';
import { History } from './History';
import { runPath, startRun, useCatalog, useRunList } from './hooks';
import { aboutDuration, eta, isActive, nodesText, type ParamValues } from './model';
import { RunStatusPill } from './parts';

export function Home() {
  const { load, reload } = useCatalog();
  const list = useRunList();
  const runsMap = useBench((s) => s.runs);
  const runs = useMemo(() => Object.values(runsMap).sort((a, b) => b.created_ts - a.created_ts), [runsMap]);
  const specs = useMemo(() => (load.state === 'ready' ? load.data : []), [load]);
  const [location, navigate] = useLocation();
  const search = useSearch();
  const q = new URLSearchParams(search);
  const [picked, setPicked] = useState<{ spec: BenchSpec; key: number } | null>(null);

  // ?configure=<id>[&from=<run>] (Run again) opens the dialog as long as it is in the URL; closing drops it.
  const wantedSpec = specs.find((s) => s.id === q.get('configure'));
  const from: BenchRun | undefined = runsMap[q.get('from') ?? ''];
  const dialog = picked ?? (wantedSpec ? { spec: wantedSpec, from, key: `${wantedSpec.id}|${from?.id ?? ''}` } : null);
  const closeDialog = () => {
    setPicked(null);
    if (wantedSpec) navigate(location, { replace: true });
  };

  const latest = useMemo(() => {
    const out: Record<string, BenchRun | undefined> = {};
    for (const r of runs) out[r.bench_id] ??= r;
    return out;
  }, [runs]);
  const active = runs.filter((r) => isActive(r.status));

  const open = (spec: BenchSpec) => { setPicked({ spec, key: Date.now() }); };
  const run = (spec: BenchSpec, nodes: string[], params: ParamValues) => {
    const pendingId = startRun(spec, nodes, params, (pid, created) => {
      // Still looking at the placeholder: move to the real run without a history entry.
      if (window.location.pathname === runPath(pid)) navigate(runPath(created.id), { replace: true });
    });
    navigate(runPath(pendingId));
  };

  return (
    <div className="view bench-home">
      <header className="bench-intro">
        <p className="bench-intro__text">
          Whitelisted, parameter-checked benchmarks for the cluster. Each one says how long it takes and how hard it
          pushes the hardware, asks before it starts, shows live telemetry while it runs, and saves its results with
          driver, CUDA, clocks and temperatures so later runs can be compared against a baseline.
        </p>
      </header>

      {active.length ? <ActiveRuns runs={active} specs={specs} /> : null}

      {load.state === 'loading' ? (
        <CatalogSkeleton />
      ) : load.state === 'error' ? (
        <Panel label="Benchmark catalog">
          <ProblemState message={load.problem.message} cause={load.problem.cause} fix={load.problem.fix} onRetry={reload} as="h2" />
        </Panel>
      ) : (
        <Catalog specs={load.data} latest={latest} onConfigure={open} />
      )}

      <History
        runs={runs}
        specs={specs}
        load={list}
        onFirstBaseline={() => {
          const spec = specs.find((s) => s.id === 'gpu-matmul') ?? specs[0];
          if (spec) open(spec);
        }}
      />

      {dialog ? (
        <ConfigureDialog
          key={dialog.key}
          spec={dialog.spec}
          open
          initialParams={'from' in dialog && dialog.from?.bench_id === dialog.spec.id ? dialog.from.params : undefined}
          initialNodes={'from' in dialog ? dialog.from?.nodes : undefined}
          onClose={closeDialog}
          onRun={(nodes, params) => {
            setPicked(null);
            run(dialog.spec, nodes, params); // navigating to the run also drops any ?configure= query
          }}
        />
      ) : null}
    </div>
  );
}

function ActiveRuns({ runs, specs }: { runs: BenchRun[]; specs: readonly BenchSpec[] }) {
  useNow(1000); // elapsed / ETA tick
  return (
    <ul className="bench-active" aria-label="Runs in progress">
      {runs.map((r) => {
        const spec = specs.find((s) => s.id === r.bench_id);
        const left = eta(r, serverNow(), spec?.est_duration_s ?? 60);
        return (
          <li key={r.id}>
            <Link href={runPath(r.id)} className="bench-active__item material-regular">
              <RunStatusPill status={r.status} size="sm" />
              <span className="bench-active__name">{spec?.name ?? r.bench_id}</span>
              <span className="bench-active__where">on {nodesText(r.bench_id, r.nodes)}</span>
              <span className="bench-active__bar" aria-hidden="true"><span style={{ transform: `scaleX(${Math.min(1, Math.max(0, r.progress))})` }} /></span>
              <span className="bench-active__pct num">{Math.round(r.progress * 100)}%</span>
              <span className="bench-active__eta num">{left !== null ? `${aboutDuration(left).replace('≈ ', '')} left` : ''}</span>
              <ArrowRight className="bench-active__go" aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function CatalogSkeleton() {
  return (
    <div className="bench-catalog" aria-busy="true" aria-label="Loading the benchmark catalog">
      {[3, 2, 2].map((n, g) => (
        <section key={g} className="bench-group" style={{ '--n': n } as CSSProperties}>
          <Skeleton width={90} height={11} />
          <ul className="bench-group__cards">
            {Array.from({ length: n }, (_, i) => (
              <li key={i}>
                <div className="bench-card material-regular bench-card--skeleton">
                  <div className="bench-card__head"><Skeleton width={36} height={36} radius={10} /><div className="bench-card__titles"><Skeleton width="60%" height={15} /><Skeleton width="40%" height={11} /></div></div>
                  <Skeleton height={12} /><Skeleton width="80%" height={12} />
                  <Skeleton width="70%" height={22} radius={11} />
                  <Skeleton width="50%" height={12} /><Skeleton width="50%" height={12} />
                  <div className="bench-card__foot"><Skeleton width={90} height={12} /><Skeleton width={96} height={26} radius={8} /></div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
