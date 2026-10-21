// The tool-eval run's evaluation, the hero of its run page: while it runs, the score so far, the scenario running now
// and the board of every scenario; afterwards, the score with its rating, the score per category and every
// scenario's verdict, criteria and trace. Reads run.node_states[node].live/detail (null for runs without them).
import { useMemo, useState } from 'react';
import { Panel } from '../../../design/components/Panel';
import { SegmentedControl } from '../../../design/components/SegmentedControl';
import type { BenchRun, BenchSpec } from '../../../lib/types';
import { isActive } from '../model';
import { LiveView, WaitingView } from './Live';
import { evalNodes, subtitle, viewKind, type NodeEval } from './model';
import { ScenarioDialog, ScenariosPanel } from './Scenarios';
import { CategoryPanel, DoneView, StoppedView } from './Summary';

const TITLE = 'Tool-calling evaluation';

const param = (run: BenchRun, name: string): unknown => run.params[name];

/** "tool-eval-bench 2.8.0 · Standard 69 · thinking on · Qwen3-8B" from whatever this run has. */
function headline(run: BenchRun, ev: NodeEval | undefined): string {
  const s = ev?.summary;
  const l = ev?.live;
  const suite = s?.suite || l?.suite || (typeof param(run, 'suite') === 'string' ? String(param(run, 'suite')) : '');
  const thinking = s?.thinking ?? l?.thinking ?? (typeof param(run, 'thinking') === 'boolean' ? Boolean(param(run, 'thinking')) : null);
  const model = s?.model || l?.model || (typeof param(run, 'model') === 'string' ? String(param(run, 'model')) : '');
  return subtitle({ version: s?.version || l?.version || '', suite, total: l?.total ?? 0, thinking, model });
}

export function ToolEvalSection({ run, spec }: { run: BenchRun; spec: BenchSpec | undefined }) {
  // Only nodes with something to show: one that failed before finishing a scenario must not hide the others.
  const evals = useMemo(() => evalNodes(run).filter((e) => viewKind(run.status, e) !== null), [run]);
  const [node, setNode] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const active = isActive(run.status);

  // The count-up and the spoken result play only for a run seen running here, not for one opened afterwards. Set
  // during render, so the result view mounts already knowing it.
  const [sawRunning, setSawRunning] = useState(active);
  if (active && !sawRunning) setSawRunning(true);

  const ev = evals.find((e) => e.node === node) ?? evals[0];
  if (!ev) {
    if (!active) return null;
    const url = param(run, 'base_url');
    const fallback = spec?.params.find((p) => p.name === 'base_url')?.default;
    const endpoint = typeof url === 'string' && url ? url : typeof fallback === 'string' && fallback ? fallback : 'the endpoint';
    return (
      <Panel title={TITLE} subtitle={headline(run, undefined)} busy>
        <WaitingView run={run} endpoint={endpoint} />
      </Panel>
    );
  }
  const kind = viewKind(run.status, ev);

  const picker =
    evals.length > 1 ? (
      <SegmentedControl
        size="sm"
        label="Node"
        value={ev.node}
        onChange={(n) => {
          setNode(n);
          setOpenId(null);
        }}
        options={evals.map((e) => ({ value: e.node, label: e.node }))}
      />
    ) : undefined;
  // First in every branch, so an open dialog survives the run moving from live to done or stopped.
  const dialog = <ScenarioDialog record={ev.records.find((r) => r.id === openId) ?? null} onClose={() => { setOpenId(null); }} />;
  const sub = headline(run, ev);

  if (kind === 'live') {
    return (
      <>
        {dialog}
        <Panel title={TITLE} subtitle={sub} actions={picker} busy={!ev.live}>
          {/* Keyed per node: a milestone already passed on one node is never announced again on another. */}
          {ev.live ? <LiveView key={ev.node} ev={ev} live={ev.live} onOpen={setOpenId} /> : <WaitingView run={run} endpoint="the endpoint" message="Waiting for the next update…" />}
        </Panel>
      </>
    );
  }
  if (kind === 'done' && ev.summary) {
    return (
      <>
        {dialog}
        <Panel title={TITLE} subtitle={sub} actions={picker}>
          <DoneView run={run} ev={ev} summary={ev.summary} countUp={sawRunning && run.status === 'succeeded'} />
        </Panel>
        <CategoryPanel summary={ev.summary} />
        <ScenariosPanel records={ev.records} total={ev.records.length} onOpen={setOpenId} />
      </>
    );
  }
  return (
    <>
      {dialog}
      <Panel title={TITLE} subtitle={sub} actions={picker}>
        <StoppedView run={run} ev={ev} onOpen={setOpenId} />
      </Panel>
      {ev.records.length ? <ScenariosPanel records={ev.records} total={Math.max(ev.live?.total ?? 0, ev.records.length)} incomplete onOpen={setOpenId} /> : null}
    </>
  );
}
