import { create } from 'zustand';
import type { ClusterState, ConsoleSettings, NodeState, Onboarding } from '../lib/types';

interface ClusterStore {
  cluster: ClusterState | null;
  /** Node ids in console order. */
  order: string[];
  nodes: Record<string, NodeState>;
  /** server_time - local time at hello, in seconds (charts use it to place "now"). */
  clockOffset: number;
  /** The console's first-run state. null before the first hello, and from a console that has none (before 0.3.0). */
  onboarding: Onboarding | null;
  setHello: (c: ClusterState) => void;
  setNode: (n: NodeState) => void;
  setSettings: (settings: ConsoleSettings) => void;
  setOnboarding: (onboarding: Onboarding) => void;
}

export const useCluster = create<ClusterStore>()((set) => ({
  cluster: null,
  order: [],
  nodes: {},
  clockOffset: 0,
  onboarding: null,
  setHello: (c) => {
    set({
      cluster: c,
      order: c.nodes.map((n) => n.node_id),
      nodes: Object.fromEntries(c.nodes.map((n) => [n.node_id, n])),
      clockOffset: c.server_time - Date.now() / 1000,
      onboarding: c.onboarding ?? null,
    });
  },
  setNode: (n) => {
    set((s) => ({
      nodes: { ...s.nodes, [n.node_id]: n },
      order: s.order.includes(n.node_id) ? s.order : [...s.order, n.node_id],
    }));
  },
  setSettings: (settings) => {
    set((s) => (s.cluster ? { cluster: { ...s.cluster, settings } } : {}));
  },
  setOnboarding: (onboarding) => {
    set({ onboarding });
  },
}));

/** Console-side "now" in epoch seconds. */
export const serverNow = () => Date.now() / 1000 + useCluster.getState().clockOffset;
