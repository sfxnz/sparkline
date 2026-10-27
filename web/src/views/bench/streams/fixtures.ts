// Test and gallery fixtures for the streams view, shaped like the llm-inference payload's live snapshots and detail
// (spec 01): explicit card states, and a deterministic simulator of a run (closed-loop slots per level, staggered first
// tokens, slower decoding at higher concurrency, an occasional straggler) for live previews and finished sweeps.
import type { BenchRun, BenchSpec, NodeBenchState } from '../../../lib/types';
import { LLM, run } from '../fixtures';
import { llmLevels } from '../model';

/** What a summarising model might write back (the payload asks it to summarise a text). */
const ANSWERS = [
  'The passage describes how a small coastal town adapted when its fishing fleet shrank. Families who had worked the boats for generations turned to boat repair, guided tours and a cooperative smokehouse. The council rebuilt the harbour wall after the winter storms and leased the old ice house to a group of young bakers. Visitor numbers doubled within five years, but the author notes that most of the new jobs are seasonal and that housing has become hard to afford for people who grew up there.',
  'In short, the text argues that sourdough is less about a secret recipe than about patience and temperature. A lively starter, flour with enough protein and a long, cool rise do most of the work. The writer recommends weighing everything, folding the dough every half hour during the first two hours, and baking in a preheated cast-iron pot so the crust can set before the steam escapes. Over-proofed loaves spread and taste sour; under-proofed ones tear along the score.',
  'Summary: the report compares three ways of cooling a small server room. Moving more air is cheapest to install but loses efficiency once the racks are dense. Rear-door heat exchangers handle higher loads without changing the servers. Direct liquid cooling removes the most heat per rack and lets the fans slow down, but it needs new plumbing, leak detection and staff who are comfortable maintaining it. The authors suggest starting with containment and blanking panels, which cost little and often recover a surprising amount of headroom.',
  'The article follows a volunteer team restoring a 1930s railway carriage. They spent the first winter removing layers of paint and cataloguing every fitting, then rebuilt the frame using timber from a demolished chapel. The original brass lamps were found in a scrapyard two counties away. Progress was slow because each repair had to be approved by the heritage trust, yet the volunteers describe the work as the most satisfying thing they have done in retirement.',
  'Put simply, the study found that people remember a route better when they walk it than when they watch a video of the same walk. Participants who walked made fewer wrong turns a week later and could draw more accurate sketch maps. The effect was strongest at junctions with distinctive landmarks such as a red door or a fountain. The researchers think physical movement ties the scenery to a sense of direction, and they plan to test whether the benefit holds for older adults.',
  'The letter, written in 1847 by a ship’s surgeon, describes a long crossing to Halifax. Food ran short after a storm damaged the stores, and the surgeon rationed fresh water by the cup. He writes warmly about the cook, who kept a pot of thin soup going day and night, and with some frustration about the captain, who refused to change course. Two passengers fell ill with fever; both recovered. The letter ends with a request for news of his sister and a list of books he wants sent out.',
  'This text explains why rivers meander. Water flows faster on the outside of a bend, wearing the bank away, while slower water on the inside drops sand and gravel. Over decades the bend grows more pronounced until, during a flood, the river cuts across the narrow neck and leaves the old loop behind as an oxbow lake. Engineers who straighten rivers often find that the water simply starts carving new curves, sometimes undermining the very banks they meant to protect.',
  'Summarised, the guide recommends a gentle start for anyone taking up running. Alternate one minute of easy jogging with two minutes of walking for the first fortnight, and add time rather than speed. Run on soft paths where possible, keep a conversational pace, and rest at least one day between sessions. Most early injuries come from doing too much too soon, so the author suggests increasing the weekly total by no more than ten percent and treating sore shins as a signal to slow down.',
];

const THOUGHTS = [
  'The user wants a summary. The text is about a coastal town, so I should cover what changed, how people responded and the trade-offs the author points out. Keep it to one paragraph and avoid adding opinions that are not in the source.',
  'Let me think about the structure first: main claim, the practical steps, then the warning signs. The writer gives specific timings, so I will keep those numbers. No need to repeat the ingredient list.',
  'Three options are compared. I should state each one with its main advantage and cost, then the recommendation at the end. The audience seems technical, so plain terms are fine, but no jargon beyond what the report uses.',
  'This is a historical letter. A good summary keeps the date, the route and the people involved, and notes the tone of the writer. I will mention the illness and the recovery because the letter spends a lot of time on them.',
];

/** The first `n` characters a request has written (passages repeat for long outputs). */
function written(corpus: readonly string[], i: number, n: number): string {
  const base = corpus[i % corpus.length] ?? '';
  let s = base;
  while (s.length < n) s += ` ${base}`;
  return s.slice(0, Math.max(0, Math.round(n)));
}
const tail = (s: string, n: number) => s.slice(Math.max(0, s.length - n));

// ------------------------------------------------------------------------------------------------ explicit states

export interface StreamInit {
  state: 'idle' | 'wait' | 'decode' | 'done' | 'error';
  req?: number;
  tokens?: number;
  max?: number;
  ttft_ms?: number | null;
  tok_s?: number | null;
  peak_tok_s?: number | null;
  elapsed_ms?: number;
  /** Characters written so far (answer, reasoning); the text comes from the corpus. */
  chars?: number;
  think_chars?: number;
  error?: string | null;
}

/** A raw stream entry as the payload sends it. */
export function stream(slot: number, p: StreamInit): Record<string, unknown> {
  const chars = p.chars ?? (p.state === 'decode' || p.state === 'done' ? Math.round((p.tokens ?? 0) * 4.2) : 0);
  const thinkChars = p.think_chars ?? 0;
  return {
    slot,
    req: p.req ?? slot + 1,
    state: p.state,
    tokens: p.tokens ?? 0,
    max: p.max ?? 128,
    ttft_ms: p.ttft_ms ?? (p.state === 'decode' || p.state === 'done' ? 180 + slot * 9 : null),
    tok_s: p.tok_s ?? (p.state === 'decode' ? 41 + ((slot * 7) % 9) : p.state === 'done' ? 44 + (slot % 5) : null),
    peak_tok_s: p.peak_tok_s ?? (p.state === 'decode' || p.state === 'done' ? 47 + (slot % 4) : null),
    elapsed_ms: p.elapsed_ms ?? (p.state === 'idle' ? null : 0),
    text: tail(written(ANSWERS, slot, chars), 280),
    chars,
    think: tail(written(THOUGHTS, slot, thinkChars), 160),
    think_chars: thinkChars,
    error: p.error ?? null,
  };
}

/** A raw live snapshot around the given streams. */
export function snapshot(streams: Record<string, unknown>[], p: Record<string, unknown> = {}): Record<string, unknown> {
  const level = streams.length;
  return {
    kind: 'llm-streams',
    v: 1,
    level,
    levels: [level],
    level_index: 0,
    requests: Math.max(8, level),
    done: streams.filter((s) => s.state === 'done' || s.state === 'error').length,
    failed: streams.filter((s) => s.state === 'error').length,
    t: 6.4,
    tok_s: streams.reduce((a, s) => a + (typeof s.tok_s === 'number' ? s.tok_s : 0), 0),
    tok_s_hist: [0, 0, 31, 88, 140, 166, 171, 168, 174, 170, 173],
    ttft_p50_ms: 214.6,
    completed_levels: [],
    streams,
    ...p,
  };
}

/** Every card state at once: reasoning then answer, answer only, waiting, done. */
export const LIVE_4 = snapshot([
  stream(0, { state: 'decode', tokens: 61, think_chars: 150, chars: 104, tok_s: 46.8, elapsed_ms: 1530 }),
  stream(1, { state: 'decode', tokens: 88, tok_s: 44.1, elapsed_ms: 2160 }),
  stream(2, { state: 'wait', req: 5, elapsed_ms: 340 }),
  stream(3, { state: 'done', tokens: 128, ttft_ms: 191.4, elapsed_ms: 3080, req: 4 }),
], { requests: 8, done: 1 });

const MIXED: StreamInit['state'][] = ['decode', 'decode', 'wait', 'decode', 'done', 'decode', 'error', 'decode', 'decode', 'wait', 'decode', 'done'];

/** Twelve medium cards, one failed. */
export const LIVE_12 = snapshot(
  MIXED.map((state, i) =>
    stream(i, state === 'error'
      ? { state, tokens: 12, error: 'HTTP 503: the engine is overloaded, try again later', elapsed_ms: 2400 }
      : state === 'wait'
        ? { state, elapsed_ms: 120 + i * 40 }
        : { state, tokens: state === 'done' ? 128 : 20 + ((i * 37) % 100), elapsed_ms: 2900, ttft_ms: state === 'done' ? 402 : undefined }),
  ),
  { requests: 12, tok_s_hist: [0, 64, 210, 301, 322, 318, 326, 331] },
);

/** Thirty-two one-line cards. */
export const LIVE_32 = snapshot(
  Array.from({ length: 32 }, (_, i) => {
    const state: StreamInit['state'] = i % 11 === 3 ? 'wait' : i % 13 === 7 ? 'done' : 'decode';
    if (state === 'wait') return stream(i, { state, elapsed_ms: 900 + i * 20 });
    return stream(i, { state, tokens: state === 'done' ? 128 : 8 + ((i * 29) % 110), tok_s: state === 'decode' ? 11 + ((i * 5) % 4) : null, elapsed_ms: 9000, ttft_ms: state === 'done' ? 1310 : undefined });
  }),
  { requests: 32, tok_s_hist: [0, 41, 190, 330, 371, 382, 388, 385, 391], ttft_p50_ms: 1290 },
);

// ------------------------------------------------------------------------------------------------ simulator

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Planned {
  slot: number;
  req: number;
  sent: number;
  first: number;
  end: number;
  tokens: number;
  thinkTokens: number;
  rate: number;
  ok: boolean;
}

export interface SimOptions {
  concurrency: number;
  sweep: boolean;
  requests: number;
  maxTokens: number;
  promptTokens?: number;
  /** The model writes reasoning for the first ~15% of its tokens. */
  reasoning?: boolean;
  seed?: number;
}

const CHARS_PER_TOKEN = 4.2;

/** One level as the payload runs it: `level` slots each take the next request as soon as their last one ends. */
function planLevel(level: number, o: SimOptions, rand: () => number): Planned[] {
  const free = Array.from({ length: level }, (_, i) => i * 0.04);
  const out: Planned[] = [];
  const n = Math.max(o.requests, level);
  for (let req = 1; req <= n; req++) {
    const slot = free.indexOf(Math.min(...free));
    const sent = free[slot] ?? 0;
    const ttft = (0.16 + 0.034 * level) * (0.82 + 0.36 * rand()) * ((o.promptTokens ?? 512) / 512) ** 0.6;
    const straggler = rand() < 0.04 ? 0.8 : 1;
    const rate = ((46 / (1 + 0.09 * (level - 1))) * (0.93 + 0.14 * rand()) * straggler);
    const tokens = rand() < 0.15 ? Math.round(o.maxTokens * (0.55 + 0.4 * rand())) : o.maxTokens;
    const ok = !(level >= 16 && rand() < 0.03);
    const first = sent + ttft;
    const end = ok ? first + (tokens - 1) / rate : first + 0.6 * rand();
    out.push({ slot, req, sent, first, end, tokens: ok ? tokens : Math.round(rate * (end - first)), thinkTokens: o.reasoning ? Math.round(tokens * 0.15) : 0, rate, ok });
    free[slot] = end;
  }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] ?? 0) : 0;
};
const pctile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0) : 0;
};

/** A level's summary as the payload reports it in detail.llm.levels. */
function levelStats(level: number, plan: Planned[], promptTokens: number): Record<string, unknown> {
  const ok = plan.filter((r) => r.ok);
  const wall = Math.max(...plan.map((r) => r.end));
  const decode = ok.map((r) => (r.tokens - 1) / (r.end - r.first));
  const ttft = ok.map((r) => (r.first - r.sent) * 1000);
  const completion = ok.reduce((a, r) => a + r.tokens, 0);
  return {
    level,
    requests: plan.length,
    ok: ok.length,
    failed: plan.length - ok.length,
    wall_s: Math.round(wall * 1000) / 1000,
    out_tok_s: r1(completion / wall),
    decode_tok_s_p50: r1(median(decode)),
    decode_tok_s_p10: r1(pctile(decode, 0.1)),
    itl_p50_ms: r1(1000 / median(decode)),
    ttft_p50_ms: r1(median(ttft)),
    ttft_p95_ms: r1(pctile(ttft, 0.95)),
    prefill_tok_s_p50: r1(promptTokens / (median(ttft) / 1000)),
    prompt_tokens: promptTokens * ok.length,
    completion_tokens: completion,
  };
}

/** What a run of these options produces: per level its plan, how long it took, and the detail the payload emits. */
export function simulate(o: SimOptions) {
  const rand = random(o.seed ?? 7);
  const levels = llmLevels(o.concurrency, o.sweep);
  const plans = levels.map((l) => planLevel(l, o, rand));
  const walls = plans.map((p) => Math.max(...p.map((r) => r.end)) + 0.4);
  const prompt = o.promptTokens ?? 512;
  const detail = (upTo = levels.length) => ({
    llm: {
      levels: levels.slice(0, upTo).map((l, i) => levelStats(l, plans[i] ?? [], prompt)),
      timeline: Object.fromEntries(
        levels.slice(0, upTo).map((l, i) => [
          String(l),
          {
            cols: ['slot', 'req', 'sent', 'first', 'end', 'tokens', 'ok'],
            rows: (plans[i] ?? []).map((r) => [r.slot, r.req, Math.round(r.sent * 1e4) / 1e4, r.ok ? Math.round(r.first * 1e4) / 1e4 : null, Math.round(r.end * 1e4) / 1e4, r.tokens, r.ok ? 1 : 0]),
            truncated: false,
          },
        ]),
      ),
    },
  });

  /** The live snapshot `at` seconds into the run (levels back to back), as the payload would emit it. */
  const liveAt = (at: number): Record<string, unknown> => {
    let k = 0;
    let t = at;
    while (k < levels.length - 1 && t >= (walls[k] ?? 0)) t -= walls[k++] ?? 0;
    const level = levels[k] ?? 1;
    const plan = plans[k] ?? [];
    t = Math.min(t, walls[k] ?? t);
    const tokensAt = (r: Planned, when: number) => (when < r.first ? 0 : Math.min(r.tokens, 1 + Math.floor((Math.min(when, r.end) - r.first) * r.rate)));
    const totalAt = (when: number) => plan.reduce((a, r) => a + tokensAt(r, when), 0);
    const streams = Array.from({ length: level }, (_, slot) => {
      const mine = plan.filter((r) => r.slot === slot && r.sent <= t);
      const r = mine.at(-1);
      if (!r) return stream(slot, { state: 'idle', req: 0 });
      const live = t < r.end;
      const tokens = tokensAt(r, t);
      const state = live ? (t < r.first ? 'wait' : 'decode') : r.ok ? 'done' : 'error';
      const thinkTok = Math.min(tokens, r.thinkTokens);
      const recent = tokens - tokensAt(r, t - 1.5);
      const answerChars = Math.round((tokens - thinkTok) * CHARS_PER_TOKEN);
      const thinkChars = Math.round(thinkTok * CHARS_PER_TOKEN);
      // The payload's counts grow across the slot's requests within a level; the text tails restart per request.
      const before = mine.slice(0, -1);
      const charsBefore = before.reduce((a, q) => a + Math.round((q.tokens - q.thinkTokens) * CHARS_PER_TOKEN), 0);
      const thinkBefore = before.reduce((a, q) => a + Math.round(q.thinkTokens * CHARS_PER_TOKEN), 0);
      return {
        slot,
        req: r.req,
        state,
        tokens,
        max: o.maxTokens,
        ttft_ms: t >= r.first ? r1((r.first - r.sent) * 1000) : null,
        tok_s: state === 'done' ? r1((r.tokens - 1) / (r.end - r.first)) : state === 'decode' && tokens >= 2 && t - r.first >= 0.5 ? r1(recent / Math.min(1.5, t - r.first)) : null,
        peak_tok_s: tokens >= 2 ? r1(r.rate * 1.06) : null,
        elapsed_ms: Math.round((Math.min(t, r.end) - r.sent) * 1000),
        text: tail(written(ANSWERS, r.req + slot, answerChars), 280),
        chars: charsBefore + answerChars,
        think: tail(written(THOUGHTS, r.req, thinkChars), 160),
        think_chars: thinkBefore + thinkChars,
        error: state === 'error' ? 'HTTP 503: the engine is overloaded, try again later' : null,
      };
    });
    const firsts = plan.filter((r) => r.first <= t && r.ok).map((r) => (r.first - r.sent) * 1000);
    const hist: number[] = [];
    for (let s = 0.5; s <= t; s += 0.5) hist.push(r1((totalAt(s) - totalAt(Math.max(0, s - 2))) / Math.min(2, s)));
    return {
      kind: 'llm-streams',
      v: 1,
      level,
      levels,
      level_index: k,
      requests: plan.length,
      done: plan.filter((r) => r.end <= t).length,
      failed: plan.filter((r) => r.end <= t && !r.ok).length,
      t: Math.round(t * 1000) / 1000,
      tok_s: t > 0 && totalAt(t) > 0 ? r1((totalAt(t) - totalAt(Math.max(0, t - 2))) / Math.min(2, t)) : null,
      tok_s_hist: hist.slice(-240),
      ttft_p50_ms: firsts.length ? r1(median(firsts)) : null,
      completed_levels: levels.slice(0, k).map((l, i) => levelStats(l, plans[i] ?? [], prompt)),
      streams,
    };
  };

  const starts = walls.map((_, k) => walls.slice(0, k).reduce((a, w) => a + w, 0));
  return { levels, starts, duration: walls.reduce((a, w) => a + w, 0), liveAt, detail };
}

// ------------------------------------------------------------------------------------------------ runs

/** The real llm-inference parameters (the shared LLM fixture's are illustrative). */
export const LLM_SPEC: BenchSpec = {
  ...LLM,
  description: 'Streams requests to an OpenAI-compatible endpoint and measures time to first token, prefill and decode speed.',
  est_duration_s: 62.2,
  params: [
    { name: 'base_url', label: 'Endpoint', type: 'string', default: 'http://127.0.0.1:8000', min: null, max: null, choices: null, unit: null, help: null },
    { name: 'model', label: 'Model', type: 'string', default: '', min: null, max: null, choices: null, unit: null, help: null },
    { name: 'prompt_tokens', label: 'Prompt length', type: 'int', default: 512, min: 16, max: 65536, choices: null, unit: 'tokens', help: null },
    { name: 'max_tokens', label: 'Output length', type: 'int', default: 128, min: 1, max: 4096, choices: null, unit: 'tokens', help: null },
    { name: 'concurrency', label: 'Concurrency', type: 'int', default: 1, min: 1, max: 32, choices: null, unit: null, help: null },
    { name: 'requests', label: 'Requests', type: 'int', default: 8, min: 1, max: 512, choices: null, unit: null, help: null },
    { name: 'sweep', label: 'Sweep concurrency', type: 'bool', default: false, min: null, max: null, choices: null, unit: null, help: null },
  ],
};

export function nodeState(p: Partial<NodeBenchState> = {}): NodeBenchState {
  return {
    run_id: 'r1',
    bench_id: 'llm-inference',
    node_id: 'spark1',
    role: 'single',
    status: 'running',
    progress: 0.4,
    phase: '',
    ready: false,
    started_ts: 1_759_750_002,
    finished_ts: null,
    results: [],
    series: {},
    metadata: {},
    error: null,
    log_tail: [],
    ...p,
  };
}

/** An llm-inference run on spark1 (or the given nodes' states). */
export function llmRun(p: Partial<BenchRun> & { live?: Record<string, unknown>; detail?: Record<string, unknown> } = {}): BenchRun {
  const { live, detail, ...rest } = p;
  const status = rest.status ?? 'running';
  return run({
    id: 'llm1',
    bench_id: 'llm-inference',
    params: { base_url: 'http://10.20.20.48:8000', model: '', api: 'chat', prompt_tokens: 512, max_tokens: 128, concurrency: 8, requests: 8, sweep: false },
    status,
    finished_ts: status === 'running' || status === 'queued' ? null : 1_759_750_092,
    progress: status === 'running' ? 0.4 : 1,
    node_states: live || detail ? { spark1: nodeState({ status, live: live ?? {}, detail: detail ?? {} }) } : {},
    ...rest,
  });
}

// ------------------------------------------------------------------------------------------------ llm-showcase

/** One prompt per answer above (same order), as a showcase stream would send it. */
export const PROMPTS = [
  'Summarise a short article about a coastal town that lost its fishing fleet and found new work.',
  'In one paragraph, sum up a guide to baking sourdough at home.',
  'Summarise a report comparing three ways to cool a small server room.',
  'Give a short summary of an article about volunteers restoring a 1930s railway carriage.',
  'Summarise a study on whether walking a route helps people remember it.',
  'Summarise an 1847 letter from a ship’s surgeon crossing to Halifax.',
  'Explain, in a short summary, why rivers meander and form oxbow lakes.',
  'Summarise a beginner’s guide to taking up running without getting hurt.',
];
/** The live snapshot's label: whitespace collapsed, at most 60 characters. */
const labelOf = (p: string) => (p.length > 60 ? `${p.slice(0, 59).trimEnd()}…` : p);

/** The showcase's parameters as the agent's catalog reports them. */
export const SHOWCASE_SPEC: BenchSpec = {
  ...LLM,
  id: 'llm-showcase',
  name: 'LLM showcase',
  description: 'Watch a model you are already serving answer several prompts at once, side by side.',
  est_duration_s: 30.6,
  params: [
    { name: 'base_url', label: 'Endpoint', type: 'string', default: 'http://127.0.0.1:8000', min: null, max: null, choices: null, unit: null, help: null },
    { name: 'model', label: 'Model', type: 'string', default: '', min: null, max: null, choices: null, unit: null, help: null },
    { name: 'streams', label: 'Streams', type: 'int', default: 4, min: 1, max: 32, choices: null, unit: null, help: null },
    { name: 'prompt_type', label: 'Prompts', type: 'enum', default: 'text', min: null, max: null, choices: ['text', 'structural', 'mixed'], unit: null, help: null },
    { name: 'max_tokens', label: 'Output length', type: 'int', default: 512, min: 64, max: 2048, choices: null, unit: 'tokens', help: null },
    { name: 'fill_to_max', label: 'Fill to output length', type: 'bool', default: true, min: null, max: null, choices: null, unit: null, help: null },
    { name: 'temperature', label: 'Temperature', type: 'float', default: 0.7, min: 0, max: 2, choices: null, unit: null, help: null },
    { name: 'thinking', label: 'Thinking', type: 'bool', default: false, min: null, max: null, choices: null, unit: null, help: null },
  ],
};

export const showcaseParams = (streams: number, maxTokens = 512) => ({ base_url: 'http://10.20.20.48:8000', model: '', streams, prompt_type: 'text', max_tokens: maxTokens, fill_to_max: true, temperature: 0.7, thinking: false });

/** An llm-inference snapshot made a showcase one: the flag, the server's rate and each stream's prompt. `promptOf`
 * picks a slot's prompt, to match its answer (stream() writes answer `slot`, the simulator `req + slot`). */
export function asShowcase(snap: Record<string, unknown>, serverTokS: number | null = 182.4, promptOf: (slot: number, req: number) => number = (slot) => slot): Record<string, unknown> {
  const streams = (snap.streams as Record<string, unknown>[]).map((s) => {
    const slot = Number(s.slot);
    return { ...s, label: labelOf(PROMPTS[promptOf(slot, Number(s.req)) % PROMPTS.length] ?? '') };
  });
  return { ...snap, showcase: true, server_tok_s: serverTokS, streams };
}

/** Four showcase streams mid-run: reasoning then answer, answer only, waiting, done. */
export const SHOWCASE_LIVE_4 = asShowcase(LIVE_4);

export interface ShowcaseInit {
  state?: 'done' | 'error' | 'stopped';
  chars?: number;
  think_chars?: number;
  tokens?: number;
  error?: string | null;
}

/** A finished showcase's detail: per stream its prompt and whole text. */
export function showcaseDetail(streams: number, p: { each?: (slot: number) => ShowcaseInit; serverTokS?: boolean; fill?: { requested: boolean; applied: boolean }; truncated?: boolean } = {}): Record<string, unknown> {
  return {
    showcase: {
      streams: Array.from({ length: streams }, (_, slot) => {
        const o = p.each?.(slot) ?? {};
        const state = o.state ?? 'done';
        return {
          slot,
          prompt: PROMPTS[slot % PROMPTS.length],
          state,
          text: written(ANSWERS, slot, o.chars ?? (state === 'done' ? 1400 + slot * 37 : 0)),
          think: written(THOUGHTS, slot, o.think_chars ?? 0),
          tokens: o.tokens ?? (state === 'done' ? 512 : 0),
          ttft_ms: state === 'done' || o.chars ? r1(190 + slot * 11.3) : null,
          decode_tok_s: state === 'done' ? r1(46.2 - slot * 0.7) : null,
          error: o.error ?? null,
        };
      }),
      server_tok_s: p.serverTokS === false ? null : { median: 181.6, max: 188.2, samples: 40 },
      fill_to_max: p.fill ?? { requested: true, applied: true },
      truncated: p.truncated ?? false,
    },
  };
}

/** An llm-showcase run on spark1. */
export function showcaseRun(p: Partial<BenchRun> & { live?: Record<string, unknown>; detail?: Record<string, unknown> } = {}): BenchRun {
  return llmRun({ id: 'sc1', bench_id: 'llm-showcase', params: showcaseParams(4), ...p });
}
