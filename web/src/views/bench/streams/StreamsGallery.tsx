// Dev gallery block (src/dev/gallery.tsx; not part of the app): the streams view in every state, on fixtures and on
// simulated runs that update twice a second like the console. `?strm-freeze` holds the simulations still, for
// screenshots.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BenchRun } from '../../../lib/types';
import { asShowcase, LIVE_12, LIVE_32, LIVE_4, LLM_SPEC, llmRun, nodeState, SHOWCASE_LIVE_4, SHOWCASE_SPEC, showcaseDetail, showcaseParams, showcaseRun, simulate, snapshot, stream, type SimOptions } from './fixtures';
import { StreamsSection } from './StreamsSection';

const frozen = typeof location !== 'undefined' && new URLSearchParams(location.search).has('strm-freeze');
const params = (o: Partial<SimOptions>) => ({ base_url: 'http://10.20.20.48:8000', model: '', api: 'chat', prompt_tokens: 512, max_tokens: o.maxTokens ?? 128, concurrency: o.concurrency ?? 1, requests: o.requests ?? 8, sweep: o.sweep ?? false });

/** A run of these options, live: the snapshot `offset` seconds in, then advancing in real time (looping). `showcase`:
 * as an llm-showcase run (one request per stream, each with its prompt). */
function LiveSim({ opts, offset = 0, id, nodes = 1, showcase = false }: { opts: SimOptions; offset?: number; id: string; nodes?: number; showcase?: boolean }) {
  const sim = useMemo(() => simulate(opts), [opts]);
  const other = useMemo(() => simulate({ ...opts, seed: (opts.seed ?? 7) + 1 }), [opts]);
  const [t, setT] = useState(offset);
  useEffect(() => {
    if (frozen) return;
    const start = performance.now();
    const timer = setInterval(() => { setT(offset + (((performance.now() - start) / 1000) % Math.max(1, sim.duration - offset))); }, 500);
    return () => { clearInterval(timer); };
  }, [sim, offset]);
  const run = useMemo((): BenchRun => {
    if (showcase) {
      const live = sim.liveAt(t);
      const server = typeof live.tok_s === 'number' ? Math.round(live.tok_s * 10.4) / 10 : null;
      return showcaseRun({ id, params: showcaseParams(opts.concurrency, opts.maxTokens), live: asShowcase(live, server, (slot, req) => req + slot) });
    }
    const r = llmRun({ id, params: params(opts), live: sim.liveAt(t) });
    if (nodes < 2) return r;
    return { ...r, nodes: ['spark1', 'spark2'], node_states: { ...r.node_states, spark2: nodeState({ node_id: 'spark2', live: other.liveAt(t * 0.93) }) } };
  }, [id, opts, sim, other, t, nodes, showcase]);
  return <StreamsSection run={run} spec={showcase ? SHOWCASE_SPEC : LLM_SPEC} />;
}

const FOUR: SimOptions = { concurrency: 4, sweep: false, requests: 8, maxTokens: 160, reasoning: true, seed: 3 };
const TWELVE: SimOptions = { concurrency: 12, sweep: false, requests: 24, maxTokens: 128, seed: 5 };
const SWEEP: SimOptions = { concurrency: 32, sweep: true, requests: 8, maxTokens: 128, seed: 11 };
const SHOWCASE: SimOptions = { concurrency: 6, sweep: false, requests: 6, maxTokens: 256, seed: 9 };
const sweep = simulate(SWEEP);
/** A sweep whose first level failed outright (the rail must say so), now at level 3. */
const failedLevel = (() => {
  const live = sweep.liveAt((sweep.starts[2] ?? 0) + 2);
  const done = live.completed_levels as Record<string, unknown>[];
  return { ...live, completed_levels: [{ ...done[0], ok: 0, failed: 8, out_tok_s: null, decode_tok_s_p50: null, ttft_p50_ms: null, ttft_p95_ms: null }, ...done.slice(1)] };
})();
/** A sweep where every request failed (a wrong model name): every level recorded, nothing to chart. */
const allFailed = [1, 2, 4, 8].map((level) => ({ level, requests: Math.max(8, level), ok: 0, failed: Math.max(8, level), wall_s: 0.4, out_tok_s: null, decode_tok_s_p50: null, decode_tok_s_p10: null, itl_p50_ms: null, ttft_p50_ms: null, ttft_p95_ms: null, prefill_tok_s_p50: null, prompt_tokens: 0, completion_tokens: 0 }));

const RUNS = {
  connecting: llmRun({ id: 'g-wait', params: params({ concurrency: 8 }), progress: 0.02 }),
  connectingSweep: llmRun({ id: 'g-wait2', params: params({ concurrency: 24, sweep: true }), progress: 0 }),
  states4: llmRun({ id: 'g4', params: params({ concurrency: 4 }), live: LIVE_4 }),
  states12: llmRun({ id: 'g12', params: params({ concurrency: 12 }), live: LIVE_12 }),
  states32: llmRun({ id: 'g32', params: params({ concurrency: 32 }), live: LIVE_32 }),
  finished: llmRun({ id: 'g-done', status: 'succeeded', params: params(SWEEP), live: sweep.liveAt(sweep.duration), detail: sweep.detail() }),
  cancelled: llmRun({ id: 'g-stop', status: 'cancelled', params: params(SWEEP), live: sweep.liveAt((sweep.starts[3] ?? 0) + 1.4), detail: sweep.detail(3) }),
  failedLevel: llmRun({ id: 'g-flev', params: params(SWEEP), live: failedLevel }),
  allFailed: llmRun({
    id: 'g-fail',
    status: 'failed',
    params: params({ concurrency: 8, sweep: true }),
    live: snapshot(Array.from({ length: 8 }, (_, i) => stream(i, { state: 'error', tokens: 0, error: 'HTTP 404: the model `qwen3-32b` does not exist' })), { level: 8, levels: [1, 2, 4, 8], level_index: 3, requests: 8, done: 8, failed: 8 }),
    detail: { llm: { levels: allFailed, timeline: {} } },
  }),
  showcaseConnecting: showcaseRun({ id: 'g-sc-wait', params: showcaseParams(6), progress: 0.02 }),
  showcaseStates: showcaseRun({ id: 'g-sc4', live: SHOWCASE_LIVE_4 }),
  showcaseFinished: showcaseRun({ id: 'g-sc-done', status: 'succeeded', detail: showcaseDetail(4, { each: (slot) => (slot < 2 ? { think_chars: 420 } : {}) }) }),
  showcaseFailedOne: showcaseRun({
    id: 'g-sc-12',
    status: 'succeeded',
    params: showcaseParams(12),
    detail: showcaseDetail(12, { each: (slot) => (slot === 5 ? { state: 'error', error: 'HTTP 503: the engine is overloaded, try again later' } : {}), fill: { requested: true, applied: false }, truncated: true }),
  }),
  showcaseCancelled: showcaseRun({ id: 'g-sc-stop', status: 'cancelled', live: SHOWCASE_LIVE_4 }),
  single: llmRun({ id: 'g-one', status: 'succeeded', params: params({ concurrency: 4 }), live: simulate(FOUR).liveAt(simulate(FOUR).duration), detail: simulate(FOUR).detail() }),
};

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} style={{ display: 'grid', gap: 12 }}>
      <h3 className="t-eyebrow">{title}</h3>
      <div className="view">{children}</div>
    </section>
  );
}

export function StreamsGallery() {
  return (
    <div id="strm-gallery" style={{ display: 'grid', gap: 40, maxWidth: 1128 }}>
      <h2 className="t-title2">Concurrency streams</h2>
      <Block id="strm-live-4" title="Live · 4 streams, reasoning model"><LiveSim id="s4" opts={FOUR} offset={1.2} /></Block>
      <Block id="strm-live-12" title="Live · 12 streams"><LiveSim id="s12" opts={TWELVE} offset={2.5} /></Block>
      <Block id="strm-live-32" title="Live · sweep at 32 streams, two nodes"><LiveSim id="s32" opts={SWEEP} offset={(sweep.starts[5] ?? 0) + 2.2} nodes={2} /></Block>
      <Block id="strm-connecting" title="Before the first snapshot"><StreamsSection run={RUNS.connecting} spec={LLM_SPEC} /></Block>
      <Block id="strm-connecting-sweep" title="Before the first snapshot · sweep"><StreamsSection run={RUNS.connectingSweep} spec={LLM_SPEC} /></Block>
      <Block id="strm-states-4" title="States · waiting, decoding with reasoning, done"><StreamsSection run={RUNS.states4} spec={LLM_SPEC} /></Block>
      <Block id="strm-states-12" title="States · 12 streams, one failed"><StreamsSection run={RUNS.states12} spec={LLM_SPEC} /></Block>
      <Block id="strm-states-32" title="States · 32 streams"><StreamsSection run={RUNS.states32} spec={LLM_SPEC} /></Block>
      <Block id="strm-finished" title="Sweep finished"><StreamsSection run={RUNS.finished} spec={LLM_SPEC} /></Block>
      <Block id="strm-single" title="Single level finished"><StreamsSection run={RUNS.single} spec={LLM_SPEC} /></Block>
      <Block id="strm-cancelled" title="Sweep cancelled during level 4"><StreamsSection run={RUNS.cancelled} spec={LLM_SPEC} /></Block>
      <Block id="strm-failed-level" title="Live · a level where every request failed"><StreamsSection run={RUNS.failedLevel} spec={LLM_SPEC} /></Block>
      <Block id="strm-all-failed" title="Sweep failed · every request failed"><StreamsSection run={RUNS.allFailed} spec={LLM_SPEC} /></Block>
      <h2 className="t-title2">LLM showcase</h2>
      <Block id="strm-sc-live" title="Live · 6 prompts, server tokens/s"><LiveSim id="sc6" opts={SHOWCASE} offset={1.6} showcase /></Block>
      <Block id="strm-sc-connecting" title="Before the first snapshot"><StreamsSection run={RUNS.showcaseConnecting} spec={SHOWCASE_SPEC} /></Block>
      <Block id="strm-sc-states" title="States · waiting, decoding with reasoning, done"><StreamsSection run={RUNS.showcaseStates} spec={SHOWCASE_SPEC} /></Block>
      <Block id="strm-sc-finished" title="Finished · whole outputs, two with reasoning"><StreamsSection run={RUNS.showcaseFinished} spec={SHOWCASE_SPEC} /></Block>
      <Block id="strm-sc-12" title="Finished · 12 streams, one failed, fill rejected, shortened"><StreamsSection run={RUNS.showcaseFailedOne} spec={SHOWCASE_SPEC} /></Block>
      <Block id="strm-sc-cancelled" title="Cancelled before the outputs were recorded · last snapshot"><StreamsSection run={RUNS.showcaseCancelled} spec={SHOWCASE_SPEC} /></Block>
    </div>
  );
}
