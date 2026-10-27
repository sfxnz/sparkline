import { describe, expect, it } from 'vitest';
import { LIVE_12, LIVE_4, llmRun, nodeState, SHOWCASE_LIVE_4, showcaseDetail, simulate, snapshot, stream } from './fixtures';
import {
  accumulate,
  appendedText,
  cardState,
  countsText,
  densityFor,
  formatMs,
  GAP,
  gridColumns,
  lanesOf,
  niceTicks,
  parseDetail,
  parseLive,
  parseShowcase,
  peakLevel,
  recordedLevels,
  requestRate,
  requestText,
  scalingEfficiency,
  showcaseMarkdown,
  stateCounts,
  STATE_LOOK,
  streamNodes,
  streamMarkdown,
  streamSummary,
  type LevelStats,
  type LiveSnapshot,
} from './model';

const live = (raw: Record<string, unknown>): LiveSnapshot => {
  const s = parseLive(raw);
  if (!s) throw new Error('not a snapshot');
  return s;
};

describe('live snapshot guard', () => {
  it('accepts only llm-streams snapshots', () => {
    expect(parseLive(undefined)).toBeNull();
    expect(parseLive({})).toBeNull();
    expect(parseLive({ kind: 'tool-eval', streams: [] })).toBeNull();
    expect(parseLive([LIVE_4])).toBeNull();
    expect(parseLive(LIVE_4)?.streams).toHaveLength(4);
  });

  it('tolerates missing and malformed fields, and unknown states read as idle', () => {
    const s = live({ kind: 'llm-streams', streams: [{ slot: 1, state: 'thinking', tokens: 'x', tok_s: Number.NaN, text: 42 }, null, { state: 'decode' }, { slot: 1, state: 'done' }] });
    expect(s.level).toBe(2);
    expect(s.levels).toEqual([2]);
    expect(s.streams.map((x) => [x.slot, x.state, x.tokens, x.tok_s, x.text])).toEqual([
      [1, 'idle', 0, null, ''],
      [2, 'decode', 0, null, ''],
    ]);
    expect(s.tok_s).toBeNull();
    expect(s.completed_levels).toEqual([]);
  });

  it('keeps the current level among the levels, sorted, and finds its index', () => {
    const s = live({ kind: 'llm-streams', level: 8, levels: [16, 1, 4, 'x', 2], streams: [] });
    expect(s.levels).toEqual([1, 2, 4, 8, 16]);
    expect(s.level_index).toBe(3);
  });

  it('caps a flood of streams', () => {
    expect(live({ kind: 'llm-streams', streams: Array.from({ length: 500 }, (_, i) => ({ slot: i, state: 'decode' })) }).streams).toHaveLength(64);
  });
});

describe('detail guard', () => {
  it('reads levels and timelines by column name, skipping rows it cannot place', () => {
    const d = parseDetail({
      llm: {
        levels: [{ level: 2, out_tok_s: 88 }, { level: 1, out_tok_s: 46.1, decode_tok_s_p50: 47 }, { level: 0 }, 'x'],
        timeline: {
          '2': {
            cols: ['req', 'slot', 'sent', 'end', 'first', 'tokens', 'ok'],
            rows: [[1, 0, 0, 2.9, 0.21, 128, 1], [2, 1, 0.1, 0.05, null, 0, 0], 'bad', [3, 1, 0.2, 1.4, null, 0, 0]],
            truncated: true,
          },
          '4': { cols: ['slot'], rows: [[0]] },
        },
      },
    });
    expect(d?.levels.map((l) => [l.level, l.out_tok_s])).toEqual([[1, 46.1], [2, 88]]);
    expect(d?.timelines).toHaveLength(1);
    expect(d?.timelines[0]).toEqual({
      level: 2,
      truncated: true,
      requests: [
        { slot: 0, req: 1, sent: 0, first: 0.21, end: 2.9, tokens: 128, ok: true },
        { slot: 1, req: 3, sent: 0.2, first: null, end: 1.4, tokens: 0, ok: false },
      ],
    });
    const huge = parseDetail({ llm: { timeline: { '1000000': { cols: ['slot', 'sent', 'end'], rows: [[0, 0, 1], [5000, 0, 1]] } } } })?.timelines[0];
    expect(huge?.requests).toHaveLength(1); // a lane beyond any real slot is dropped
    expect(huge && lanesOf(huge).lanes).toBe(64);
    expect(parseDetail({ llm: 'nope' })).toBeNull();
    expect(parseDetail({ tool_eval: {} })).toBeNull();
  });

  it('finds the nodes that reported streams, in the run’s node order', () => {
    const r = llmRun({ live: LIVE_4 });
    expect(streamNodes(r)).toEqual(['spark1']);
    const two = { ...r, nodes: ['spark2', 'spark1'], node_states: { ...r.node_states, spark2: nodeState({ node_id: 'spark2', detail: { llm: { levels: [] } } }), spark3: nodeState({ live: { kind: 'other' } }) } };
    expect(streamNodes(two)).toEqual(['spark2', 'spark1']);
    expect(streamNodes(llmRun({}))).toEqual([]);
  });

  it('prefers detail levels, else the snapshot’s finished levels', () => {
    const s = live(snapshot([], { completed_levels: [{ level: 1, out_tok_s: 40 }] }));
    expect(recordedLevels(null, s).map((l) => l.level)).toEqual([1]);
    expect(recordedLevels(parseDetail({ llm: { levels: [{ level: 1 }, { level: 2 }] } }), s).map((l) => l.level)).toEqual([1, 2]);
    expect(recordedLevels(null, null)).toEqual([]);
  });
});

describe('looks', () => {
  it('pairs every state with an icon and a word, and marks streams cut off by a cancel as stopped', () => {
    for (const look of Object.values(STATE_LOOK)) {
      expect(look.label).toMatch(/^[A-Z]/);
      expect(look.icon).toBeTruthy();
    }
    expect(cardState({ state: 'decode' }, true)).toBe('decode');
    expect(cardState({ state: 'decode' }, false)).toBe('stopped');
    expect(cardState({ state: 'wait' }, false)).toBe('stopped');
    expect(cardState({ state: 'done' }, false)).toBe('done');
    expect(countsText(stateCounts(live(LIVE_12).streams))).toBe('7 decoding, 2 waiting, 2 done, 1 failed');
  });

  it('summarises a card for screen readers', () => {
    const [decoding, , waiting, done] = live(LIVE_4).streams;
    if (!decoding || !waiting || !done) throw new Error('fixture');
    // Only what changes rarely: a focused card must not be re-read on every snapshot.
    expect(streamSummary(decoding, 'decode', 8)).toBe('Stream #01: decoding, request 1 of 8');
    expect(streamSummary({ ...decoding, tokens: 99, tok_s: 12.3 }, 'decode', 8)).toBe('Stream #01: decoding, request 1 of 8');
    expect(streamSummary(waiting, 'wait', 8)).toBe('Stream #03: waiting, request 5 of 8');
    expect(streamSummary(done, 'done', 8)).toBe('Stream #04: done, request 4 of 8');
    expect(streamSummary({ ...done, error: 'HTTP 503: overloaded' }, 'error', 8)).toBe('Stream #04: failed, request 4 of 8, HTTP 503: overloaded');
  });

  it('formats durations in ms, then seconds', () => {
    expect([formatMs(210.4), formatMs(999), formatMs(1240), formatMs(null)]).toEqual(['210 ms', '999 ms', '1.24 s', '—']);
  });
});

describe('density', () => {
  it('sizes cards by the stream count unless the viewer picks', () => {
    expect([1, 4, 5, 12, 13, 32].map((n) => densityFor(n, 'auto'))).toEqual(['large', 'large', 'medium', 'medium', 'compact', 'compact']);
    expect(densityFor(32, 'text')).toBe('medium');
    expect(densityFor(4, 'text')).toBe('large');
    expect(densityFor(2, 'compact')).toBe('compact');
  });

  it('balances the rows', () => {
    expect([1, 2, 3, 4, 6, 8, 9, 12].map((n) => gridColumns(n, densityFor(n, 'auto')))).toEqual([1, 2, 3, 2, 3, 4, 3, 4]);
    expect(gridColumns(32, 'compact')).toBe(4);
  });
});

describe('typewriter text', () => {
  it('takes exactly the appended characters from the tail, by code point', () => {
    expect(appendedText('hello world', 100, 103)).toEqual({ text: 'rld', gap: false });
    expect(appendedText('hello', 5, 5)).toEqual({ text: '', gap: false });
    expect(appendedText('ab😀c', 10, 12)).toEqual({ text: '😀c', gap: false });
    expect(appendedText('tail', 0, 50)).toEqual({ text: 'tail', gap: true });
  });

  const one = (p: Parameters<typeof stream>[1], level = 1) => live(snapshot([stream(0, p)], { level, levels: [level] }));

  it('starts at once on first sight, then adds exactly what arrived', () => {
    const a = accumulate(null, one({ state: 'decode', chars: 40 }));
    expect(a.get(0)).toMatchObject({ added: 0, chars: 40 });
    const first = a.get(0)?.answer ?? '';
    const b = accumulate(a, one({ state: 'decode', chars: 52 }));
    expect(b.get(0)?.added).toBe(12);
    expect(b.get(0)?.answer.startsWith(first)).toBe(true);
    expect(b.get(0)?.answer).toHaveLength(52);
  });

  it('keeps more text than the tail holds, up to its cap', () => {
    let t = accumulate(null, one({ state: 'decode', chars: 200 }));
    for (let c = 400; c <= 1000; c += 200) t = accumulate(t, one({ state: 'decode', chars: c }));
    expect(t.get(0)?.answer.length).toBeGreaterThan(280);
  });

  it('marks characters that went by unseen, and starts over for a new request or level', () => {
    const a = accumulate(null, one({ state: 'decode', chars: 100 }));
    const gap = accumulate(a, one({ state: 'decode', chars: 900 }));
    expect(gap.get(0)?.answer).toContain(GAP);
    const next = accumulate(a, one({ state: 'decode', req: 9, chars: 30 }));
    expect(next.get(0)).toMatchObject({ key: '1:0:9', added: next.get(0)?.answer.length });
    expect(accumulate(a, one({ state: 'decode', chars: 120 }, 2)).get(0)?.key).toBe('2:0:1');
  });
});

describe('sweep', () => {
  const rows = [
    { level: 1, out_tok_s: 46, decode_tok_s_p50: 48 },
    { level: 2, out_tok_s: 88, decode_tok_s_p50: 45 },
    { level: 4, out_tok_s: 160, decode_tok_s_p50: 41 },
    { level: 8, out_tok_s: 150, decode_tok_s_p50: 20 },
  ].map((r) => ({ ...r }) as LevelStats);

  it('finds the peak level and the share of perfect scaling (one stream alone is 100%)', () => {
    expect(peakLevel(rows)).toBe(4);
    expect(peakLevel([])).toBeNull();
    expect(rows.map((r) => scalingEfficiency(r, rows)?.toFixed(3))).toEqual(['1.000', '0.957', '0.870', '0.408']);
    expect(scalingEfficiency(rows[1] as LevelStats, rows.slice(1))).toBeNull(); // no single-stream level
  });

  it('places round ticks over the data', () => {
    expect(niceTicks(284 * 1.04, 3)).toEqual({ step: 100, top: 300, ticks: [0, 100, 200, 300] });
    expect(niceTicks(13.5, 6).ticks).toEqual([0, 5, 10, 15]);
    expect(niceTicks(13.5, 8).ticks).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(niceTicks(0).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe('timeline', () => {
  it('describes a request and lays out one lane per stream in time order', () => {
    expect(requestRate({ slot: 0, req: 5, sent: 0, first: 0.21, end: 2.75, tokens: 128, ok: true })).toBeCloseTo(50);
    expect(requestText({ slot: 0, req: 5, sent: 0, first: 0.21, end: 2.75, tokens: 128, ok: true })).toBe('Request 5 · TTFT 210 ms · 128 tokens · 50.0 tok/s');
    expect(requestText({ slot: 0, req: 7, sent: 1, first: null, end: 2.2, tokens: 0, ok: false })).toBe('Request 7 · failed after 1.20 s');
    const d = parseDetail(simulate({ concurrency: 4, sweep: false, requests: 8, maxTokens: 64 }).detail());
    const t = d?.timelines[0];
    if (!t) throw new Error('fixture');
    const { lanes, bySlot } = lanesOf(t);
    expect(lanes).toBe(4);
    expect(bySlot.flat()).toHaveLength(8);
    for (const lane of bySlot) for (let i = 1; i < lane.length; i++) expect((lane[i]?.sent ?? 0) >= (lane[i - 1]?.end ?? 0) - 1e-3).toBe(true);
  });
});

describe('fixtures follow the payload', () => {
  it('simulates levels, live snapshots and detail that agree', () => {
    const sim = simulate({ concurrency: 8, sweep: true, requests: 8, maxTokens: 64 });
    expect(sim.levels).toEqual([1, 2, 4, 8]);
    const mid = live(sim.liveAt((sim.starts[2] ?? 0) + 0.5));
    expect(mid.level).toBe(4);
    expect(mid.streams).toHaveLength(4);
    expect(mid.completed_levels.map((l) => l.level)).toEqual([1, 2]);
    expect(parseDetail(sim.detail())?.levels.map((l) => l.requests)).toEqual([8, 8, 8, 8]);
  });
});

describe('llm-showcase', () => {
  it('reads the showcase flag, the server’s rate and each stream’s prompt, and leaves llm-inference snapshots as they were', () => {
    const s = live(SHOWCASE_LIVE_4);
    expect(s.showcase).toBe(true);
    expect(s.server_tok_s).toBe(182.4);
    expect(s.streams[0]?.label).toMatch(/^Summarise a short article about a coastal town/);
    expect(s.streams.every((x) => x.label !== null && x.label.length <= 60)).toBe(true);
    const plain = live(LIVE_4);
    expect([plain.showcase, plain.server_tok_s, plain.streams[0]?.label]).toEqual([false, null, null]);
    const odd = live({ kind: 'llm-streams', showcase: 'yes', server_tok_s: 'fast', streams: [{ slot: 0, label: 7 }, { slot: 1, label: '' }] });
    expect([odd.showcase, odd.server_tok_s, odd.streams.map((x) => x.label)]).toEqual([false, null, [null, null]]);
  });

  it('names a showcase card by its prompt rather than a request number', () => {
    const [first] = live(SHOWCASE_LIVE_4).streams;
    if (!first) throw new Error('no stream');
    expect(streamSummary(first, 'decode', 4, true)).toBe(`Stream #01: decoding, ${first.label ?? ''}`);
    expect(streamSummary({ ...first, label: null, error: 'HTTP 503' }, 'error', 4, true)).toBe('Stream #01: failed, HTTP 503');
    expect(streamSummary(first, 'decode', 4)).toBe('Stream #01: decoding, request 1 of 4');
  });

  it('guards detail.showcase: whole texts per slot, malformed fields tolerated', () => {
    expect(parseShowcase(undefined)).toBeNull();
    expect(parseShowcase({ llm: { levels: [] } })).toBeNull();
    expect(parseShowcase({ showcase: [] })).toBeNull();
    const d = parseShowcase(showcaseDetail(4));
    expect(d?.streams.map((s) => s.slot)).toEqual([0, 1, 2, 3]);
    expect(d?.streams[0]?.text.length).toBeGreaterThan(280); // the whole text, not the live tail
    expect(d?.server_tok_s).toEqual({ median: 181.6, max: 188.2, samples: 40 });
    expect(d?.fill_to_max).toEqual({ requested: true, applied: true });
    const odd = parseShowcase({ showcase: { streams: [{ slot: 2, state: 'decode', text: 5, tokens: -3, ttft_ms: 'x' }, { state: 'error', error: 'boom' }, null, { slot: 2, text: 'dup' }], server_tok_s: 12, fill_to_max: 'yes', truncated: 1 } });
    expect(odd?.streams.map((s) => [s.slot, s.state, s.text, s.tokens, s.ttft_ms, s.error])).toEqual([
      [1, 'error', '', 0, null, 'boom'],
      [2, 'stopped', '', 0, null, null], // an unknown state reads as stopped; the first entry of a slot wins
    ]);
    expect([odd?.server_tok_s, odd?.fill_to_max, odd?.truncated]).toEqual([null, null, false]);
  });

  it('copies a stream as Markdown: the prompt, the reasoning if any, then the answer', () => {
    const s = { slot: 0, prompt: 'Write a haiku.\nAbout GPUs.', state: 'done' as const, text: 'Fans spin up at dawn\n', think: 'Five, seven, five.', tokens: 12, ttft_ms: 200, decode_tok_s: 40, error: null };
    expect(streamMarkdown(s)).toBe('## Stream #01\n\n> Write a haiku.\n> About GPUs.\n\n### Thinking\n\nFive, seven, five.\n\n### Answer\n\nFans spin up at dawn');
    expect(streamMarkdown({ ...s, slot: 4, think: '', text: '', state: 'error', error: 'HTTP 503' })).toBe('## Stream #05\n\n> Write a haiku.\n> About GPUs.\n\n### Answer\n\n_No answer._\n\n**Failed:** HTTP 503');
    expect(showcaseMarkdown([s, { ...s, slot: 1, think: '' }])).toBe(`${streamMarkdown(s)}\n\n${streamMarkdown({ ...s, slot: 1, think: '' })}`);
  });

  it('finds the nodes with showcase outputs', () => {
    const r = llmRun({ status: 'succeeded', detail: showcaseDetail(2) });
    expect(streamNodes(r)).toEqual(['spark1']);
  });
});
