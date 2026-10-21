import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announcer } from '../../../design/components/LiveAnnouncer';
import type { BenchRun } from '../../../lib/types';
import { LIVE_12, LIVE_32, LIVE_4, LLM_SPEC, llmRun, nodeState, simulate, snapshot, stream, type StreamInit } from './fixtures';
import { StreamsSection } from './StreamsSection';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

const params = (concurrency: number, sweep = false) => ({ base_url: 'http://10.20.20.48:8000', model: '', api: 'chat', prompt_tokens: 512, max_tokens: 128, concurrency, requests: 8, sweep });
const show = (run: BenchRun) => render(<StreamsSection run={run} spec={LLM_SPEC} />);
const cards = () => within(screen.getByRole('list', { name: /^Streams:/ })).getAllByRole('button');

describe('StreamsSection', () => {
  it('renders nothing for runs without stream data (older runs, a failure before streaming)', () => {
    expect(show(llmRun({ status: 'succeeded' })).container).toBeEmptyDOMElement();
    expect(show(llmRun({ status: 'failed' })).container).toBeEmptyDOMElement();
    expect(show(llmRun({ status: 'succeeded', live: { kind: 'tool-eval' } })).container).toBeEmptyDOMElement();
  });

  it('shows the planned grid as placeholders until the first snapshot, never an empty box', () => {
    const { container, unmount } = show(llmRun({ params: params(8), progress: 0.02 }));
    const panel = screen.getByRole('region', { name: 'Concurrency streams' });
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(within(panel).getByText('Connecting to http://10.20.20.48:8000…')).toBeInTheDocument();
    expect(container.querySelectorAll('.strm-card.is-skeleton')).toHaveLength(8);
    unmount();
    // A sweep starts with one stream, and every level is already on the rail.
    const sweep = show(llmRun({ params: params(24, true), progress: 0 }));
    expect(sweep.container.querySelectorAll('.strm-card.is-skeleton')).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: 'Concurrency levels' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'To come: 1 stream8 requests',
      'To come: 2 streams8 requests',
      'To come: 4 streams8 requests',
      'To come: 8 streams8 requests',
      'To come: 16 streams16 requests',
      'To come: 24 streams24 requests',
    ]);
  });

  it('drops the placeholders once the run is past start-up without streams (an agent that never sends them)', () => {
    expect(show(llmRun({ params: params(8), progress: 0.6 })).container).toBeEmptyDOMElement();
  });

  it('shows every stream as a labelled card: state as icon and word, live rate, text, tokens', () => {
    const { container, rerender } = show(llmRun({ params: params(4), live: LIVE_4 }));
    expect(screen.getByRole('region', { name: 'Concurrency streams' })).toHaveTextContent('4 streams in flight');
    const list = cards();
    const names = ['Stream #01: decoding, request 1 of 8', 'Stream #02: decoding, request 2 of 8', 'Stream #03: waiting, request 5 of 8', 'Stream #04: done, request 4 of 8'];
    expect(list.map((b) => b.getAttribute('aria-label'))).toEqual(names);
    // The live numbers are visible text; the name stays put as they change, so a focused card is not re-read.
    expect(list[0]).toHaveTextContent('46.8');
    expect(list[0]).toHaveTextContent('61 / 128');
    const next = { ...LIVE_4, streams: (LIVE_4.streams as Record<string, unknown>[]).map((x, i) => (i === 0 ? { ...x, tokens: 70, tok_s: 45.2 } : x)) };
    rerender(<StreamsSection run={llmRun({ params: params(4), live: next })} spec={LLM_SPEC} />);
    expect(cards()[0]).toHaveTextContent('70 / 128');
    expect(cards().map((b) => b.getAttribute('aria-label'))).toEqual(names);
    expect(within(list[0] as HTMLElement).getByText('Decoding')).toBeInTheDocument();
    expect(within(list[0] as HTMLElement).getByText('Thinking')).toBeInTheDocument();
    expect(within(list[2] as HTMLElement).getByText(/Waiting for first token/)).toBeInTheDocument();
    expect(within(list[3] as HTMLElement).getByText('Done')).toBeInTheDocument();
    for (const body of container.querySelectorAll('.strm-body:not(.strm-body--wait)')) expect(body).toHaveAttribute('aria-live', 'off');
    expect(container.querySelector('.strm-card--large')).not.toBeNull();
    // The aggregate output leads, with what it measures; requests count finished ones, failed or not.
    expect(screen.getByText('Aggregate output')).toBeInTheDocument();
    expect(screen.getByText(/All streams over the last 2 s/)).toBeInTheDocument();
    expect(screen.getByText('2 decoding, 1 waiting, 1 done')).toBeInTheDocument();
  });

  it('shows a failed stream’s message, and sizes cards by the stream count unless the viewer picks', () => {
    const r12 = show(llmRun({ params: params(12), live: LIVE_12 }));
    expect(screen.getByText('HTTP 503: the engine is overloaded, try again later')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    expect(r12.container.querySelectorAll('.strm-card--medium')).toHaveLength(12);
    fireEvent.click(screen.getByRole('radio', { name: /^Compact/ }));
    expect(r12.container.querySelectorAll('.strm-card--compact')).toHaveLength(12);
    r12.unmount();
    const r32 = show(llmRun({ params: params(32), live: LIVE_32 }));
    expect(r32.container.querySelectorAll('.strm-card--compact')).toHaveLength(32);
    expect(screen.getAllByText(/^Waiting ·/)).toHaveLength(3); // one line: the short form
    expect(screen.getByRole('radio', { name: /^Compact/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /^Text/ }));
    expect(r32.container.querySelectorAll('.strm-card--medium')).toHaveLength(32);
    r32.unmount();
    // A one-line card whose request failed before any text shows the failure itself.
    show(llmRun({ params: params(16), live: snapshot(Array.from({ length: 16 }, (_, i) => stream(i, i === 0 ? { state: 'error', error: 'HTTP 404: model not found' } : { state: 'decode', tokens: 9 }))) }));
    expect(cards()[0]).toHaveTextContent('HTTP 404: model not found');
  });

  it('types exactly the characters each snapshot appends', async () => {
    const at = (chars: number) => snapshot([stream(0, { state: 'decode', tokens: 20, chars })]);
    const { container, rerender } = show(llmRun({ params: params(1), live: at(60) }));
    const answer = () => container.querySelector('.strm-answer')?.textContent ?? '';
    const before = answer();
    expect(before).toHaveLength(60);
    rerender(<StreamsSection run={llmRun({ params: params(1), live: at(90) })} spec={LLM_SPEC} />);
    expect(answer().length).toBeLessThan(90); // still typing
    await waitFor(() => { expect(answer()).toHaveLength(90); }, { timeout: 3000 });
    expect(answer().startsWith(before)).toBe(true);
  });

  it('types a request’s first characters too: when it starts decoding, and when its answer starts after reasoning', async () => {
    const at = (p: StreamInit) => llmRun({ params: params(1), live: snapshot([stream(0, p)]) });
    const { container, rerender } = show(at({ state: 'wait', req: 1, elapsed_ms: 300 }));
    rerender(<StreamsSection run={at({ state: 'decode', req: 1, tokens: 15, chars: 60 })} spec={LLM_SPEC} />);
    const answer = () => container.querySelector('.strm-answer')?.textContent ?? '';
    expect(answer().length).toBeLessThan(60); // typing in, not all at once
    await waitFor(() => { expect(answer()).toHaveLength(60); }, { timeout: 3000 });

    rerender(<StreamsSection run={at({ state: 'decode', req: 2, tokens: 12, think_chars: 50, chars: 0 })} spec={LLM_SPEC} />);
    await waitFor(() => { expect(container.querySelector('.strm-think')).toHaveTextContent(/.{50}$/); }, { timeout: 3000 });
    expect(container.querySelector('.strm-answer')).toBeNull();
    rerender(<StreamsSection run={at({ state: 'decode', req: 2, tokens: 20, think_chars: 50, chars: 40 })} spec={LLM_SPEC} />);
    expect(answer().length).toBeLessThan(40);
    await waitFor(() => { expect(answer()).toHaveLength(40); }, { timeout: 3000 });
  });

  it('opens a stream large in a dialog that stays live', () => {
    const { rerender } = show(llmRun({ params: params(4), live: LIVE_4 }));
    fireEvent.click(cards()[0] as HTMLElement);
    const dialog = screen.getByRole('dialog', { name: 'Stream #01' });
    expect(dialog).toHaveTextContent('Request 1 of 8 · 4 streams');
    expect(dialog).toHaveTextContent('61 of 128');
    const next = { ...LIVE_4, streams: (LIVE_4.streams as Record<string, unknown>[]).map((s, i) => (i === 0 ? { ...s, tokens: 70 } : s)) };
    rerender(<StreamsSection run={llmRun({ params: params(4), live: next })} spec={LLM_SPEC} />);
    expect(screen.getByRole('dialog', { name: 'Stream #01' })).toHaveTextContent('70 of 128');
  });

  it('puts every level of a sweep on a rail and announces a new level once', () => {
    const spy = vi.spyOn(announcer, 'announce').mockImplementation(() => undefined);
    const sim = simulate({ concurrency: 8, sweep: true, requests: 8, maxTokens: 64 });
    const run = (t: number) => llmRun({ params: params(8, true), live: sim.liveAt(t) });
    const { rerender } = show(run((sim.starts[2] ?? 0) + 0.6));
    const steps = within(screen.getByRole('list', { name: 'Concurrency levels' })).getAllByRole('listitem');
    expect(steps.map((s) => s.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(steps[0]).toHaveTextContent(/^Finished: 1 stream[\d.]+ tok\/s$/);
    expect(steps[3]).toHaveTextContent('To come: 8 streams8 requests');
    expect(screen.getByRole('region', { name: 'Concurrency streams' })).toHaveTextContent('4 streams in flight · level 3 of 4');
    expect(spy).not.toHaveBeenCalled(); // not on first sight
    rerender(<StreamsSection run={run((sim.starts[3] ?? 0) + 0.6)} spec={LLM_SPEC} />);
    rerender(<StreamsSection run={run((sim.starts[3] ?? 0) + 1.1)} spec={LLM_SPEC} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Level 4 of 4: 8 streams', 'warning');
    spy.mockRestore();
  });

  it('marks a level where every request failed as failed on the rail, not finished', () => {
    const live = snapshot([stream(0, { state: 'decode', tokens: 5 }), stream(1, { state: 'wait' })], {
      level: 2,
      levels: [1, 2, 4],
      level_index: 1,
      completed_levels: [{ level: 1, requests: 8, ok: 0, failed: 8, out_tok_s: null }],
    });
    show(llmRun({ params: params(4, true), live }));
    const [first] = within(screen.getByRole('list', { name: 'Concurrency levels' })).getAllByRole('listitem');
    expect(first).toHaveTextContent('Failed: 1 stream8 failed');
    expect(first).toHaveClass('tone-crit');
  });

  it('lets the viewer pick the node when several stream', () => {
    const base = llmRun({ params: params(4), live: LIVE_4 });
    const two: BenchRun = { ...base, nodes: ['spark1', 'spark2'], node_states: { ...base.node_states, spark2: nodeState({ node_id: 'spark2', live: LIVE_12 }) } };
    show(two);
    expect(cards()).toHaveLength(4);
    fireEvent.click(screen.getByRole('radio', { name: 'spark2' }));
    expect(cards()).toHaveLength(12);
  });
});

describe('after the run', () => {
  const sim = simulate({ concurrency: 32, sweep: true, requests: 8, maxTokens: 64, seed: 11 });

  it('compares the sweep’s levels in small multiples and a table, the peak level marked', () => {
    show(llmRun({ status: 'succeeded', params: params(32, true), live: sim.liveAt(sim.duration), detail: sim.detail() }));
    expect(screen.queryByRole('region', { name: 'Concurrency streams' })).toBeNull();
    const sweep = screen.getByRole('region', { name: 'Concurrency sweep' });
    expect(within(sweep).getAllByRole('img').map((c) => c.getAttribute('aria-label')?.split(':')[0])).toEqual(['Output tokens/s', 'Decode tokens/s per request', 'Time to first token']);
    const table = within(sweep).getByRole('table', { name: 'Concurrency sweep, one row per level' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent.replace('Peak', ''))).toEqual(['1', '2', '4', '8', '16', '32']);
    expect(within(table).getAllByText('Peak')).toHaveLength(1);
    expect(within(table).getByRole('columnheader', { name: /Scaling efficiency/ })).toBeInTheDocument();
    expect(sweep).toHaveTextContent(/6 levels · output peaked at \d+ streams/);
  });

  it('draws every request of a level on a lane per stream, with a level picker and a data table', () => {
    show(llmRun({ status: 'succeeded', params: params(32, true), live: sim.liveAt(sim.duration), detail: sim.detail() }));
    const tl = screen.getByRole('region', { name: 'Stream timeline' });
    expect(within(tl).getByRole('img', { name: /^Stream timeline, 32 streams, 32 requests/ })).toBeInTheDocument();
    fireEvent.click(within(tl).getByRole('radio', { name: '8 streams' }));
    expect(within(tl).getByRole('img', { name: /^Stream timeline, 8 streams, 8 requests/ })).toBeInTheDocument();
    fireEvent.click(within(tl).getByRole('button', { name: 'Stream timeline: data table' }));
    expect(within(within(tl).getByRole('table', { name: 'Requests at 8 streams' })).getAllByRole('row')).toHaveLength(9);
  });

  it('keeps the final outputs behind a disclosure; a cancelled run’s streams read as stopped', async () => {
    show(llmRun({ status: 'cancelled', params: params(32, true), live: sim.liveAt((sim.starts[3] ?? 0) + 0.8), detail: sim.detail(3) }));
    expect(screen.getByRole('region', { name: 'Concurrency sweep' })).toHaveTextContent('Stopped during level 4 of 6 · 3 levels recorded');
    expect(within(screen.getByRole('region', { name: 'Stream timeline' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['1', '2', '4']);
    const outputs = screen.getByRole('region', { name: 'Final outputs' });
    expect(outputs).toHaveTextContent('The last text of each stream when the run was cancelled');
    expect(within(outputs).queryAllByRole('button')).toHaveLength(0);
    fireEvent.click(within(outputs).getByText('Show 8 streams'));
    await waitFor(() => { expect(within(outputs).getByText('Hide 8 streams')).toBeInTheDocument(); }); // the toggle event is async
    const stopped = within(outputs).getAllByRole('button').filter((b) => /: stopped/.test(b.getAttribute('aria-label') ?? ''));
    expect(stopped.length).toBeGreaterThan(0);
    expect(within(outputs).getAllByText('Stopped').length).toBe(stopped.length);
    // A stream stopped while it waited says so, rather than showing an empty box.
    const waited = stopped.find((card) => !card.querySelector('.strm-flow'));
    if (waited) expect(waited).toHaveTextContent('Stopped before the first token');
    fireEvent.click(stopped[0] as HTMLElement);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Last speed');
    expect(dialog).not.toHaveTextContent('Speed now');
  });

  it('says when every request of a sweep failed, instead of drawing empty charts', () => {
    const levels = [1, 2, 4, 8].map((level) => ({ level, requests: Math.max(8, level), ok: 0, failed: Math.max(8, level), out_tok_s: null, decode_tok_s_p50: null, ttft_p50_ms: null, ttft_p95_ms: null }));
    const live = snapshot([stream(0, { state: 'error', error: 'HTTP 404: model not found' })], { level: 8, levels: [1, 2, 4, 8], level_index: 3 });
    show(llmRun({ status: 'failed', params: params(8, true), live, detail: { llm: { levels, timeline: {} } } }));
    const sweep = screen.getByRole('region', { name: 'Concurrency sweep' });
    expect(sweep).toHaveTextContent('4 levels · every request failed');
    expect(sweep).not.toHaveTextContent('Stopped during');
    expect(within(sweep).queryAllByRole('img')).toHaveLength(0);
    expect(sweep).toHaveTextContent('No request at any level produced a token, so there are no speeds or times to chart.');
    expect(within(sweep).getAllByText(/· 8 failed/)).toHaveLength(4);
  });

  it('shows a single-level run’s timeline and outputs, without a sweep panel', () => {
    const one = simulate({ concurrency: 4, sweep: false, requests: 8, maxTokens: 64 });
    show(llmRun({ status: 'succeeded', params: params(4), live: one.liveAt(one.duration), detail: one.detail() }));
    expect(screen.queryByRole('region', { name: 'Concurrency sweep' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Stream timeline' })).toHaveTextContent('8 requests at 4 streams');
    expect(screen.queryByRole('radiogroup', { name: 'Level' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Final outputs' })).toHaveTextContent('when the run finished');
  });
});

describe('typewriter', () => {
  it('reveals instantly under reduced motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }));
    try {
      const at = (chars: number) => snapshot([stream(0, { state: 'decode', tokens: 20, chars })]);
      const { container, rerender } = show(llmRun({ params: params(1), live: at(60) }));
      act(() => { rerender(<StreamsSection run={llmRun({ params: params(1), live: at(90) })} spec={LLM_SPEC} />); });
      expect(container.querySelector('.strm-answer')?.textContent).toHaveLength(90);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
