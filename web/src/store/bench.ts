// Benchmark runs streamed over the WebSocket. The benchmarks phase builds on this.
import { create } from 'zustand';
import type { BenchRun } from '../lib/types';

interface BenchStore {
  runs: Record<string, BenchRun>;
  upsert: (run: BenchRun) => void;
}

export const useBench = create<BenchStore>()((set) => ({
  runs: {},
  upsert: (run) => {
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
  },
}));
