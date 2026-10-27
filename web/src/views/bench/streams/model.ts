// Pure logic behind the llm-inference and llm-showcase streams views: guards for the payloads' live snapshot
// ("llm-streams"), llm-inference's per-level detail and the showcase's final outputs, how each stream state looks, card density, the text each card has seen (so the typewriter reveals
// exactly the characters the payload appended), scaling efficiency and the timeline layout. No React, no stores:
// every rule here is unit-tested in model.test.ts. Shapes are documented in spec 01; anything else is tolerated.
import { AudioLines, CircleCheck, CircleDashed, CircleSlash, CircleX, Hourglass, type LucideIcon } from 'lucide-react';
import type { BenchRun } from '../../../lib/types';
import { formatValue } from '../model';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => Math.max(0, Math.round(num(v) ?? 0));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The payload runs at most 32 streams; a malformed snapshot must not flood the page with cards. */
const MAX_STREAMS = 64;

// ------------------------------------------------------------------------------------------------ live snapshot

export type StreamState = 'idle' | 'wait' | 'decode' | 'done' | 'error';
/** What a card shows: the payload's state, or "stopped" for a stream cut off when the run was cancelled or failed. */
export type CardState = StreamState | 'stopped';
const STATES: readonly string[] = ['idle', 'wait', 'decode', 'done', 'error'];

export interface Stream {
  slot: number;
  /** 1-based request number within the level; 0 before the slot's first request. */
  req: number;
  state: StreamState;
  tokens: number;
  max: number | null;
  ttft_ms: number | null;
  /** Recent decode rate; null until 2 tokens and 0.5 s; for a finished request, its final decode rate. */
  tok_s: number | null;
  peak_tok_s: number | null;
  /** Since the request was sent; frozen when it ends, null while idle. */
  elapsed_ms: number | null;
  /** The last characters of the request's answer (reset per request), and how many the slot has written in this
   * level (they grow across its requests). */
  text: string;
  chars: number;
  think: string;
  think_chars: number;
  error: string | null;
  /** llm-showcase: the stream's prompt, shortened. */
  label: string | null;
}

/** One finished level (detail.llm.levels; the live snapshot's completed_levels carry a subset). */
export interface LevelStats {
  level: number;
  requests: number | null;
  ok: number | null;
  failed: number | null;
  wall_s: number | null;
  out_tok_s: number | null;
  decode_tok_s_p50: number | null;
  decode_tok_s_p10: number | null;
  itl_p50_ms: number | null;
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  prefill_tok_s_p50: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export interface LiveSnapshot {
  level: number;
  levels: number[];
  level_index: number;
  requests: number;
  done: number;
  failed: number;
  t: number | null;
  tok_s: number | null;
  tok_s_hist: (number | null)[];
  ttft_p50_ms: number | null;
  completed_levels: LevelStats[];
  streams: Stream[];
  /** An llm-showcase snapshot, and the server's own generation rate (from its /metrics) when it reports one. */
  showcase: boolean;
  server_tok_s: number | null;
}

function parseStream(raw: unknown, i: number): Stream | null {
  const o = obj(raw);
  if (!o) return null;
  const state = typeof o.state === 'string' && STATES.includes(o.state) ? (o.state as StreamState) : 'idle';
  return {
    slot: num(o.slot) === null ? i : count(o.slot),
    req: count(o.req),
    state,
    tokens: count(o.tokens),
    max: num(o.max),
    ttft_ms: num(o.ttft_ms),
    tok_s: num(o.tok_s),
    peak_tok_s: num(o.peak_tok_s),
    elapsed_ms: num(o.elapsed_ms),
    text: str(o.text),
    chars: count(o.chars),
    think: str(o.think),
    think_chars: count(o.think_chars),
    error: typeof o.error === 'string' && o.error ? o.error : null,
    label: typeof o.label === 'string' && o.label ? o.label : null,
  };
}

function parseLevel(raw: unknown): LevelStats | null {
  const o = obj(raw);
  const level = count(o?.level);
  if (!o || level < 1) return null;
  const n = (k: string) => num(o[k]);
  return {
    level,
    requests: n('requests'),
    ok: n('ok'),
    failed: n('failed'),
    wall_s: n('wall_s'),
    out_tok_s: n('out_tok_s'),
    decode_tok_s_p50: n('decode_tok_s_p50'),
    decode_tok_s_p10: n('decode_tok_s_p10'),
    itl_p50_ms: n('itl_p50_ms'),
    ttft_p50_ms: n('ttft_p50_ms'),
    ttft_p95_ms: n('ttft_p95_ms'),
    prefill_tok_s_p50: n('prefill_tok_s_p50'),
    prompt_tokens: n('prompt_tokens'),
    completion_tokens: n('completion_tokens'),
  };
}

/** One entry per level (the last report of a level wins), in ascending order. */
function byLevel<T extends { level: number }>(items: readonly (T | null)[]): T[] {
  const m = new Map<number, T>();
  for (const x of items) if (x) m.set(x.level, x);
  return [...m.values()].sort((a, b) => a.level - b.level);
}

/** The payload's live snapshot, or null when `raw` is not one (another benchmark's, an older agent's, garbage). */
export function parseLive(raw: unknown): LiveSnapshot | null {
  const o = obj(raw);
  if (o?.kind !== 'llm-streams') return null;
  const bySlot = new Map<number, Stream>();
  (Array.isArray(o.streams) ? o.streams : []).slice(0, MAX_STREAMS).forEach((raw, i) => {
    const s = parseStream(raw, i);
    if (s && !bySlot.has(s.slot)) bySlot.set(s.slot, s);
  });
  const streams = [...bySlot.values()].sort((a, b) => a.slot - b.slot);
  const level = count(o.level) || streams.length;
  const levels = [...new Set((Array.isArray(o.levels) ? o.levels : []).map(count).filter((l) => l >= 1))].sort((a, b) => a - b);
  if (!levels.includes(level) && level >= 1) levels.push(level);
  levels.sort((a, b) => a - b);
  return {
    level,
    levels,
    level_index: Math.max(0, levels.indexOf(level)),
    requests: count(o.requests),
    done: count(o.done),
    failed: count(o.failed),
    t: num(o.t),
    tok_s: num(o.tok_s),
    tok_s_hist: (Array.isArray(o.tok_s_hist) ? o.tok_s_hist : []).slice(-240).map(num),
    ttft_p50_ms: num(o.ttft_p50_ms),
    completed_levels: byLevel((Array.isArray(o.completed_levels) ? o.completed_levels : []).map(parseLevel)),
    streams,
    showcase: o.showcase === true,
    server_tok_s: num(o.server_tok_s),
  };
}

// ------------------------------------------------------------------------------------------------ detail

export interface TimelineRequest {
  slot: number;
  req: number;
  /** Seconds since the level started. `first` is null when no token arrived. */
  sent: number;
  first: number | null;
  end: number;
  tokens: number;
  ok: boolean;
}

export interface LevelTimeline {
  level: number;
  requests: TimelineRequest[];
  /** The payload kept only the first requests of a long level. */
  truncated: boolean;
}

export interface LlmDetail {
  levels: LevelStats[];
  timelines: LevelTimeline[];
}

function parseTimeline(level: number, raw: unknown): LevelTimeline | null {
  const o = obj(raw);
  if (!o || level < 1) return null;
  const cols = Array.isArray(o.cols) ? o.cols.map(str) : [];
  const at = (name: string) => cols.indexOf(name);
  const [slot, req, sent, first, end, tokens, ok] = ['slot', 'req', 'sent', 'first', 'end', 'tokens', 'ok'].map(at);
  if (slot === undefined || sent === undefined || end === undefined || slot < 0 || sent < 0 || end < 0) return null;
  // The payload keeps at most 256 rows per level; anything far beyond that is not one of its timelines.
  const requests = (Array.isArray(o.rows) ? o.rows : []).slice(0, 1024).flatMap((row): TimelineRequest[] => {
    if (!Array.isArray(row)) return [];
    const cell = (i: number | undefined): unknown => (i === undefined || i < 0 ? undefined : row[i]);
    const s = num(cell(sent));
    const e = num(cell(end));
    if (s === null || e === null || e < s) return [];
    const f = num(cell(first));
    const firstAt = f !== null && f >= s && f <= e ? f : null;
    const okCell = cell(ok);
    const lane = count(cell(slot));
    if (lane >= MAX_STREAMS) return [];
    return [{ slot: lane, req: count(cell(req)), sent: s, first: firstAt, end: e, tokens: count(cell(tokens)), ok: okCell === undefined ? firstAt !== null : okCell === 1 || okCell === true }];
  });
  return { level, requests, truncated: o.truncated === true };
}

/** detail.llm (levels and per-level timelines), or null when the run has none. */
export function parseDetail(raw: unknown): LlmDetail | null {
  const llm = obj(obj(raw)?.llm);
  if (!llm) return null;
  const tl = obj(llm.timeline) ?? {};
  return {
    levels: byLevel((Array.isArray(llm.levels) ? llm.levels : []).map(parseLevel)),
    timelines: byLevel(Object.entries(tl).map(([k, v]) => parseTimeline(count(Number(k)), v))).filter((t) => t.requests.length > 0),
  };
}

/** One stream of a finished showcase run, its whole text (the live snapshot only carries tails). */
export interface ShowcaseStream {
  slot: number;
  prompt: string;
  state: 'done' | 'error' | 'stopped';
  text: string;
  think: string;
  tokens: number;
  ttft_ms: number | null;
  decode_tok_s: number | null;
  error: string | null;
}

export interface ShowcaseDetail {
  streams: ShowcaseStream[];
  /** The server's own generation rate over the run (its /metrics), or null when it reports none. */
  server_tok_s: { median: number | null; max: number | null; samples: number } | null;
  /** Fill to output length asked for, and whether the server took it (it may reject the extra fields). */
  fill_to_max: { requested: boolean; applied: boolean } | null;
  /** The payload shortened the longest texts to keep the detail small. */
  truncated: boolean;
}

function parseShowcaseStream(raw: unknown, i: number): ShowcaseStream | null {
  const o = obj(raw);
  if (!o) return null;
  return {
    slot: num(o.slot) === null ? i : count(o.slot),
    prompt: str(o.prompt),
    state: o.state === 'done' || o.state === 'error' ? o.state : 'stopped',
    text: str(o.text),
    think: str(o.think),
    tokens: count(o.tokens),
    ttft_ms: num(o.ttft_ms),
    decode_tok_s: num(o.decode_tok_s),
    error: typeof o.error === 'string' && o.error ? o.error : null,
  };
}

/** detail.showcase (every stream's full text), or null when the run has none (an older or cut-off run). */
export function parseShowcase(raw: unknown): ShowcaseDetail | null {
  const sc = obj(obj(raw)?.showcase);
  if (!sc) return null;
  const bySlot = new Map<number, ShowcaseStream>();
  (Array.isArray(sc.streams) ? sc.streams : []).slice(0, MAX_STREAMS).forEach((raw, i) => {
    const s = parseShowcaseStream(raw, i);
    if (s && !bySlot.has(s.slot)) bySlot.set(s.slot, s);
  });
  const server = obj(sc.server_tok_s);
  const fill = obj(sc.fill_to_max);
  return {
    streams: [...bySlot.values()].sort((a, b) => a.slot - b.slot),
    server_tok_s: server ? { median: num(server.median), max: num(server.max), samples: count(server.samples) } : null,
    fill_to_max: fill ? { requested: fill.requested === true, applied: fill.applied === true } : null,
    truncated: sc.truncated === true,
  };
}

/** One stream as Markdown: its prompt, its reasoning if any, then its answer (or why there is none). */
export function streamMarkdown(s: ShowcaseStream): string {
  const parts = [`## Stream ${slotLabel(s.slot)}`];
  if (s.prompt) parts.push(s.prompt.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n'));
  if (s.think) parts.push('### Thinking', s.think.trim());
  parts.push('### Answer', s.text.trim() || '_No answer._');
  if (s.error) parts.push(`**Failed:** ${s.error}`);
  return parts.join('\n\n');
}

/** Every stream as one Markdown document, in slot order. */
export const showcaseMarkdown = (streams: readonly ShowcaseStream[]) => streams.map(streamMarkdown).join('\n\n');

/** Nodes of the run that reported streams (a live snapshot, per-level detail or showcase outputs), in the run's node
 * order. */
export function streamNodes(run: Pick<BenchRun, 'nodes' | 'node_states'>): string[] {
  const states = run.node_states ?? {};
  const has = (n: string) => obj(states[n]?.live)?.kind === 'llm-streams' || obj(obj(states[n]?.detail)?.llm) !== null || obj(obj(states[n]?.detail)?.showcase) !== null;
  const order = [...run.nodes, ...Object.keys(states).filter((n) => !run.nodes.includes(n))];
  return order.filter(has);
}

// ------------------------------------------------------------------------------------------------ looks

export interface StateLook {
  label: string;
  icon: LucideIcon;
  /** A status tone (.tone-*), or the accent for the one state that is activity rather than status. */
  tone: 'ok' | 'crit' | 'stale' | 'accent';
}

export const STATE_LOOK: Record<CardState, StateLook> = {
  idle: { label: 'Idle', icon: CircleDashed, tone: 'stale' },
  wait: { label: 'Waiting', icon: Hourglass, tone: 'stale' },
  decode: { label: 'Decoding', icon: AudioLines, tone: 'accent' },
  done: { label: 'Done', icon: CircleCheck, tone: 'ok' },
  error: { label: 'Failed', icon: CircleX, tone: 'crit' },
  stopped: { label: 'Stopped', icon: CircleSlash, tone: 'stale' },
};

/** A stream still in flight when the run ended (cancelled, failed) was stopped, not finished. */
export const cardState = (s: Pick<Stream, 'state'>, runActive: boolean): CardState =>
  !runActive && (s.state === 'wait' || s.state === 'decode') ? 'stopped' : s.state;

export const slotLabel = (slot: number) => `#${String(slot + 1).padStart(2, '0')}`;

/** "412", "46.1" tokens/s; an em dash when unknown. */
export const formatTokS = (v: number | null | undefined) => formatValue(v);

/** "210 ms", "1.24 s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return Math.abs(ms) < 1000 ? `${formatValue(ms)} ms` : `${formatValue(ms / 1000)} s`;
}

/** The card's accessible name: slot, state and request ("Stream #03: decoding, request 5 of 8") or a showcase
 * stream's prompt, and a failure's message. It changes only with those: the live numbers stay visible text, so a focused card is not re-read on every
 * snapshot. */
export function streamSummary(s: Stream, state: CardState, requests: number, showcase = false): string {
  const parts = [`Stream ${slotLabel(s.slot)}: ${STATE_LOOK[state].label.toLowerCase()}`];
  // A showcase stream runs one request, its prompt: the prompt names it rather than a request number.
  if (showcase) {
    if (s.label) parts.push(s.label);
  } else if (s.req > 0) parts.push(requests > 0 ? `request ${s.req} of ${requests}` : `request ${s.req}`);
  if (state === 'error' && s.error) parts.push(s.error);
  return parts.join(', ');
}

/** How many streams are in each state, for the dot matrix's summary. */
export function stateCounts(streams: readonly Stream[], runActive = true): Record<CardState, number> {
  const out: Record<CardState, number> = { idle: 0, wait: 0, decode: 0, done: 0, error: 0, stopped: 0 };
  for (const s of streams) out[cardState(s, runActive)]++;
  return out;
}

/** "6 decoding, 1 waiting, 1 done" (states with no stream left out). */
export function countsText(c: Record<CardState, number>): string {
  const order: CardState[] = ['decode', 'wait', 'done', 'error', 'stopped', 'idle'];
  return order.filter((k) => c[k] > 0).map((k) => `${c[k]} ${STATE_LOOK[k].label.toLowerCase()}`).join(', ') || 'No streams';
}

// ------------------------------------------------------------------------------------------------ density

export type Density = 'large' | 'medium' | 'compact';
/** What the viewer picked: nothing yet (sized by the stream count), text, or one line per stream. */
export type DensityChoice = 'auto' | 'text' | 'compact';

/** Large text up to 4 streams, medium up to 12, one line from 13 on; the viewer's choice overrides (asking for text at
 * 13 or more gives medium cards). */
export function densityFor(streams: number, choice: DensityChoice): Density {
  if (choice === 'compact') return 'compact';
  if (streams <= 4) return 'large';
  return streams <= 12 || choice === 'text' ? 'medium' : 'compact';
}

/** Most columns the grid uses, for balanced rows: 4 streams as 2 × 2, 6 as 3 × 2, 9 as 3 × 3, else up to 4 wide.
 * Narrow screens use fewer (each card keeps a minimum width). */
export function gridColumns(streams: number, density: Density): number {
  if (density === 'compact') return 4;
  if (streams <= 3) return Math.max(1, streams);
  if (streams === 4) return 2;
  return streams === 5 || streams === 6 || streams === 9 ? 3 : 4;
}

// ------------------------------------------------------------------------------------------------ text

/** The text a card has seen of one request: longer than the payload's tail, so a large card or the stream dialog can
 * show more than the last 280 characters. `added`: characters (UTF-16 units) the latest snapshot appended. */
export interface SlotText {
  key: string;
  answer: string;
  think: string;
  chars: number;
  thinkChars: number;
  added: number;
  thinkAdded: number;
}
export type Texts = ReadonlyMap<number, SlotText>;

export const ANSWER_CAP = 3000;
export const THINK_CAP = 1500;
/** Marks characters that went by between two snapshots without being seen (a stream faster than the tail is long). */
export const GAP = ' … ';

/**
 * The characters appended since `prevChars`, from a tail that ends at character `chars` (counts are code points,
 * like the payload's): exactly the new ones, or the whole tail with `gap` when more arrived than the tail holds.
 */
export function appendedText(tail: string, prevChars: number, chars: number): { text: string; gap: boolean } {
  const n = chars - prevChars;
  if (n <= 0) return { text: '', gap: false };
  const points = Array.from(tail);
  if (n <= points.length) return { text: points.slice(points.length - n).join(''), gap: false };
  return { text: tail, gap: true };
}

/** The last `cap` UTF-16 units of `s`, never starting inside a surrogate pair. */
function keepTail(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const cut = s.length - cap;
  const c = s.charCodeAt(cut);
  return s.slice(c >= 0xdc00 && c <= 0xdfff ? cut + 1 : cut);
}

/**
 * Fold a new snapshot into the text each slot has seen. A slot seen for the first time starts from the payload's tail
 * with nothing to animate; a new request (another level, slot or request number, or counts that went backwards) starts
 * over and types its first characters; otherwise exactly the appended characters are added.
 */
export function accumulate(prev: Texts | null, snap: LiveSnapshot): Texts {
  const next = new Map<number, SlotText>();
  for (const s of snap.streams) {
    const key = `${snap.level}:${s.slot}:${s.req}`;
    const p = prev?.get(s.slot);
    if (!p || p.key !== key || s.chars < p.chars || s.think_chars < p.thinkChars) {
      next.set(s.slot, { key, answer: s.text, think: s.think, chars: s.chars, thinkChars: s.think_chars, added: p ? s.text.length : 0, thinkAdded: p ? s.think.length : 0 });
      continue;
    }
    const a = appendedText(s.text, p.chars, s.chars);
    const t = appendedText(s.think, p.thinkChars, s.think_chars);
    const answerAdd = (a.gap && p.answer ? GAP : '') + a.text;
    const thinkAdd = (t.gap && p.think ? GAP : '') + t.text;
    next.set(s.slot, {
      key,
      answer: keepTail(p.answer + answerAdd, ANSWER_CAP),
      think: keepTail(p.think + thinkAdd, THINK_CAP),
      chars: s.chars,
      thinkChars: s.think_chars,
      added: answerAdd.length,
      thinkAdded: thinkAdd.length,
    });
  }
  return next;
}

/** Texts straight from a snapshot, nothing to animate (the final outputs of a finished run). */
export const textsOf = (snap: LiveSnapshot): Texts => accumulate(null, snap);

// ------------------------------------------------------------------------------------------------ sweep

/** The level with the highest output tokens/s, or null. */
export function peakLevel(levels: readonly LevelStats[]): number | null {
  let best: LevelStats | null = null;
  for (const l of levels) if (l.out_tok_s != null && (best?.out_tok_s == null || l.out_tok_s > best.out_tok_s)) best = l;
  return best?.level ?? null;
}

/**
 * Output tokens/s at a level as a share of perfect scaling: `level` streams each as fast as one stream alone (level
 * 1's output tokens/s), so one stream reads 100%. Null without a level-1 measurement.
 */
export function scalingEfficiency(row: LevelStats, levels: readonly LevelStats[]): number | null {
  const one = levels.find((l) => l.level === 1)?.out_tok_s;
  if (one == null || one <= 0 || row.out_tok_s == null) return null;
  return row.out_tok_s / (row.level * one);
}

/** Levels as recorded: detail.llm.levels when the run has them, else the live snapshot's finished levels. */
export function recordedLevels(detail: LlmDetail | null, live: LiveSnapshot | null): LevelStats[] {
  return detail?.levels.length ? detail.levels : (live?.completed_levels ?? []);
}

// ------------------------------------------------------------------------------------------------ timeline

/** Lane height in px: roomy for a few streams, tight at 32 (the bar inside leaves a gap between lanes). */
export const laneHeight = (lanes: number) => (lanes <= 8 ? 22 : lanes <= 16 ? 15 : 13);

/** Round axis steps (1, 2 or 5 × 10^k) covering 0..max with about `target` intervals. */
export function niceTicks(max: number, target = 6): { step: number; top: number; ticks: number[] } {
  const span = max > 0 && Number.isFinite(max) ? max : 1;
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const top = Math.ceil(span / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i * step <= top + step / 1e6; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { step, top, ticks };
}

/** A finished request's decode speed: (tokens − 1) from its first token to its end. */
export function requestRate(r: TimelineRequest): number | null {
  if (r.first === null || r.tokens < 2 || r.end <= r.first) return null;
  return (r.tokens - 1) / (r.end - r.first);
}

/** "Request 5 · TTFT 210 ms · 128 tokens · 46.0 tok/s", or "Request 7 · failed after 1.20 s". */
export function requestText(r: TimelineRequest): string {
  if (!r.ok) return `Request ${r.req} · failed after ${formatMs((r.end - r.sent) * 1000)}`;
  const rate = requestRate(r);
  return [`Request ${r.req}`, r.first !== null ? `TTFT ${formatMs((r.first - r.sent) * 1000)}` : null, `${r.tokens} ${r.tokens === 1 ? 'token' : 'tokens'}`, rate !== null ? `${formatTokS(rate)} tok/s` : null]
    .filter(Boolean)
    .join(' · ');
}

/** The requests of one lane in time order, and the number of lanes (slots) the level ran. */
export function lanesOf(t: LevelTimeline): { lanes: number; bySlot: TimelineRequest[][] } {
  const lanes = Math.min(MAX_STREAMS, Math.max(t.level, ...t.requests.map((r) => r.slot + 1)));
  const bySlot = Array.from({ length: lanes }, () => [] as TimelineRequest[]);
  for (const r of t.requests) bySlot[r.slot]?.push(r);
  for (const l of bySlot) l.sort((a, b) => a.sent - b.sent);
  return { lanes, bySlot };
}
