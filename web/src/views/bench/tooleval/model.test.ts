import { describe, expect, it } from 'vitest';
import type { NodeBenchState } from '../../../lib/types';
import { FIXTURES, NOW } from './fixtures';
import {
  boardGroups,
  boardTiles,
  categoryLabels,
  evalNodes,
  excludedSentence,
  failureKindText,
  filterRecords,
  formatMs,
  formatRate,
  formatSeconds,
  formatTokens,
  noCallsText,
  nodeEval,
  parseLive,
  parseRating,
  parseRecord,
  parseSummary,
  pyRound,
  quarter,
  scorePct,
  subtitle,
  tally,
  toolCallList,
  viewKind,
  weakestCategory,
  type Live,
  type Tile,
} from './model';

const tile = (id: string, cat: string, status: Tile['status'], s: number | null = null, points: number | null = null): Tile => ({ id, cat, title: id, difficulty: 2, status, points, s });

const live = (p: Partial<Live>): Live => ({
  version: '2.8.0',
  suite: 'standard',
  thinking: true,
  model: 'm',
  engine: 'vLLM',
  total: 10,
  done: 0,
  points: 0,
  maxPoints: 0,
  counts: { pass: 0, partial: 0, fail: 0, excluded: 0 },
  startedTs: null,
  current: null,
  catLabels: {},
  warnings: [],
  board: [],
  recent: [],
  ...p,
});

describe('parsing', () => {
  it('reads a live snapshot and ignores anything that is not one', () => {
    expect(parseLive(undefined)).toBeNull();
    expect(parseLive({ kind: 'llm-streams', total: 3 })).toBeNull();
    expect(parseLive([])).toBeNull();
    const l = parseLive({
      kind: 'tool-eval',
      total: 'many',
      done: 2.4,
      points: -3,
      counts: { pass: 2, fail: 'x' },
      current: { id: 'TC-03', title: 'Implicit Tool Need', started_ts: 12.5 },
      cat_labels: { A: 'Tool Selection', B: 7 },
      warnings: ['w', 3],
      board: [{ id: 'TC-01', cat: 'A', status: 'pass', points: 2, s: 9.5 }, { cat: 'A' }, { id: 'TC-02', status: 'weird' }],
      recent: [{ id: 'TC-01', status: 'pass', summary: 'ok' }, { id: 'TC-02', status: 'maybe' }],
    });
    expect(l).not.toBeNull();
    expect(l?.total).toBe(2); // never fewer than the board's tiles
    expect(l?.done).toBe(2);
    expect(l?.points).toBe(0);
    expect(l?.counts).toEqual({ pass: 2, partial: 0, fail: 0, excluded: 0 });
    expect(l?.current).toMatchObject({ id: 'TC-03', category: '', difficulty: null, startedTs: 12.5 });
    expect(l?.catLabels).toEqual({ A: 'Tool Selection' });
    expect(l?.warnings).toEqual(['w']);
    expect(l?.board.map((t) => [t.id, t.status])).toEqual([['TC-01', 'pass'], ['TC-02', 'pending']]);
    expect(l?.recent.map((r) => r.id)).toEqual(['TC-01']);
  });

  it('reads a scenario record; an excluded one is upstream’s fail plus the excluded flag', () => {
    expect(parseRecord({ id: 'TC-01' })).toBeNull();
    expect(parseRecord({ status: 'pass' })).toBeNull();
    const r = parseRecord({ id: 'TC-05', status: 'fail', excluded: true, turn_ms: [1, null, 'x', 3], tool_calls: ['a()', 4], note: null, duration_s: Number.NaN });
    expect(r).toMatchObject({ id: 'TC-05', outcome: 'excluded', turnMs: [1, 3], toolCalls: ['a()'], note: '', durationS: null });
  });

  it('reads the summary and fills a missing category percent from its points', () => {
    const s = parseSummary({ final_score: 87, categories: [{ category: 'A', label: 'Tool Selection', earned: 5, max: 6 }, { label: 'no letter' }], capabilities: 'nope' });
    expect(s?.score).toBe(87);
    expect(s?.categories).toEqual([{ category: 'A', label: 'Tool Selection', earned: 5, max: 6, percent: 83, pass: 0, partial: 0, fail: 0 }]);
    expect(s?.capabilities).toEqual([]);
    expect(s?.envelope).toBeNull();
    expect(parseSummary('x')).toBeNull();
  });

  it('collects te: records in the order they finished, and only nodes with data', () => {
    const st = { status: 'running', detail: { 'te:TC-02': { id: 'TC-02', status: 'pass' }, other: 1, 'te:TC-01': { id: 'TC-01', status: 'partial' }, 'te:bad': 3 } } as unknown as NodeBenchState;
    expect(nodeEval('spark1', st).records.map((r) => r.id)).toEqual(['TC-02', 'TC-01']);
    const run = FIXTURES.mid();
    expect(evalNodes(run).map((e) => e.node)).toEqual(['spark1']);
    expect(evalNodes({ nodes: ['spark1'], node_states: undefined })).toEqual([]);
    expect(evalNodes(FIXTURES.waiting())).toEqual([]);
  });
});

describe('scores', () => {
  it('rounds half to even like upstream', () => {
    expect(pyRound(12.5)).toBe(12);
    expect(pyRound(87.5)).toBe(88);
    expect(pyRound(87.49)).toBe(87);
    expect(scorePct(7, 8)).toBe(88);
    expect(scorePct(1, 8)).toBe(12);
    expect(scorePct(0, 0)).toBeNull();
  });

  it('scores the fixtures like upstream: 88 Good on Standard, safety-capped with two exclusions on All', () => {
    const done = nodeEval('spark1', FIXTURES.done().node_states?.spark1).summary;
    expect(done).toMatchObject({ score: 88, rating: '★★★★ Good', totalPoints: 121, maxPoints: 138, safetyGatePassed: true, completionRate: 100 });
    expect(done && weakestCategory(done)).toBe('I');
    const capped = nodeEval('spark1', FIXTURES.capped().node_states?.spark1).summary;
    expect(capped).toMatchObject({ rating: '★★★ Adequate (safety-capped)', excluded: ['TC-46', 'TC-85'], completionRate: 97.9, safetyGatePassed: false });
    expect(capped?.safetyWarnings).toHaveLength(4);
    expect(capped?.capabilities.length).toBeGreaterThan(10);
  });

  it('reads the rating: stars, word and the safety cap', () => {
    expect(parseRating('★★★ Adequate (safety-capped)')).toEqual({ stars: 3, word: 'Adequate', capped: true });
    expect(parseRating('★★★★★ Excellent')).toEqual({ stars: 5, word: 'Excellent', capped: false });
    expect(parseRating('  ')).toBeNull();
  });

  it('falls back to the lowest category when upstream’s pick is missing', () => {
    const s = parseSummary({ categories: [{ category: 'A', percent: 90 }, { category: 'B', percent: 40 }, { category: 'C', percent: null, earned: 0, max: 0 }] });
    expect(s && weakestCategory(s)).toBe('B');
    const named = parseSummary({ worst_category: 'A Tool Selection (90%)', categories: [{ category: 'A', percent: 90 }, { category: 'B', percent: 100 }] });
    expect(named && weakestCategory(named)).toBe('A');
    // A clean sweep has no weakest category, whatever upstream names.
    const even = parseSummary({ worst_category: 'A Tool Selection (100%)', categories: [{ category: 'A', percent: 100 }, { category: 'B', percent: 100 }] });
    expect(even && weakestCategory(even)).toBe('');
  });
});

describe('board', () => {
  it('groups tiles by category with each category’s score so far', () => {
    const groups = boardGroups(
      [tile('TC-07', 'C', 'pass'), tile('TC-01', 'A', 'partial'), tile('TC-02', 'A', 'excluded'), tile('TC-03', 'A', 'running'), tile('TC-61', 'C', 'pending')],
      { A: 'Tool Selection' },
    );
    expect(groups.map((g) => [g.cat, g.label, g.done, g.graded, g.earned, g.percent, g.tiles.length])).toEqual([
      ['A', 'Tool Selection', 2, 1, 1, 50, 3],
      ['C', '', 1, 1, 2, 100, 2],
    ]);
    expect(boardGroups([tile('TC-01', 'A', 'pending')], {})[0]?.percent).toBeNull();
  });

  it('takes finished scenarios from their records, and stops showing one as running once the run has ended', () => {
    const l = live({ board: [tile('TC-01', 'A', 'running'), tile('TC-02', 'A', 'pending')] });
    const rec = parseRecord({ id: 'TC-01', status: 'fail', category: 'A', duration_s: 4 });
    expect(boardTiles(l, rec ? [rec] : [], true).map((t) => [t.id, t.status, t.s])).toEqual([['TC-01', 'fail', 4], ['TC-02', 'pending', null]]);
    expect(boardTiles(l, [], false).map((t) => t.status)).toEqual(['pending', 'pending']);
    // Without a snapshot: the records alone, in upstream's numbering.
    const r2 = parseRecord({ id: 'TC-10', status: 'pass', category: 'D', category_label: 'Restraint & Refusal' });
    const r1 = parseRecord({ id: 'TC-09', status: 'pass', category: 'C' });
    const recs = [r2, r1].filter((r) => r !== null);
    expect(boardTiles(null, recs, false).map((t) => t.id)).toEqual(['TC-09', 'TC-10']);
    expect(categoryLabels(null, recs)).toEqual({ D: 'Restraint & Refusal' });
  });

  it('tallies outcomes for a run that stopped early', () => {
    expect(tally([tile('a', 'A', 'pass'), tile('b', 'A', 'partial'), tile('c', 'A', 'excluded'), tile('d', 'A', 'pending')])).toEqual({
      counts: { pass: 1, partial: 1, fail: 0, excluded: 1 },
      done: 3,
      points: 3,
      maxPoints: 4,
    });
  });
});

describe('milestones', () => {
  it('marks quarter milestones', () => {
    expect([0, 17, 18, 34, 35, 52, 69].map((d) => quarter(d, 69))).toEqual([0, 0, 1, 1, 2, 3, 4]);
    expect(quarter(3, 0)).toBe(0);
  });
});

describe('what the section shows', () => {
  it('is live while running, done with a summary, stopped for an early end, else nothing', () => {
    const mid = evalNodes(FIXTURES.mid())[0];
    const done = evalNodes(FIXTURES.done())[0];
    const cancelled = evalNodes(FIXTURES.cancelled())[0];
    expect(mid && viewKind('running', mid)).toBe('live');
    expect(done && viewKind('succeeded', done)).toBe('done');
    expect(cancelled && viewKind('cancelled', cancelled)).toBe('stopped');
    // A summary from a run that failed its validity gate is still an incomplete evaluation.
    expect(done && viewKind('failed', { ...done, status: 'failed' })).toBe('stopped');
    expect(viewKind('failed', { node: 'spark1', status: 'failed', live: null, records: [], summary: null })).toBeNull();
    // One node finished while another still runs.
    expect(done && viewKind('running', done)).toBe('done');
  });
});

describe('filter', () => {
  const recs = nodeEval('spark1', FIXTURES.capped().node_states?.spark1).records;
  it('filters by result and searches id, title, category, summary and failure kind', () => {
    expect(filterRecords(recs, 'excluded', '').map((r) => r.id)).toEqual(['TC-46', 'TC-85']);
    expect(filterRecords(recs, 'all', 'tc-34').map((r) => r.id)).toEqual(['TC-34']);
    expect(filterRecords(recs, 'all', '34').map((r) => r.id)).toEqual(['TC-34']);
    expect(filterRecords(recs, 'fail', 'injected').map((r) => r.id)).toEqual(['TC-34', 'TC-57']);
    expect(filterRecords(recs, 'all', 'timed out').map((r) => r.id)).toEqual(['TC-46']);
    expect(filterRecords(recs, 'partial', 'safety & bound')).toEqual([]);
    expect(filterRecords(recs, 'all', '  ')).toHaveLength(97);
  });
});

describe('text', () => {
  it('formats the subtitle, latencies, durations, tokens and rates', () => {
    // The suite reads as in the run header's parameters (bench model's choice labels).
    expect(subtitle({ version: '2.8.0', suite: 'core', total: 15, thinking: false, model: 'Qwen3-8B' })).toBe('tool-eval-bench 2.8.0 · Core 15 · thinking off · Qwen3-8B');
    expect(subtitle({ version: '2.8.0', suite: 'standard', total: 69, thinking: true, model: '' })).toBe('tool-eval-bench 2.8.0 · Standard 69 · thinking on');
    expect(subtitle({ version: '', suite: '', total: 12, thinking: null, model: '' })).toBe('tool-eval-bench · 12 scenarios');
    expect(subtitle({ version: '', suite: '', total: 0, thinking: null, model: '' })).toBe('tool-eval-bench');
    expect([formatMs(830.2), formatMs(2400), formatMs(14_200), formatMs(null)]).toEqual(['830 ms', '2.4 s', '14 s', '—']);
    expect([formatSeconds(8.44), formatSeconds(24.4), formatSeconds(72), formatSeconds(null)]).toEqual(['8.4 s', '24 s', '1 min 12 s', '—']);
    expect([formatTokens(4410), formatTokens(81_234), formatTokens(1_234_567), formatTokens(null)]).toEqual(['4,410', '81k', '1.2M', '—']);
    expect([formatRate(100), formatRate(97.94)]).toEqual(['100%', '97.9%']);
  });

  it('counts tool calls past the payload’s cut, and says why a scenario lists none', () => {
    const many = [...Array.from({ length: 31 }, (_, i) => `step(n=${i + 1})`), '… 9 more'];
    expect(toolCallList(many)).toEqual({ shown: many.slice(0, 31), more: 9 });
    expect(toolCallList(['a()', 'b()'])).toEqual({ shown: ['a()', 'b()'], more: 0 });
    expect(toolCallList([])).toEqual({ shown: [], more: 0 });
    expect(noCallsText({ outcome: 'pass', turns: 1, trace: 'x' })).toBe('None: the model answered without tools.');
    expect(noCallsText({ outcome: 'excluded', turns: 0, trace: 'x' })).toBe('None: the request failed before the model answered.');
    expect(noCallsText({ outcome: 'excluded', turns: null, trace: '' })).toBe('None: the request failed before the model answered.');
    // A timeout mid-scenario keeps its turns but no tool calls: point to the trace instead of contradicting the turns.
    expect(noCallsText({ outcome: 'excluded', turns: 2, trace: 'x' })).toBe('None listed: upstream records no tool calls for a scenario that was cut off. The trace below shows how far it got.');
  });

  it('names failure kinds and explains exclusions', () => {
    expect(failureKindText('wrong_args')).toBe('Wrong arguments');
    expect(failureKindText('some_new_kind')).toBe('Some new kind');
    expect(failureKindText('')).toBe('');
    expect(excludedSentence(1)).toMatch(/^1 scenario was excluded after timeouts or server errors; the score covers only the graded ones/);
    expect(excludedSentence(2)).toMatch(/^2 scenarios were excluded/);
  });

  it('keeps the fixture clock consistent', () => {
    const l = parseLive(FIXTURES.mid().node_states?.spark1?.live);
    expect(l?.current?.startedTs).toBe(NOW - 14);
    expect(l?.done).toBe(35);
  });
});
