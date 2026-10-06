// Benchmark runs from the stream ('bench' messages) and REST, merged by id. Bounded: the newest MAX_RUNS are kept
// (queued/running runs are never evicted). Kept small: this module is in the main bundle because the session
// dispatches stream messages into it; everything else bench-related lives in the lazy benchmarks chunk.
import { create } from 'zustand';
import type { BenchRun, RunStatus } from '../lib/types';

export const MAX_RUNS = 200;

const RANK: Record<RunStatus, number> = { queued: 0, running: 1, succeeded: 2, failed: 2, cancelled: 2 };

/**
 * Merge an incoming copy of a run over the one held. A copy that is behind (a REST list fetched before the stream
 * reported the run finished) never moves a run backwards, and a list copy (no node_states) keeps the known ones.
 */
export function mergeRun(prev: BenchRun | undefined, next: BenchRun): BenchRun {
  if (!prev) return next;
  if (RANK[next.status] < RANK[prev.status]) return prev;
  const states = next.node_states && Object.keys(next.node_states).length ? next.node_states : prev.node_states;
  // Lists and live updates leave out the recorded telemetry ("telemetry.*" series): keep what a full copy brought.
  const keys = Object.keys(next.series);
  const series = keys.some((k) => k.startsWith('telemetry.')) ? next.series : { ...Object.fromEntries(Object.entries(prev.series).filter(([k]) => k.startsWith('telemetry.'))), ...next.series };
  return { ...next, node_states: states, series };
}

export function boundRuns(runs: Record<string, BenchRun>, max = MAX_RUNS): Record<string, BenchRun> {
  const all = Object.values(runs);
  if (all.length <= max) return runs;
  const done = all.filter((r) => RANK[r.status] === 2).sort((a, b) => a.created_ts - b.created_ts);
  const drop = new Set(done.slice(0, all.length - max).map((r) => r.id));
  return Object.fromEntries(all.filter((r) => !drop.has(r.id)).map((r) => [r.id, r]));
}

interface BenchStore {
  runs: Record<string, BenchRun>;
  upsert: (run: BenchRun) => void;
  upsertMany: (runs: readonly BenchRun[]) => void;
  remove: (id: string) => void;
}

export const useBench = create<BenchStore>()((set) => ({
  runs: {},
  upsert: (run) => {
    set((s) => ({ runs: boundRuns({ ...s.runs, [run.id]: mergeRun(s.runs[run.id], run) }) }));
  },
  upsertMany: (list) => {
    set((s) => {
      const runs = { ...s.runs };
      for (const r of list) runs[r.id] = mergeRun(runs[r.id], r);
      return { runs: boundRuns(runs) };
    });
  },
  remove: (id) => {
    set((s) => {
      if (!(id in s.runs)) return s;
      return { runs: Object.fromEntries(Object.entries(s.runs).filter(([k]) => k !== id)) };
    });
  },
}));
