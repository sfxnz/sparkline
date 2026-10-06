// Data for the benchmark screens: the catalog, the run list, a single run (stream first, REST to fill in and as a
// fallback while the stream is quiet), and the optimistic start of a run.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, benchApi, problemOf } from '../../lib/api';
import type { BenchRun, BenchSpec, Problem } from '../../lib/types';
import { serverNow, useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { MAX_RUNS, useBench } from '../../store/bench';
import { isActive } from './model';

export type Load<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; problem: Problem };

// ------------------------------------------------------------------------------------------------ catalog

const CATALOG_REFRESH_MS = 15_000; // availability follows nodes going offline and coming back
let catalogCache: BenchSpec[] | null = null;

export function useCatalog(): { load: Load<BenchSpec[]>; reload: () => void } {
  const [load, setLoad] = useState<Load<BenchSpec[]>>(catalogCache ? { state: 'ready', data: catalogCache } : { state: 'loading' });
  const [nonce, setNonce] = useState(0);
  const live = useConnection((s) => s.status === 'live');
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      benchApi.catalog().then(
        (data) => {
          if (cancelled) return;
          catalogCache = data;
          setLoad({ state: 'ready', data });
        },
        (e: unknown) => {
          if (cancelled) return;
          // A failed refresh keeps the catalog on screen; only a first load shows the problem.
          setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'error', problem: problemOf(e, 'load the benchmark catalog') }));
        },
      );
    };
    fetchOnce();
    const t = setInterval(fetchOnce, CATALOG_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [nonce, live]);
  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    setNonce((n) => n + 1);
  }, []);
  return { load, reload };
}

// ------------------------------------------------------------------------------------------------ run list

let listLoaded = false;

/** Fill the bench store from GET /api/v1/bench/runs (again after every reconnect). */
export function useRunList(): { state: 'loading' | 'ready' | 'error'; problem: Problem | null; reload: () => void } {
  const [state, setState] = useState<{ state: 'loading' | 'ready' | 'error'; problem: Problem | null }>({ state: listLoaded ? 'ready' : 'loading', problem: null });
  const [nonce, setNonce] = useState(0);
  const live = useConnection((s) => s.status === 'live');
  useEffect(() => {
    if (!live && listLoaded) return;
    let cancelled = false;
    benchApi.runs({ limit: MAX_RUNS }).then(
      (runs) => {
        if (cancelled) return;
        useBench.getState().upsertMany(runs);
        listLoaded = true;
        setState({ state: 'ready', problem: null });
      },
      (e: unknown) => {
        if (cancelled) return;
        if (!listLoaded) setState({ state: 'error', problem: problemOf(e, 'load benchmark history') });
      },
    );
    return () => { cancelled = true; };
  }, [live, nonce]);
  const reload = useCallback(() => {
    setState({ state: 'loading', problem: null });
    setNonce((n) => n + 1);
  }, []);
  return { ...state, reload };
}

// ------------------------------------------------------------------------------------------------ one run

const POLL_MS = 3_000;

/**
 * A run from the store, fetched in full on open (the list omits per-node states) and polled while it is active
 * and the stream has said nothing for a while (a dropped socket must not freeze the progress bar).
 */
export function useRun(id: string): { run: BenchRun | undefined; missing: Problem | null; gone: boolean; refetch: () => void } {
  const run = useBench((s) => s.runs[id]);
  const [missing, setMissing] = useState<Problem | null>(null);
  const [gone, setGone] = useState(false); // the console answered 404: retrying cannot help
  const [nonce, setNonce] = useState(0);
  const pending = id.startsWith(PENDING_PREFIX);
  const active = run ? isActive(run.status) : true;

  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    let lastSeen = Date.now();
    let lastRun = useBench.getState().runs[id];
    const fetchOnce = () => {
      benchApi.run(id).then(
        (r) => {
          if (cancelled) return;
          setMissing(null);
          setGone(false);
          useBench.getState().upsert(r);
        },
        (e: unknown) => {
          if (cancelled) return;
          if (e instanceof ApiError && e.status === 404) {
            useBench.getState().remove(id);
            setGone(true);
            setMissing({ message: 'This benchmark run no longer exists', cause: 'It was deleted, or the link is from another console.', fix: 'Open the history to pick another run.' });
          } else if (!useBench.getState().runs[id]) setMissing(problemOf(e, 'load this benchmark run'));
        },
      );
    };
    fetchOnce();
    if (!active) return () => { cancelled = true; };
    const unsub = useBench.subscribe((s) => {
      if (s.runs[id] !== lastRun) {
        lastRun = s.runs[id];
        lastSeen = Date.now();
      }
    });
    const t = setInterval(() => {
      if (Date.now() - lastSeen >= POLL_MS) fetchOnce();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
      unsub();
    };
  }, [id, pending, active, nonce]);

  return { run, missing: run ? null : missing, gone: !run && (gone || pending), refetch: () => { setNonce((n) => n + 1); } };
}

// ------------------------------------------------------------------------------------------------ start a run

export const PENDING_PREFIX = 'pending-';
let pendingSeq = 0;

export const runPath = (id: string) => `/benchmarks/runs/${encodeURIComponent(id)}`;

/**
 * Optimistic start: a placeholder run appears at once (the caller navigates to it), the POST follows, and the
 * placeholder is swapped for the console's run, or turned into a failed run that says why.
 */
export function startRun(spec: BenchSpec, nodes: string[], params: Record<string, unknown>, onCreated: (pendingId: string, run: BenchRun) => void): string {
  const id = `${PENDING_PREFIX}${Date.now().toString(36)}${(pendingSeq++).toString(36)}`;
  const now = serverNow();
  const placeholder: BenchRun = {
    id,
    bench_id: spec.id,
    params,
    nodes,
    status: 'queued',
    created_ts: now,
    started_ts: null,
    finished_ts: null,
    progress: 0,
    phase: 'Starting…',
    results: [],
    series: {},
    metadata: {},
    error: null,
    log_tail: [],
    baseline_for: false,
    params_key: '',
    baseline_run_id: null,
  };
  useBench.getState().upsert(placeholder);
  benchApi.create({ bench_id: spec.id, nodes, params, confirm: true }).then(
    (run) => {
      useBench.getState().upsert(run);
      onCreated(id, run);
      useBench.getState().remove(id);
    },
    (e: unknown) => {
      const finished = serverNow();
      // Replace (not merge): the placeholder moves from queued to failed.
      useBench.setState((s) => ({ runs: { ...s.runs, [id]: { ...placeholder, status: 'failed', finished_ts: finished, phase: '', error: problemOf(e, `start ${spec.name}`) } } }));
    },
  );
  return id;
}

/** Ids of every node the console knows, in console order. */
export const useNodeOrder = () => useCluster((s) => s.order);
