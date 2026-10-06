import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../design/components/Button';
import { ConfirmDialog } from '../../design/components/Dialog';
import { Panel } from '../../design/components/Panel';
import type { Problem } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { historyCache } from '../../store/history';
import { api, problemOf } from '../../lib/api';
import { Banner, ProblemBanner } from '../alerts/parts/Banner';
import { RETENTION } from './model';
import { SettingRow } from './parts';

type Result = { node: string; ok: true; demo: boolean } | { node: string; ok: false; problem: Problem };

/** The consequences, stated plainly, for the confirmation dialog. */
export function clearConsequences(node: string): string[] {
  return [`Delete all stored history for ${node} (${RETENTION}).`, 'Leave live data unaffected.', 'Be permanent. This cannot be undone.'];
}

export function DataSection() {
  const order = useCluster((s) => s.order);
  const nodes = useCluster((s) => s.nodes);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const clear = async (node: string) => {
    setBusy(true);
    try {
      const r = await api.clearHistory(node);
      historyCache.clear(); // charts must not show the deleted ranges from cache
      setResult({ node, ok: true, demo: r.demo === true });
    } catch (e) {
      setResult({ node, ok: false, problem: problemOf(e, `clear the history of ${node}`) });
    } finally {
      setBusy(false);
      setTarget(null);
    }
  };

  return (
    <Panel title="Data" subtitle="Each node's agent keeps its own history on disk. Clearing it frees that space and resets charts for 5m–7d.">
      <div className="set-rows">
        {order.length === 0 ? <p className="t-callout t-secondary">No nodes are configured yet.</p> : null}
        {order.map((id) => {
          const st = nodes[id]?.status;
          const reachable = st === 'online' || st === 'stale';
          const r = result?.node === id ? result : null;
          return (
            <div key={id} className="set-node">
              <SettingRow
                id={`set-clear-${id}`}
                title={id}
                description={reachable ? `Stored history: ${RETENTION}.` : `${id} is ${st ?? 'not connected'}. Its history can be cleared once the agent is reachable.`}
              >
                <Button variant="destructive" size="sm" icon={<Trash2 />} disabled={!reachable || busy} onClick={() => { setResult(null); setTarget(id); }} aria-label={`Clear history for ${id}…`} aria-describedby={`set-clear-${id}-desc`}>
                  Clear history…
                </Button>
              </SettingRow>
              {r ? (
                r.ok ? (
                  <Banner
                    tone={r.demo ? 'stale' : 'ok'}
                    title={r.demo ? `Demo mode: nothing was deleted on ${id}` : `History cleared on ${id}`}
                    text={r.demo ? 'The simulated nodes have no stored history to delete. On real agents this removes the SQLite rollups.' : 'Charts for 5m to 7d start filling again from now. Live data was not affected.'}
                  />
                ) : (
                  <ProblemBanner problem={r.problem} />
                )
              ) : null}
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={target !== null}
        title={`Clear history for ${target ?? ''}?`}
        consequences={target ? clearConsequences(target) : []}
        confirmLabel="Clear history"
        destructive
        confirmPhrase={target ?? undefined}
        busy={busy}
        onCancel={() => { if (!busy) setTarget(null); }}
        onConfirm={() => { if (target) void clear(target); }}
      />
    </Panel>
  );
}
