// The llm-inference run's streams: while it runs, every request in flight as a live card (LivePanel, placeholders
// until the first snapshot); afterwards the concurrency sweep it measured, a timeline of every request and the last
// text of each stream. An llm-showcase run streams the same way and afterwards shows every stream's whole text instead
// (or, when the run recorded none, the last snapshot's). Runs without stream data (older runs and agents, or a run that failed before streaming) render
// nothing, and the run view's own panels explain them.
import { ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Panel } from '../../../design/components/Panel';
import { SegmentedControl } from '../../../design/components/SegmentedControl';
import type { BenchRun, BenchSpec, RunStatus } from '../../../lib/types';
import { isActive, llmLevels } from '../model';
import { Grid, LivePanel, LiveSkeleton } from './LivePanel';
import { cardState, densityFor, parseDetail, parseLive, parseShowcase, recordedLevels, streamNodes, textsOf, type LiveSnapshot } from './model';
import { ShowcaseOutputs } from './ShowcaseOutputs';
import { StreamCard, StreamDialog } from './StreamCard';
import { SweepPanel } from './SweepPanel';
import { TimelinePanel } from './TimelinePanel';
import './streams.css';

export function StreamsSection({ run }: { run: BenchRun; spec: BenchSpec | undefined }) {
  const nodes = streamNodes(run);
  const [picked, setPicked] = useState<string | null>(null);
  const node = picked !== null && nodes.includes(picked) ? picked : nodes[0];
  const state = node === undefined ? undefined : run.node_states?.[node];
  const liveRaw = state?.live;
  const detailRaw = state?.detail;
  const live = useMemo(() => parseLive(liveRaw), [liveRaw]);
  const detail = useMemo(() => parseDetail(detailRaw), [detailRaw]);
  const outputs = useMemo(() => parseShowcase(detailRaw), [detailRaw]);
  const showcase = run.bench_id === 'llm-showcase';
  const param = (k: string) => {
    const v = run.params[k];
    return typeof v === 'number' ? v : 1;
  };
  // A showcase runs `streams` requests at once, one per stream.
  const concurrency = param(showcase ? 'streams' : 'concurrency');
  const planned = live?.levels ?? llmLevels(concurrency, run.params.sweep === true);
  const requests = showcase ? concurrency : param('requests');
  const picker =
    nodes.length > 1 && node !== undefined ? (
      <SegmentedControl label="Node" size="sm" options={nodes.map((n) => ({ value: n, label: n }))} value={node} onChange={setPicked} />
    ) : null;

  if (isActive(run.status)) {
    if (live) return <LivePanel key={node} snap={live} requests={requests} actions={picker} />;
    // Placeholders only while the payload starts up (it reports streams as soon as requests go out, at progress
    // 0.05); an agent that sends no streams at all gets nothing here, and the progress panel covers its run.
    if (run.progress > 0.05) return null;
    const endpoint = typeof run.params.base_url === 'string' && run.params.base_url ? run.params.base_url : 'the endpoint';
    return <LiveSkeleton endpoint={endpoint} levels={planned} requests={requests} title={showcase ? 'Streams' : undefined} />;
  }
  if (showcase) {
    if (outputs?.streams.length) return <ShowcaseOutputs key={node} outputs={outputs} status={run.status} actions={picker} />;
    return live?.streams.length ? <FinalOutputs key={node} snap={live} status={run.status} sweep={false} actions={picker} /> : null;
  }
  if (!live && !detail) return null;

  const levels = recordedLevels(detail, live);
  const sweep = planned.length > 1 && levels.length > 0;
  const timelines = detail?.timelines ?? [];
  // The node picker rides on the first panel; the others follow it.
  return (
    <>
      {sweep ? <SweepPanel levels={levels} planned={planned} status={run.status} actions={picker} /> : null}
      {timelines.length ? <TimelinePanel timelines={timelines} actions={sweep ? null : picker} /> : null}
      {live?.streams.length ? <FinalOutputs key={node} snap={live} status={run.status} sweep={planned.length > 1} actions={sweep || timelines.length ? null : picker} /> : null}
    </>
  );
}

const ENDED: Partial<Record<RunStatus, string>> = { succeeded: 'finished', cancelled: 'was cancelled', failed: 'failed' };

/** The last snapshot's cards, static, behind a disclosure; streams cut off by a cancel or failure read "Stopped". */
function FinalOutputs({ snap, status, sweep, actions }: { snap: LiveSnapshot; status: RunStatus; sweep: boolean; actions: ReactNode }) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const texts = useMemo(() => textsOf(snap), [snap]);
  const n = snap.streams.length;
  const density = densityFor(n, 'auto');
  const opened = open === null ? undefined : snap.streams.find((s) => s.slot === open);
  return (
    <Panel
      title="Final outputs"
      subtitle={`The last text of each stream when the run ${ENDED[status] ?? 'ended'}${sweep ? ` · ${n} ${n === 1 ? 'stream' : 'streams'}` : ''}`}
      actions={actions}
      className="strm-outputs"
    >
      <details className="strm-outputs__details" open={shown} onToggle={(e) => { setShown(e.currentTarget.open); }}>
        <summary>
          <ChevronRight aria-hidden="true" />
          {shown ? 'Hide' : 'Show'} {n} {n === 1 ? 'stream' : 'streams'}
        </summary>
        {shown ? (
          <Grid density={density} count={n} label="Final outputs">
            {snap.streams.map((s) => (
              <StreamCard key={s.slot} stream={s} text={texts.get(s.slot)} state={cardState(s, false)} density={density} requests={snap.requests} showcase={snap.showcase} live={false} onOpen={setOpen} />
            ))}
          </Grid>
        ) : null}
      </details>
      {opened ? (
        <StreamDialog
          stream={opened}
          text={texts.get(opened.slot)}
          state={cardState(opened, false)}
          live={false}
          requests={snap.requests}
          showcase={snap.showcase}
          context="Final output"
          onClose={() => { setOpen(null); }}
        />
      ) : null}
    </Panel>
  );
}
