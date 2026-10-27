// Pure logic behind the tool-calling evaluation (tool-eval-bench) views: defensive parsing of the payload's live
// snapshot and per-scenario detail records (old runs, other agent versions and the demo all arrive here), the score
// so far, the board grouped by category, the remaining-time estimate, the rating, the scenario filter and display
// text. No React, no stores: every rule here is unit-tested in model.test.ts.
import type { BenchRun, NodeBenchState, RunStatus } from '../../../lib/types';
import { choiceLabel, isActive, splitDescription } from '../model';

// ------------------------------------------------------------------------------------------------ outcomes

export type Outcome = 'pass' | 'partial' | 'fail' | 'excluded';
export type TileStatus = 'pending' | 'running' | Outcome;
export type Tone = 'ok' | 'warn' | 'crit' | 'stale';

export const OUTCOMES: readonly Outcome[] = ['pass', 'partial', 'fail', 'excluded'];

/** How each status reads; status colour only through .tone-* (pending and running are not outcomes). */
export const STATUS_LOOK: Record<TileStatus, { label: string; tone: Tone | null }> = {
  pass: { label: 'Passed', tone: 'ok' },
  partial: { label: 'Partial', tone: 'warn' },
  fail: { label: 'Failed', tone: 'crit' },
  excluded: { label: 'Excluded', tone: 'stale' },
  pending: { label: 'Not run yet', tone: null },
  running: { label: 'Running', tone: null },
};

export const isOutcome = (s: TileStatus): s is Outcome => s !== 'pending' && s !== 'running';

/** Upstream's points per verdict: pass 2, partial 1, fail 0 (an excluded scenario is not graded). */
const POINTS: Record<Outcome, number> = { pass: 2, partial: 1, fail: 0, excluded: 0 };

// ------------------------------------------------------------------------------------------------ parsing helpers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => Math.max(0, Math.round(num(v) ?? 0));
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
const nums = (v: unknown, max: number): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).slice(0, max) : []);
/** Trials a run can have (the param allows 1-10; more is kept in case a later agent allows it). */
const MAX_TRIALS = 64;

/** A scenario's points in each trial: 0-2, null when that trial excluded it (anything else is dropped). */
const trialPoints = (v: unknown): TrialPoints[] =>
  Array.isArray(v) ? v.filter((x): x is TrialPoints => x === null || (typeof x === 'number' && Number.isFinite(x))).slice(0, MAX_TRIALS) : [];
/** The sampling seed: a non-negative whole number, else none. */
const seedOf = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};
const labels = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

function outcomeOf(status: unknown, excluded?: unknown): Outcome | null {
  if (excluded === true || status === 'excluded') return 'excluded';
  return status === 'pass' || status === 'partial' || status === 'fail' ? status : null;
}

const tileStatusOf = (v: unknown): TileStatus => (v === 'running' || v === 'pass' || v === 'partial' || v === 'fail' || v === 'excluded' ? v : 'pending');

/** Python's round() (half to even), so a score computed here matches upstream's to the point: 12.5 -> 12. */
export function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Points earned ÷ points possible × 100, rounded like upstream; null before anything was graded. */
export const scorePct = (points: number, max: number): number | null => (max > 0 ? pyRound((points / max) * 100) : null);

// ------------------------------------------------------------------------------------------------ trials

/** One trial's points for a scenario (0-2), null when that trial excluded it. */
export type TrialPoints = number | null;

/** A trial's points as its verdict: 2 a pass, 1 a partial, 0 a fail, null excluded. */
export const trialOutcome = (p: TrialPoints): Outcome => (p === null ? 'excluded' : p >= 2 ? 'pass' : p >= 1 ? 'partial' : 'fail');

/** Verdicts over the trials, worst last: "6 passed, 1 partial, 1 excluded" (zero counts left out). */
export function historyText(h: readonly TrialPoints[]): string {
  const c: Record<Outcome, number> = { pass: 0, partial: 0, fail: 0, excluded: 0 };
  for (const p of h) c[trialOutcome(p)]++;
  const words: Record<Outcome, string> = { pass: 'passed', partial: 'partial', fail: 'failed', excluded: 'excluded' };
  return OUTCOMES.filter((o) => c[o]).map((o) => `${c[o]} ${words[o]}`).join(', ');
}

/** Mean points of the graded trials, for sorting scenarios by how reliably they pass; null when none was graded. */
export function historyMean(h: readonly TrialPoints[]): number | null {
  const graded = h.filter((p): p is number => p !== null);
  return graded.length ? graded.reduce((a, b) => a + b, 0) / graded.length : null;
}

/** Mean and sample standard deviation (like Python's statistics.stdev) of finished trials' scores; the spread needs
 * two. */
export function spread(xs: readonly number[]): { mean: number | null; stddev: number | null } {
  if (!xs.length) return { mean: null, stddev: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length < 2) return { mean, stddev: null };
  return { mean, stddev: Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)) };
}

/** One decimal, as upstream reports trial statistics: "87.4", "90.0". */
export const oneDecimal = (n: number): string => n.toFixed(1);

export interface TrialScore {
  trial: number;
  score: number | null;
  rating: string;
  points: number | null;
  maxPoints: number | null;
  excluded: number;
}

/**
 * The axis of the per-trial score plot: the scores (and their interval) with a little room, on round numbers, at
 * least 10 points wide and inside 0-100, with a tick every 5, 10 or 20 points.
 */
export function plotDomain(values: readonly number[]): { lo: number; hi: number; ticks: number[] } {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return { lo: 0, hi: 100, ticks: [0, 20, 40, 60, 80, 100] };
  let lo = Math.max(0, Math.floor((Math.min(...xs) - 2) / 5) * 5);
  let hi = Math.min(100, Math.ceil((Math.max(...xs) + 2) / 5) * 5);
  if (hi - lo < 10) {
    hi = Math.min(100, lo + 10);
    lo = Math.max(0, hi - 10);
  }
  const step = hi - lo <= 20 ? 5 : hi - lo <= 50 ? 10 : 20;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return { lo, hi, ticks };
}

// ------------------------------------------------------------------------------------------------ live snapshot

export interface Tile {
  id: string;
  cat: string;
  title: string;
  difficulty: number | null;
  status: TileStatus;
  points: number | null;
  /** Seconds the scenario took (finished ones). */
  s: number | null;
  /** Points in each trial it finished, this one included once it finished (multi-trial runs only). */
  history: TrialPoints[];
}

export interface Current {
  id: string;
  title: string;
  category: string;
  difficulty: number | null;
  expected: string;
  startedTs: number | null;
}

export interface Recent {
  id: string;
  outcome: Outcome;
  points: number | null;
  summary: string;
  /** The trial it finished in (null from agents before trials). */
  trial: number | null;
}

export interface Live {
  version: string;
  suite: string;
  thinking: boolean | null;
  model: string;
  engine: string;
  total: number;
  done: number;
  /** Graded so far: excluded scenarios count in neither. */
  points: number;
  maxPoints: number;
  counts: Record<Outcome, number>;
  startedTs: number | null;
  current: Current | null;
  catLabels: Record<string, string>;
  warnings: string[];
  board: Tile[];
  recent: Recent[];
  /** The trial running now (1-based) of `trials`; 1 of 1 for a single run. Counts and points above are this trial's. */
  trial: number;
  trials: number;
  seed: number | null;
  /** Finished trials' scores, in order. */
  trialScores: TrialScore[];
}

/** The payload's live snapshot (`kind: "tool-eval"`), or null for anything else. */
export function parseLive(v: unknown): Live | null {
  if (!isObj(v) || v.kind !== 'tool-eval') return null;
  const board = (Array.isArray(v.board) ? v.board : []).flatMap((t): Tile[] =>
    isObj(t) && str(t.id)
      ? [{ id: str(t.id), cat: str(t.cat), title: str(t.title), difficulty: num(t.difficulty), status: tileStatusOf(t.status), points: num(t.points), s: num(t.s), history: trialPoints(t.history) }]
      : [],
  );
  const recent = (Array.isArray(v.recent) ? v.recent : []).flatMap((r): Recent[] => {
    const outcome = isObj(r) ? outcomeOf(r.status, r.excluded) : null;
    return isObj(r) && str(r.id) && outcome ? [{ id: str(r.id), outcome, points: num(r.points), summary: str(r.summary), trial: num(r.trial) }] : [];
  });
  const trialScores = (Array.isArray(v.trial_scores) ? v.trial_scores : []).slice(0, MAX_TRIALS).flatMap((t, i): TrialScore[] =>
    isObj(t) ? [{ trial: count(t.trial) || i + 1, score: num(t.score), rating: str(t.rating), points: num(t.points), maxPoints: num(t.max_points), excluded: count(t.excluded) }] : [],
  );
  const trials = Math.max(1, count(v.trials), trialScores.length);
  const c = isObj(v.counts) ? v.counts : {};
  const cur = v.current;
  return {
    version: str(v.version),
    suite: str(v.suite),
    thinking: bool(v.thinking),
    model: str(v.model),
    engine: str(v.engine),
    total: Math.max(count(v.total), board.length),
    done: count(v.done),
    points: count(v.points),
    maxPoints: count(v.max_points),
    counts: { pass: count(c.pass), partial: count(c.partial), fail: count(c.fail), excluded: count(c.excluded) },
    startedTs: num(v.started_ts),
    current: isObj(cur) && str(cur.id)
      ? { id: str(cur.id), title: str(cur.title), category: str(cur.category), difficulty: num(cur.difficulty), expected: str(cur.expected), startedTs: num(cur.started_ts) }
      : null,
    catLabels: labels(v.cat_labels),
    warnings: strs(v.warnings, 20),
    board,
    recent: recent.slice(0, 5),
    trial: Math.min(trials, Math.max(1, count(v.trial))),
    trials,
    seed: seedOf(v.seed),
    trialScores,
  };
}

// ------------------------------------------------------------------------------------------------ detail

export const RECORD_PREFIX = 'te:';

export interface ScenarioRecord {
  id: string;
  title: string;
  category: string;
  categoryLabel: string;
  difficulty: number | null;
  outcome: Outcome;
  points: number | null;
  summary: string;
  note: string;
  failureKind: string;
  safetyViolation: string;
  expected: string;
  successCase: string;
  failureCase: string;
  durationS: number | null;
  ttftMs: number | null;
  turns: number | null;
  turnMs: number[];
  promptTokens: number | null;
  completionTokens: number | null;
  toolCalls: string[];
  budgetExceeded: boolean;
  trace: string;
  /** Points in each trial so far, this record's (the latest) last; one entry per finished trial. */
  history: TrialPoints[];
}

/** One finished scenario (`detail["te:<ID>"]`), or null when it is not one. */
export function parseRecord(v: unknown): ScenarioRecord | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const outcome = outcomeOf(v.status, v.excluded);
  if (!id || !outcome) return null;
  return {
    id,
    title: str(v.title),
    category: str(v.category),
    categoryLabel: str(v.category_label),
    difficulty: num(v.difficulty),
    outcome,
    points: num(v.points),
    summary: str(v.summary),
    note: str(v.note),
    failureKind: str(v.failure_kind),
    safetyViolation: str(v.safety_violation),
    expected: str(v.expected),
    successCase: str(v.success_case),
    failureCase: str(v.failure_case),
    durationS: num(v.duration_s),
    ttftMs: num(v.ttft_ms),
    turns: num(v.turns),
    turnMs: nums(v.turn_ms, 64),
    promptTokens: num(v.prompt_tokens),
    completionTokens: num(v.completion_tokens),
    toolCalls: strs(v.tool_calls, 64),
    budgetExceeded: v.budget_exceeded === true,
    trace: str(v.trace),
    history: trialPoints(v.history),
  };
}

export interface CategoryScore {
  category: string;
  label: string;
  earned: number;
  max: number;
  percent: number | null;
  pass: number;
  partial: number;
  fail: number;
}

export interface CapabilityScore {
  capability: string;
  label: string;
  earned: number;
  max: number;
  percent: number | null;
}

export interface CategorySpread {
  label: string;
  meanPercent: number | null;
  stddevPercent: number | null;
}

export interface ScenarioSpread {
  mean: number | null;
  stddev: number | null;
  points: TrialPoints[];
  passAtK: boolean;
  passHatK: boolean;
}

/** Upstream's statistics over the trials (null for a single trial). Percentages are of the graded scenarios. */
export interface TrialStats {
  scores: number[];
  ratings: string[];
  mean: number | null;
  stddev: number | null;
  median: number | null;
  ci95: readonly [number, number] | null;
  min: number | null;
  max: number | null;
  /** The mean's rating, safety-capped if any trial was. */
  rating: string;
  /** Passed in at least one trial / in every trial, and the difference (points). */
  passAtK: number | null;
  passHatK: number | null;
  reliabilityGap: number | null;
  /** Passed in some trials, not all; never passed. */
  flaky: string[];
  never: string[];
  perCategory: Record<string, CategorySpread>;
  perScenario: Record<string, ScenarioSpread>;
  completionRate: number | null;
  /** Scenario runs graded over all trials. */
  graded: number | null;
  /** Every trial's violations together. */
  safetyWarnings: string[];
}

export function parseTrialStats(v: unknown): TrialStats | null {
  if (!isObj(v)) return null;
  const ci = nums(v.ci95, 2);
  const lo = ci[0];
  const hi = ci[1];
  return {
    scores: nums(v.scores, MAX_TRIALS),
    ratings: strs(v.ratings, MAX_TRIALS),
    mean: num(v.mean),
    stddev: num(v.stddev),
    median: num(v.median),
    ci95: lo !== undefined && hi !== undefined ? [lo, hi] : null,
    min: num(v.min),
    max: num(v.max),
    rating: str(v.rating),
    passAtK: num(v.pass_at_k),
    passHatK: num(v.pass_hat_k),
    reliabilityGap: num(v.reliability_gap),
    flaky: strs(v.flaky, 200),
    never: strs(v.never, 200),
    perCategory: isObj(v.per_category)
      ? Object.fromEntries(Object.entries(v.per_category).flatMap(([k, c]) => (isObj(c) ? [[k, { label: str(c.label), meanPercent: num(c.mean_percent), stddevPercent: num(c.stddev_percent) }]] : [])))
      : {},
    perScenario: isObj(v.per_scenario)
      ? Object.fromEntries(
          Object.entries(v.per_scenario).flatMap(([k, s]) =>
            isObj(s) ? [[k, { mean: num(s.mean), stddev: num(s.stddev), points: trialPoints(s.points), passAtK: s.pass_at_k === true, passHatK: s.pass_hat_k === true }]] : [],
          ),
        )
      : {},
    completionRate: num(v.completion_rate),
    graded: num(v.graded),
    safetyWarnings: strs(v.safety_warnings, 200),
  };
}

export interface Summary {
  version: string;
  suite: string;
  thinking: boolean | null;
  model: string;
  engine: string;
  engineVersion: string;
  fingerprint: string;
  score: number | null;
  rating: string;
  totalPoints: number | null;
  maxPoints: number | null;
  completionRate: number | null;
  excluded: string[];
  safetyWarnings: string[];
  /** Upstream's gate: passed means no safety violation at all (a capped rating is a stricter, separate rule). */
  safetyGatePassed: boolean | null;
  deployability: number | null;
  responsiveness: number | null;
  medianTurnMs: number | null;
  totalTokens: number | null;
  tokenEfficiency: number | null;
  worstCategory: string;
  categories: CategoryScore[];
  capabilities: CapabilityScore[];
  /** Upstream's result envelope (its own JSON format), for the download. */
  envelope: Record<string, unknown> | null;
  /** Trials run (the fields above are the last one's, like upstream's JSON) and the seed; statistics when over 1. */
  trials: number;
  seed: number | null;
  trialStats: TrialStats | null;
}

/** The run summary (`detail.tool_eval`), or null. */
export function parseSummary(v: unknown): Summary | null {
  if (!isObj(v)) return null;
  const pct = (o: Obj) => num(o.percent) ?? scorePct(count(o.earned), count(o.max));
  return {
    version: str(v.version),
    suite: str(v.suite),
    thinking: bool(v.thinking),
    model: str(v.model),
    engine: str(v.engine),
    engineVersion: str(v.engine_version),
    fingerprint: str(v.fingerprint),
    score: num(v.final_score),
    rating: str(v.rating),
    totalPoints: num(v.total_points),
    maxPoints: num(v.max_points),
    completionRate: num(v.completion_rate),
    excluded: strs(v.excluded, 200),
    safetyWarnings: strs(v.safety_warnings, 200),
    safetyGatePassed: bool(v.safety_gate_passed),
    deployability: num(v.deployability),
    responsiveness: num(v.responsiveness),
    medianTurnMs: num(v.median_turn_ms),
    totalTokens: num(v.total_tokens),
    tokenEfficiency: num(v.token_efficiency),
    worstCategory: str(v.worst_category),
    categories: (Array.isArray(v.categories) ? v.categories : []).flatMap((c): CategoryScore[] =>
      isObj(c) && str(c.category)
        ? [{ category: str(c.category), label: str(c.label), earned: count(c.earned), max: count(c.max), percent: pct(c), pass: count(c.pass), partial: count(c.partial), fail: count(c.fail) }]
        : [],
    ),
    capabilities: (Array.isArray(v.capabilities) ? v.capabilities : []).flatMap((c): CapabilityScore[] =>
      isObj(c) && str(c.capability) ? [{ capability: str(c.capability), label: str(c.label), earned: count(c.earned), max: count(c.max), percent: pct(c) }] : [],
    ),
    envelope: isObj(v.envelope) ? v.envelope : null,
    trials: Math.max(1, count(v.trials)),
    seed: seedOf(v.seed),
    trialStats: parseTrialStats(v.trial_stats),
  };
}

// ------------------------------------------------------------------------------------------------ per node

export interface NodeEval {
  node: string;
  status: RunStatus | null;
  live: Live | null;
  /** Finished scenarios in the order they finished. */
  records: ScenarioRecord[];
  summary: Summary | null;
}

export function nodeEval(node: string, st: NodeBenchState | undefined): NodeEval {
  const detail = st?.detail ?? {};
  const records = Object.entries(detail).flatMap(([k, v]) => {
    const r = k.startsWith(RECORD_PREFIX) ? parseRecord(v) : null;
    return r ? [r] : [];
  });
  return { node, status: st?.status ?? null, live: parseLive(st?.live), records, summary: parseSummary(detail.tool_eval) };
}

/** The run's nodes that have tool-eval data, in the run's node order (none for old runs and list copies). */
export function evalNodes(run: Pick<BenchRun, 'nodes' | 'node_states'>): NodeEval[] {
  return run.nodes.map((n) => nodeEval(n, run.node_states?.[n])).filter((e) => e.live !== null || e.summary !== null || e.records.length > 0);
}

/**
 * What a node's evaluation shows: 'live' while it runs, 'done' once it finished with a summary, 'stopped' for an
 * evaluation that ended early (cancelled, failed, or finished without a summary) but graded something; else null.
 */
export function viewKind(runStatus: RunStatus, e: NodeEval): 'live' | 'done' | 'stopped' | null {
  const ended = e.status === 'failed' || e.status === 'cancelled' || e.status === 'succeeded' || !isActive(runStatus);
  if (e.summary && (e.status === 'succeeded' || runStatus === 'succeeded') && e.status !== 'failed') return 'done';
  if (!ended) return 'live';
  return e.records.length || (e.live?.done ?? 0) > 0 ? 'stopped' : null;
}

// ------------------------------------------------------------------------------------------------ board

/** "TC-07" -> 7, for ordering scenarios the way upstream numbers them. */
export const scenarioNumber = (id: string): number => Number(/\d+/.exec(id)?.[0] ?? Number.MAX_SAFE_INTEGER);

export const byScenario = (a: { id: string }, b: { id: string }) => scenarioNumber(a.id) - scenarioNumber(b.id) || a.id.localeCompare(b.id);

const fromRecord = (r: ScenarioRecord): Tile => ({ id: r.id, cat: r.category, title: r.title, difficulty: r.difficulty, status: r.outcome, points: r.points, s: r.durationS, history: r.history });

/**
 * The records of the trial running now. Every trial replaces a scenario's record, so while trial 3 runs one not yet
 * re-run still holds trial 2's (its history is a trial short): that one is not this trial's verdict.
 */
export function trialRecords(live: Live | null, records: readonly ScenarioRecord[]): readonly ScenarioRecord[] {
  if (!live || live.trials <= 1) return records;
  return records.filter((r) => r.history.length >= live.trial);
}

/**
 * Every scenario of the run in run order: the live board with finished scenarios taken from their records (which
 * survive a cancel), or, without a snapshot, the records alone. Once the run has ended nothing is "running".
 */
export function boardTiles(live: Live | null, records: readonly ScenarioRecord[], active: boolean): Tile[] {
  if (!live?.board.length) return [...records].sort(byScenario).map(fromRecord);
  const byId = new Map(records.map((r) => [r.id, r]));
  return live.board.map((t) => {
    const r = byId.get(t.id);
    if (r) return { ...fromRecord(r), cat: t.cat || r.category, title: t.title || r.title };
    return !active && t.status === 'running' ? { ...t, status: 'pending' } : t;
  });
}

export interface BoardGroup {
  cat: string;
  label: string;
  tiles: Tile[];
  /** Finished, graded (finished minus excluded), points earned and the percentage of the graded ones. */
  done: number;
  graded: number;
  earned: number;
  percent: number | null;
}

/** Tiles grouped by category, A to P, each with its score so far. */
export function boardGroups(tiles: readonly Tile[], catLabels: Record<string, string>): BoardGroup[] {
  const by = new Map<string, Tile[]>();
  for (const t of tiles) {
    const g = by.get(t.cat);
    if (g) g.push(t);
    else by.set(t.cat, [t]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, ts]) => {
      let done = 0;
      let graded = 0;
      let earned = 0;
      for (const t of ts) {
        if (!isOutcome(t.status)) continue;
        done++;
        if (t.status === 'excluded') continue;
        graded++;
        earned += t.points ?? POINTS[t.status];
      }
      return { cat, label: catLabels[cat] ?? '', tiles: ts, done, graded, earned, percent: scorePct(earned, graded * 2) };
    });
}

/** Category labels from whatever the run has: the snapshot's map, else each record's own label. */
export function categoryLabels(live: Live | null, records: readonly ScenarioRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of records) if (r.category && r.categoryLabel) out[r.category] = r.categoryLabel;
  return { ...out, ...live?.catLabels };
}

/** Outcome counts and points over finished tiles (for a run that stopped early, where no snapshot counts them). */
export function tally(tiles: readonly Tile[]): { counts: Record<Outcome, number>; done: number; points: number; maxPoints: number } {
  const counts: Record<Outcome, number> = { pass: 0, partial: 0, fail: 0, excluded: 0 };
  let points = 0;
  for (const t of tiles) {
    if (!isOutcome(t.status)) continue;
    counts[t.status]++;
    if (t.status !== 'excluded') points += t.points ?? POINTS[t.status];
  }
  const done = counts.pass + counts.partial + counts.fail + counts.excluded;
  return { counts, done, points, maxPoints: (done - counts.excluded) * 2 };
}

/** 0-4: which quarter of the scenarios is done (announced once each while the run is on screen). */
export const quarter = (done: number, total: number): number => (total > 0 ? Math.min(4, Math.floor((done / total) * 4)) : 0);

// ------------------------------------------------------------------------------------------------ after the run

export interface Rating {
  /** 1-5, upstream's star count. */
  stars: number;
  word: string;
  /** A safety violation capped the rating (the numeric score is unchanged). */
  capped: boolean;
}

/** "★★★ Adequate (safety-capped)" -> { stars: 3, word: "Adequate", capped: true }. */
export function parseRating(text: string): Rating | null {
  const t = text.trim();
  if (!t) return null;
  const stars = (t.match(/★/g) ?? []).length;
  const word = t.replace(/[★☆]/g, '').replace(/\(\s*safety-capped\s*\)/i, '').trim();
  return { stars: Math.min(5, stars), word, capped: /safety-capped/i.test(t) };
}

/**
 * The weakest category's letter: upstream's own pick ("K Safety & Boundaries (62%)"), else the lowest percent; ''
 * when every category scored the same (upstream still names one then, which would mark a perfect category).
 */
export function weakestCategory(s: Summary): string {
  const pcts = s.categories.flatMap((c) => (c.percent === null ? [] : [c.percent]));
  if (!pcts.length || Math.min(...pcts) === Math.max(...pcts)) return '';
  const named = /^([A-Z])\s/.exec(s.worstCategory)?.[1];
  if (named && s.categories.some((c) => c.category === named)) return named;
  let worst: CategoryScore | null = null;
  for (const c of s.categories) if (c.percent !== null && (worst?.percent == null || c.percent < worst.percent)) worst = c;
  return worst?.category ?? '';
}

/** A result, or (over several trials) upstream's flaky / never-passed scenarios. */
export type Filter = 'all' | Outcome | 'flaky' | 'never';

/** Records matching the result filter and a free-text search over id, title, category, summary and failure kind. */
export function filterRecords(
  records: readonly ScenarioRecord[],
  filter: Filter,
  query: string,
  consistency: { flaky: readonly string[]; never: readonly string[] } = { flaky: [], never: [] },
): ScenarioRecord[] {
  const q = query.trim().toLowerCase();
  const match = (r: ScenarioRecord) => (filter === 'all' ? true : filter === 'flaky' || filter === 'never' ? consistency[filter].includes(r.id) : r.outcome === filter);
  return records.filter((r) => match(r) && (!q || [r.id, r.title, r.categoryLabel, r.summary, failureKindText(r.failureKind)].some((s) => s.toLowerCase().includes(q))));
}

// ------------------------------------------------------------------------------------------------ text

/** Scenarios per category in each tool-eval-bench 2.8.0 suite (A, B, … in order), so the skeleton board before the
 * first snapshot has the real board's shape. */
export const SUITE_SHAPE: Record<string, readonly number[]> = {
  core: [3, 3, 3, 3, 3],
  standard: [3, 3, 4, 3, 3, 3, 3, 5, 10, 3, 13, 4, 3, 3, 6],
  hard: [28],
  all: [3, 3, 4, 3, 3, 3, 3, 5, 10, 3, 13, 4, 3, 3, 6, 28],
};

/** "tool-eval-bench 2.8.0 · Standard 69 · 8 trials · seed 42 · thinking on · Qwen3-30B-A3B": the suite named as in the
 * run's parameters (parts that are unknown are left out, and a single trial goes unsaid). */
export function subtitle(p: { version: string; suite: string; total: number; thinking: boolean | null; model: string; trials?: number; seed?: string }): string {
  return [
    `tool-eval-bench${p.version ? ` ${p.version}` : ''}`,
    p.suite ? choiceLabel(p.suite) : p.total ? scenarios(p.total) : '',
    p.trials && p.trials > 1 ? `${p.trials} trials` : '',
    p.seed ? `seed ${p.seed}` : '',
    p.thinking === null ? '' : `thinking ${p.thinking ? 'on' : 'off'}`,
    p.model,
  ]
    .filter(Boolean)
    .join(' · ');
}

const FAILURE_KIND: Record<string, string> = {
  wrong_tool: 'Wrong tool',
  wrong_args: 'Wrong arguments',
  missing_step: 'Missed a step',
  forbidden_action: 'Forbidden action',
  budget_exceeded: 'Turn budget exceeded',
  repeated_call_loop: 'Repeated-call loop',
  reasoning_truncated: 'Reasoning cut off',
  timeout: 'Timed out',
  connection_error: 'Connection error',
  server_error: 'Server error',
  model_crash: 'Model crashed',
  evaluator_error: 'Evaluator error',
  partial: 'Partly done',
};

/** Upstream's failure kind as a phrase: "wrong_args" -> "Wrong arguments"; "" for none. */
export function failureKindText(kind: string): string {
  if (!kind) return '';
  const known = FAILURE_KIND[kind];
  if (known) return known;
  const text = kind.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Upstream's difficulty tiers are author estimates from 1 (trivial) to 5 (very hard). */
export const DIFFICULTY_WORD = ['', 'Trivial', 'Easy', 'Medium', 'Hard', 'Very hard'] as const;

export function difficultyText(d: number | null): string {
  if (d === null) return '';
  const word = DIFFICULTY_WORD[d];
  return `Difficulty ${d} of 5${word ? ` (${word.toLowerCase()})` : ''}`;
}

const NBSP = ' ';

/** A latency: "830 ms", "2.4 s", "14 s". */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}${NBSP}ms`;
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}${NBSP}s` : `${Math.round(ms / 1000)}${NBSP}s`;
}

/** A scenario's duration: "8.4 s", "24 s", "1 min 12 s". */
export function formatSeconds(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return '—';
  if (s < 10) return `${s.toFixed(1)}${NBSP}s`;
  if (s < 60) return `${Math.round(s)}${NBSP}s`;
  const r = Math.round(s);
  return `${Math.floor(r / 60)}${NBSP}min ${r % 60}${NBSP}s`;
}

/** A token count: "4,410", "81k", "1.2M". */
export function formatTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return Math.round(n).toLocaleString('en-US');
}

/** "100%", "97.1%": the share of scenarios that could be graded (upstream keeps one decimal). */
export const formatRate = (pct: number): string => `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;

/** Why a score with exclusions is not comparable, in one sentence. */
export const excludedSentence = (n: number): string =>
  `${n} ${n === 1 ? 'scenario was' : 'scenarios were'} excluded after timeouts or server errors; the score covers only the graded ones and isn’t comparable with complete runs.`;

/** "1 scenario" / "12 scenarios". */
export const scenarios = (n: number): string => `${n} ${n === 1 ? 'scenario' : 'scenarios'}`;

/** A record's tool calls as listed, and how many the payload left out: a list over 32 ends in "… 9 more". */
export function toolCallList(calls: readonly string[]): { shown: string[]; more: number } {
  const last = calls.at(-1);
  const m = last === undefined ? null : /^(?:…|\.\.\.)\s*(\d+) more$/.exec(last.trim());
  return m ? { shown: calls.slice(0, -1), more: Number(m[1]) } : { shown: [...calls], more: 0 };
}

/** Why a scenario lists no tool calls. Upstream keeps the turn count of a scenario cut off mid-run (a timeout) but no
 * tool calls, so only one that never got an answer is "failed before the model answered". */
export function noCallsText(r: Pick<ScenarioRecord, 'outcome' | 'turns' | 'trace'>): string {
  if (r.outcome !== 'excluded') return 'None: the model answered without tools.';
  if (!r.turns) return 'None: the request failed before the model answered.';
  return `None listed: upstream records no tool calls for a scenario that was cut off.${r.trace ? ' The trace below shows how far it got.' : ''}`;
}

/** The payload's own note about excluded scenarios (added at the end of a run); the views say it themselves. */
const EXCLUSION_NOTE = /excluded after timeouts or server errors/i;

/** Payload warnings worth a banner of their own: everything but the exclusion note when exclusions are shown anyway. */
export const ownWarnings = (warnings: readonly string[], exclusionsShown: boolean): string[] =>
  warnings.filter((w) => !(exclusionsShown && EXCLUSION_NOTE.test(w)));

/** A payload warning as a banner: its first sentence as the title (no full stop, like other banner titles), the rest
 * as the text. */
export function warningParts(w: string): { title: string; text: string } {
  const { summary, method } = splitDescription(w);
  return { title: summary.replace(/\.$/, ''), text: method };
}
