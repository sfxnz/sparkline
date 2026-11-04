import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchResult, BenchRun, NodeBenchState } from '../../lib/types';
import { useBench } from '../../store/bench';
import { result } from './fixtures';
import { RunView } from './RunView';
import { LIVE_4, llmRun, nodeState, showcaseDetail, showcaseRun } from './streams/fixtures';
import { evalRun, FIXTURES } from './tooleval/fixtures';

vi.mock('./RunChart', () => ({ RunChart: () => null }));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});
afterEach(() => {
  vi.unstubAllGlobals();
  useBench.setState({ runs: {} });
});

const show = (run: BenchRun) => {
  useBench.setState({ runs: { [run.id]: run } });
  return render(<RunView id={run.id} />);
};

const GB10 = { modelled_on: 'GB10' };
const STREAMS_NOTE = 'For ws1, token rates and timings are modelled on GB10, not measured.';
const TOOL_EVAL_NOTE = 'For ws1, timings and the Responsiveness and Deployability scores are modelled on GB10, not measured.';
const FOOTNOTE = 'For ws1, figures marked † are modelled on GB10, not measured.';

const row = (metric: string, label: string, unit: string, extras: Record<string, unknown>, better: BenchResult['better'] = 'higher') => result({ metric, label, value: 46.2, unit, better, node_id: 'ws1', extras });
const WS1_RESULTS = [
  row('decode_tok_s', 'Decode tokens/s per request', 'tok/s', { headline: true, ...GB10 }),
  row('ttft_p95_ms', 'Time to first token p95', 'ms', GB10, 'lower'),
  row('mem_used_delta_gib', 'System memory growth during run', 'GiB', {}, 'lower'),
];
const ws1State = (p: Partial<NodeBenchState>) => nodeState({ node_id: 'ws1', metadata: GB10, ...p });
const ws1Llm = (status: BenchRun['status']) =>
  llmRun({ status, nodes: ['ws1'], node_states: { ws1: ws1State({ status, live: LIVE_4 }) }, results: status === 'succeeded' ? WS1_RESULTS : [] });
function ws1Eval(): BenchRun {
  const r = evalRun({ id: 'te-ws1', status: 'succeeded', nodes: ['ws1'] });
  const st = r.node_states?.ws1 as NodeBenchState;
  return { ...r, node_states: { ws1: { ...st, metadata: GB10 } } };
}

const markedLabels = () =>
  within(screen.getByRole('region', { name: 'Results' }))
    .getAllByRole('row')
    .slice(1)
    .filter((tr) => tr.textContent.includes('†'))
    .map((tr) => tr.querySelector('.bench-res__metric > span')?.firstChild?.textContent);

describe('figures modelled on other hardware', () => {
  it('says so once above the streams while ws1 runs, and nowhere else yet', () => {
    show(ws1Llm('running'));
    expect(screen.getByText(STREAMS_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(FOOTNOTE)).toBeNull();
    expect(screen.getAllByText(/modelled on/)).toHaveLength(1);
  });

  it('notes the streams, marks exactly the modelled rows and headlines, and footnotes the mark on a finished ws1 run', () => {
    show(ws1Llm('succeeded'));
    expect(screen.getByText(STREAMS_NOTE)).toBeInTheDocument();
    const done = screen.getByRole('region', { name: 'Result' });
    expect(within(done).getByText(FOOTNOTE)).toBeInTheDocument();
    expect(within(done).getByText('Decode tokens/s per request', { exact: false })).toHaveTextContent(/^Decode tokens\/s per request†, modelled on GB10$/);
    const results = screen.getByRole('region', { name: 'Results' });
    expect(within(results).getByText(FOOTNOTE)).toBeInTheDocument();
    expect(markedLabels()).toEqual(['Decode tokens/s per request', 'Time to first token p95']);
    expect(within(results).getByRole('cell', { name: /^System memory growth during run/ })).not.toHaveTextContent('modelled');
    const meta = screen.getByRole('region', { name: 'Metadata' });
    expect(within(meta).getByText('Modelled on').nextElementSibling).toHaveTextContent('GB10');
  });

  it('notes the tool-calling evaluation on ws1', () => {
    show(ws1Eval());
    expect(screen.getByText(TOOL_EVAL_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(STREAMS_NOTE)).toBeNull();
  });

  it('keeps the note on a ws1 run cancelled before it had results', () => {
    show(ws1Llm('cancelled'));
    expect(screen.getByText(STREAMS_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Results' })).toBeNull();
  });

  it.each([
    ['a live sweep', () => llmRun({ live: LIVE_4 })],
    ['a finished run', () => llmRun({ status: 'succeeded', live: LIVE_4, results: WS1_RESULTS.map((r) => ({ ...r, node_id: 'spark1', extras: {} })) })],
    ['a showcase', () => showcaseRun({ status: 'succeeded', live: LIVE_4, detail: showcaseDetail(4) })],
    ['a tool-calling evaluation', () => FIXTURES.done()],
    ['a cancelled evaluation', () => FIXTURES.cancelled()],
  ])('adds nothing to %s on spark1', (_, make) => {
    const { container } = show(make());
    expect(screen.queryByText(/modelled/i)).toBeNull();
    expect(container.textContent).not.toContain('†');
  });
});
