// Data for the Recommendations page: the console's answer, refreshed every 15 s, and one click's journey
// (the request, then a 1 s poll until the node's state changes or its helper reports a failure).
import { useCallback, useEffect, useRef, useState } from 'react';
import { problemOf, recommendApi } from '../../lib/api';
import type { NodeRecState, Problem, Recommendation, RecommendationsView } from '../../lib/types';
import type { Load } from '../bench/hooks';
import { settled, type Verb } from './model';

const POLL_MS = 15_000;
const SETTLE_POLL_MS = 1_000;
const SETTLE_TRIES = 30;

/** What a click is doing on one row, or why it did not work. */
export type RowStatus = { pending: Verb } | { problem: Problem };

export const rowKey = (node: string, id: string) => `${node}\n${id}`;

export function useRecommendations() {
  const [load, setLoad] = useState<Load<RecommendationsView>>({ state: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [rows, setRows] = useState<Record<string, RowStatus | null>>({});
  const alive = useRef(true);

  const refresh = useCallback(
    () =>
      recommendApi.view().then(
        (data) => {
          if (alive.current) setLoad({ state: 'ready', data });
          return data;
        },
        (e: unknown) => {
          // A failed refresh keeps the page on screen; only a first load shows the problem.
          if (alive.current) setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'error', problem: problemOf(e, 'load the recommendations') }));
          return null;
        },
      ),
    [],
  );

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, nonce]);

  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    setNonce((n) => n + 1);
  }, []);

  /** `before` is the row as the reader saw it when they confirmed. */
  const change = useCallback(
    async (rec: Recommendation, node: string, before: NodeRecState, verb: Verb) => {
      const set = (status: RowStatus | null) => {
        if (alive.current) setRows((r) => ({ ...r, [rowKey(node, rec.id)]: status }));
      };
      set({ pending: verb });
      try {
        await recommendApi.change(rec.id, verb, node);
      } catch (e) {
        set({ problem: problemOf(e, `${verb} ${rec.title} on ${node}`) });
        return;
      }
      for (let i = 0; i < SETTLE_TRIES && alive.current; i++) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
        const view = await refresh();
        if (settled(before, view?.nodes[node]?.items.find((item) => item.id === rec.id))) {
          set(null);
          return;
        }
      }
      set({
        problem: {
          message: `${node} has not reported a change after ${SETTLE_TRIES} seconds`,
          cause: 'The node accepted the request, and the setting still reads as it did before.',
          fix: `Check \`journalctl -u sparkline-tune\` on ${node}`,
        },
      });
    },
    [refresh],
  );

  return { load, reload, rows, change };
}
