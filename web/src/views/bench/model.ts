// Pure logic behind the benchmark screens: catalog grouping, parameter forms and validation, duration estimates,
// result formatting, baseline deltas and regressions, the compare matrix, per-run series parsing, soak statistics and
// the "what will this compete with" sentences. No React, no stores: every rule here is unit-tested in model.test.ts.
import type { Status } from '../../design/components/StatusPill';
import { formatBytes, formatDuration, formatFreq, formatPercent, formatTemp, formatWatts } from '../../lib/format';
import { decodeThrottle } from '../../lib/throttle';
import type { BenchCompare, BenchParam, BenchResult, BenchRun, BenchSpec, NetIfInfo, ProcSample, RunStatus, Sample } from '../../lib/types';
import { isServing, listNodes, topGpuProcess, workloadName } from '../overview/model';

// ------------------------------------------------------------------------------------------------ catalog

export type Category = BenchSpec['category'];

export const CATEGORY_ORDER: readonly Category[] = ['compute', 'memory', 'cpu', 'interconnect', 'storage', 'inference', 'soak'];
export const CATEGORY_LABEL: Record<Category, string> = {
  compute: 'Compute',
  memory: 'Memory',
  cpu: 'CPU',
  interconnect: 'Interconnect',
  storage: 'Storage',
  inference: 'Inference',
  soak: 'Soak',
};

export function groupCatalog(specs: readonly BenchSpec[]): { category: Category; label: string; specs: BenchSpec[] }[] {
  return CATEGORY_ORDER.map((category) => ({ category, label: CATEGORY_LABEL[category], specs: specs.filter((s) => s.category === category) })).filter(
    (g) => g.specs.length > 0,
  );
}

/** A catalog description as a plain one-sentence summary plus the method that follows it (may be empty). */
export function splitDescription(text: string): { summary: string; method: string } {
  const m = /^(.+?[.!?])\s+([\s\S]+)$/.exec(text.trim());
  return m ? { summary: m[1] ?? '', method: m[2] ?? '' } : { summary: text.trim(), method: '' };
}

/** Nodes a bench can run on now (availability null), in the given order. */
export const runnableNodes = (spec: BenchSpec, order: readonly string[]): string[] =>
  order.filter((id) => id in spec.availability && spec.availability[id] === null);

/** Human estimate: "≈ 3 s", "≈ 45 s", "≈ 2 min", "≈ 1 h 05 min". Whole seconds under a minute (so elapsed +
 * remaining adds up to the total on a short run), coarser above so it never pretends to be precise. */
export function aboutDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(1, seconds);
  const rounded = s < 60 ? Math.round(s) : s < 3600 ? Math.round(s / 60) * 60 : Math.round(s / 300) * 300;
  return `≈ ${formatDuration(rounded)}`;
}

export const IMPACT_LABEL = { low: 'Low', medium: 'Medium', high: 'High' } as const;

// ------------------------------------------------------------------------------------------------ parameters

export type ParamValue = number | string | boolean | string[];
export type ParamValues = Record<string, ParamValue>;
/** What the form holds: numbers as typed text, so a half-typed value is never coerced. */
export type FormValue = string | boolean | string[];
export type FormValues = Record<string, FormValue>;

export const MODEL_RE = /^[\w.\-/:]{1,200}$/;

function defaultOf(p: BenchParam): ParamValue {
  const d = p.default;
  switch (p.type) {
    case 'int':
    case 'float':
      return typeof d === 'number' ? d : (p.min ?? 0);
    case 'bool':
      return d === true;
    case 'multi':
      return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
    case 'enum':
      return typeof d === 'string' ? d : (p.choices?.[0] ?? '');
    default:
      return typeof d === 'string' ? d : d == null ? '' : JSON.stringify(d);
  }
}

export function defaultParams(spec: BenchSpec): ParamValues {
  return Object.fromEntries(spec.params.map((p) => [p.name, defaultOf(p)]));
}

export function toForm(spec: BenchSpec, values: ParamValues = defaultParams(spec)): FormValues {
  return Object.fromEntries(
    spec.params.map((p) => {
      const v = values[p.name] ?? defaultOf(p);
      return [p.name, typeof v === 'number' ? String(v) : v];
    }),
  );
}

const isUrlParam = (p: BenchParam) => /url/i.test(p.name);

/** Mirrors the agent's check: an IP literal on the LAN (RFC 1918, IPv6 ULA) or loopback, or "localhost". Link-local,
 * CGNAT/Tailscale (100.64/10), public addresses and DNS names are refused. */
export function isLanHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some((x) => Number(x) > 255)) return false;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h); // loopback, ULA fc00::/7
  return false;
}

export const isModelParam = (p: BenchParam) => /^model(_name)?$/i.test(p.name);

/** Validate the form against each BenchParam. Returns parsed values when every field is valid. */
export function validateParams(spec: BenchSpec, form: FormValues): { values: ParamValues | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values: ParamValues = {};
  const range = (p: BenchParam) => {
    const u = p.unit ? ` ${p.unit}` : '';
    if (p.min != null && p.max != null) return `between ${p.min} and ${p.max}${u}`;
    if (p.min != null) return `at least ${p.min}${u}`;
    return `at most ${p.max ?? ''}${u}`;
  };
  for (const p of spec.params) {
    const raw = form[p.name] ?? toForm(spec)[p.name];
    switch (p.type) {
      case 'int':
      case 'float': {
        const text = typeof raw === 'string' ? raw.trim().replace(',', '.') : '';
        const n = Number(text);
        if (!text || !Number.isFinite(n)) {
          errors[p.name] = p.type === 'int' ? 'Enter a whole number' : 'Enter a number';
        } else if (p.type === 'int' && !Number.isInteger(n)) {
          errors[p.name] = 'Enter a whole number';
        } else if ((p.min != null && n < p.min) || (p.max != null && n > p.max)) {
          errors[p.name] = `Must be ${range(p)}`;
        } else values[p.name] = n;
        break;
      }
      case 'bool':
        values[p.name] = raw === true;
        break;
      case 'enum':
        if (typeof raw === 'string' && (p.choices ?? []).includes(raw)) values[p.name] = raw;
        else errors[p.name] = 'Choose one of the options';
        break;
      case 'multi': {
        const list = Array.isArray(raw) ? raw.filter((x) => (p.choices ?? []).includes(x)) : [];
        if (!list.length) errors[p.name] = 'Choose at least one';
        // Keep the catalog's order, whatever order they were ticked in.
        else values[p.name] = (p.choices ?? []).filter((c) => list.includes(c));
        break;
      }
      default: {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (isUrlParam(p)) {
          let url: URL | null = null;
          try {
            url = new URL(text);
          } catch {
            url = null;
          }
          if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) errors[p.name] = 'Enter an http:// or https:// address';
          else if (!isLanHost(url.hostname)) errors[p.name] = 'Use a LAN or loopback IP address (like http://192.168.1.11:8000) or localhost';
          else values[p.name] = text;
        } else if (isModelParam(p) && text && !MODEL_RE.test(text)) { // empty: the agent picks the first served model
          errors[p.name] = 'Letters, digits and . _ - / : only (up to 200)';
        } else if (text.length > 200) {
          errors[p.name] = 'At most 200 characters';
        } else values[p.name] = text;
      }
    }
  }
  return { values: Object.keys(errors).length ? null : values, errors };
}

const DURATION_NAME = /(duration|seconds|minutes|_s$|_min$|^time$|soak)/i;
const COUNT_NAME = /(iter|repeat|runs|count|trials|samples|requests|prompts|max_tokens|output_tokens|passes)/i;

function secondsOf(value: number, p: BenchParam): number {
  const u = (p.unit ?? '').toLowerCase();
  if (u === 'min' || u === 'minutes' || /min/i.test(p.name)) return value * 60;
  if (u === 'h' || u === 'hours') return value * 3600;
  return value;
}

const isDurationParam = (p: BenchParam) => /^(s|sec|seconds|min|minutes|h|hours)$/i.test(p.unit ?? '') || DURATION_NAME.test(p.name);

/**
 * Live duration estimate for the chosen parameters, from the catalog's estimate for the defaults: a duration
 * parameter adds its difference from the default; a count parameter, or a multi-select, scales the rest.
 */
export function estimateDuration(spec: BenchSpec, values: Partial<ParamValues>): number {
  let extra = 0;
  let factor = 1;
  for (const p of spec.params) {
    const v = values[p.name];
    const d = defaultOf(p);
    if ((p.type === 'int' || p.type === 'float') && typeof v === 'number' && typeof d === 'number') {
      if (isDurationParam(p)) extra += secondsOf(v, p) - secondsOf(d, p);
      else if (COUNT_NAME.test(p.name) && d > 0) factor *= v / d;
    } else if (p.type === 'multi' && Array.isArray(v) && Array.isArray(d)) {
      factor *= Math.max(1, v.length) / Math.max(1, d.length);
    }
  }
  return Math.max(1, (spec.est_duration_s + extra) * factor);
}

const CHOICE_TEXT: Record<string, string> = {
  both: 'Both',
  gpu: 'GPU',
  cpu: 'CPU',
  tensor: 'Per-tensor',
  row: 'Per-row',
  bw: 'Bandwidth',
  lat: 'Latency',
  chat: 'Chat',
  completions: 'Completions',
  seq_write: 'Sequential write',
  seq_read: 'Sequential read',
  rand_read: 'Random read',
  rand_write: 'Random write',
};

/** 4096 -> "4 KiB", 1048576 -> "1 MiB". */
const binaryBytes = (n: number) => (n >= 2 ** 20 && n % 2 ** 20 === 0 ? `${n / 2 ** 20} MiB` : n >= 1024 && n % 1024 === 0 ? `${n / 1024} KiB` : `${n} B`);

/** An enum/multi choice as people read it: "BF16", "Per-tensor", "Rail A", "64 KiB", "1024 MiB". */
export function choiceLabel(c: string, p?: BenchParam): string {
  if (p?.unit === 'B' && /^\d+$/.test(c)) return binaryBytes(Number(c));
  if (p && /^rails?$/.test(p.name) && /^[A-Z]$/.test(c)) return `Rail ${c}`;
  const known = CHOICE_TEXT[c];
  if (known) return known;
  if (/^[a-z]+\d+$/.test(c)) return c.toUpperCase(); // short codes read in capitals: "bf16" -> "BF16"
  const text = c.replaceAll('_', ' ');
  return p?.unit ? `${text} ${p.unit}` : text;
}

/** "BF16, FP8", "16384", "on" — a parameter value as people read it. */
export function paramText(p: BenchParam | undefined, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? choiceLabel(x, p) : String(x))).join(', ');
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (v === '' && p && isModelParam(p)) return 'First served model';
  if (typeof v === 'string' && p?.type === 'enum') return choiceLabel(v, p);
  if (v == null || v === '') return '—';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : formatValue(v)) : typeof v === 'string' ? v : JSON.stringify(v);
  return p?.unit ? `${s} ${p.unit}` : s;
}

/** Short summary of the params that differ from the defaults ("BF16, FP8 · 16384"), or "Default parameters". */
export function paramsSummary(spec: BenchSpec | undefined, params: Record<string, unknown>, max = 3): string {
  if (!spec) return Object.entries(params).slice(0, max).map(([k, v]) => `${k} ${paramText(undefined, v)}`).join(' · ') || 'Default parameters';
  const defaults = defaultParams(spec);
  const changed = spec.params.filter((p) => p.name in params && JSON.stringify(params[p.name]) !== JSON.stringify(defaults[p.name]));
  if (!changed.length) return 'Default parameters';
  return changed
    .slice(0, max)
    .map((p) => {
      const text = paramText(p, params[p.name]);
      // A value that already names itself ("Rail B") is not prefixed with its label again ("Rail Rail B").
      return text.toLowerCase().startsWith(`${p.label.toLowerCase()} `) ? text : `${p.label} ${text}`;
    })
    .join(' · ');
}

// ------------------------------------------------------------------------------------------------ run state

export const isActive = (s: RunStatus) => s === 'queued' || s === 'running';

export const STATUS_LOOK: Record<RunStatus, { status: Status; label: string }> = {
  queued: { status: 'connecting', label: 'Queued' },
  running: { status: 'connecting', label: 'Running' },
  succeeded: { status: 'healthy', label: 'Succeeded' },
  failed: { status: 'critical', label: 'Failed' },
  cancelled: { status: 'offline', label: 'Cancelled' },
};

/** Seconds since the run started (or was created, while queued), up to now or its finish. */
export function elapsed(run: Pick<BenchRun, 'created_ts' | 'started_ts' | 'finished_ts'>, now: number): number {
  const from = run.started_ts ?? run.created_ts;
  return Math.max(0, (run.finished_ts ?? now) - from);
}

/**
 * Seconds remaining. Early on, the catalog estimate (progress is too small to extrapolate); once real progress is
 * reported, extrapolated from it, blended so the number does not jump at the switch-over.
 */
/** Expected total duration: the estimate, or elapsed + remaining once progress is reported. */
export function projectedTotal(run: Pick<BenchRun, 'created_ts' | 'started_ts' | 'finished_ts' | 'progress'>, now: number, estimate: number): number {
  return elapsed(run, now) + (eta(run, now, estimate) ?? 0);
}

export function eta(run: Pick<BenchRun, 'created_ts' | 'started_ts' | 'finished_ts' | 'progress'>, now: number, estimate: number): number | null {
  if (run.finished_ts != null) return 0;
  const e = elapsed(run, now);
  const p = Math.min(1, Math.max(0, run.progress));
  const fromEstimate = Math.max(0, estimate - e);
  if (p <= 0.02) return fromEstimate;
  const fromProgress = Math.max(0, e / p - e);
  const w = Math.min(1, (p - 0.02) / 0.18); // fully trust progress from 20 %
  return fromEstimate * (1 - w) + fromProgress * w;
}

// ------------------------------------------------------------------------------------------------ values & deltas

/** 3 significant figures (412 / 41.2 / 4.12), thousands grouped from 10 000 ("12,480"). */
export function formatValue(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const text = a >= 10_000 ? Math.round(a).toLocaleString('en-US') : a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a >= 1 || a === 0 ? a.toFixed(2) : a.toPrecision(3);
  return v < 0 && Number(text.replaceAll(',', '')) !== 0 ? `−${text}` : text; // a true minus sign
}

/** Units as people write them: "us" -> "µs". */
export const unitText = (unit: string) => (unit === 'us' ? 'µs' : unit);

/** "412 TFLOPS", "1.92 µs". Clocks and temperatures read as on the live screens: "1.88 GHz", "88 °C". */
export function valueWithUnit(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'MHz' && Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} GHz`;
  if (unit === '°C') return `${Math.round(v)} °C`;
  return `${formatValue(v)}${!unit ? '' : unit === '%' ? '%' : ` ${unitText(unit)}`}`;
}

export function deltaPct(value: number | null | undefined, ref: number | null | undefined): number | null {
  if (value == null || ref == null || !Number.isFinite(value) || !Number.isFinite(ref) || ref === 0) return null;
  return ((value - ref) / Math.abs(ref)) * 100;
}

export type DeltaTone = 'better' | 'worse' | 'same';

export interface DeltaLook {
  /** Signed change: % of the reference, or percentage points for a result that is itself a percentage. */
  pct: number;
  /** "+3.2%", "−12.0%" (true minus sign), "+0.5 pts" for a percentage result. */
  text: string;
  tone: DeltaTone;
  /** Worse than the reference by more than the regression threshold. */
  regression: boolean;
}

/**
 * Delta of `value` vs `ref`, read in the metric's better direction. |Δ| under 0.5 reads as "same". A result that is
 * itself a percentage (unit "%") changes in percentage points, like the console's regression check: 0.5 % -> 1 %
 * throttled is +0.5 pts, not +100 %, and a 0 % reference still compares.
 */
export function deltaLook(value: number | null | undefined, ref: number | null | undefined, better: 'higher' | 'lower', regressionPct: number, flagged?: boolean, unit?: string): DeltaLook | null {
  const points = unit === '%';
  const pct = points ? (value == null || ref == null || !Number.isFinite(value) || !Number.isFinite(ref) ? null : value - ref) : deltaPct(value, ref);
  if (pct === null) return null;
  const improved = better === 'higher' ? pct > 0 : pct < 0;
  const tone: DeltaTone = Math.abs(pct) < 0.5 ? 'same' : improved ? 'better' : 'worse';
  const regression = flagged ?? (tone === 'worse' && Math.abs(pct) > regressionPct);
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return { pct, text: `${sign}${Math.abs(pct).toFixed(1)}${points ? ' pts' : '%'}`, tone, regression };
}

/** Delta of a result vs its baseline; the console's own regression flag wins over local arithmetic. */
export const resultDelta = (r: BenchResult, regressionPct: number) => deltaLook(r.value, r.baseline, r.better, regressionPct, r.baseline != null ? r.regression : undefined, r.unit);

/** A precision/feature the node cannot run (value 0 with `extras.unsupported`): never shown as a number. */
export const isUnsupported = (r: BenchResult) => r.extras.unsupported === true;

/** A code-path smoke run (GPU payload on the CPU, agent bench_payload_device = "cpu"): not a GPU measurement. */
export const isSmoke = (results: readonly BenchResult[]) => results.some((r) => r.extras.smoke === true);

/** A signed change ("tflops_change_pct"): positive values carry a "+" so a gain never reads as a loss. */
export const signedFormat = (r: Pick<BenchResult, 'metric'>) => (v: number) => (/_change_pct$/.test(r.metric) && v > 0 && formatValue(v) !== '0.00' ? `+${formatValue(v)}` : formatValue(v));

/** "412 TFLOPS", "+27.3%", or "Unsupported" for a result the node could not measure. */
export function resultText(r: BenchResult): string {
  if (isUnsupported(r)) return 'Unsupported';
  const text = valueWithUnit(r.value, r.unit); // clocks and temperatures are rewritten ("2.15 GHz", "81 °C")
  return signedFormat(r)(r.value).startsWith('+') ? `+${text}` : text;
}

/** The results to emphasise: those flagged `extras.headline`, else the first result of each node (up to `max`). */
export function headlineResults(all: readonly BenchResult[], max = 3): BenchResult[] {
  const results = all.filter((r) => !isUnsupported(r));
  const flagged = results.filter((r) => r.extras.headline === true);
  if (flagged.length) return flagged.slice(0, max);
  const first = results[0];
  if (!first) return [];
  const sameMetric = results.filter((r) => r.metric === first.metric);
  return (sameMetric.length > 1 ? sameMetric : results).slice(0, max);
}

/** The results a one-line headline shows: the flagged (else first) metric, one per node, up to three. */
function headlineSet(all: readonly BenchResult[]): BenchResult[] {
  const results = all.filter((r) => !isUnsupported(r));
  const first = results.find((r) => r.extras.headline === true) ?? results[0];
  if (!first) return [];
  return results.filter((r) => r.metric === first.metric && r.unit === first.unit).slice(0, 3);
}

/** One-line headline for tables and cards: the first metric, "412 TFLOPS", or per node "93.6 / 90.4 TFLOPS". */
export function headlineText(all: readonly BenchResult[]): string {
  const same = headlineSet(all);
  const first = same[0];
  if (!first) return '—';
  if (same.length < 2) return valueWithUnit(first.value, first.unit);
  return `${same.map((r) => formatValue(r.value)).join(' / ')} ${first.unit}`;
}

/** What the headline number is, with its nodes in the same order: "Single core (Cortex-X925) · spark1 / spark2". */
export function headlineCaption(all: readonly BenchResult[]): string {
  const same = headlineSet(all);
  const first = same[0];
  if (!first) return '';
  const nodes = same.map((r) => r.node_id).filter((n): n is string => !!n);
  return [first.label, nodes.join(' / ')].filter(Boolean).join(' · ');
}

/** Hover detail: each node's value, and the work unit when the payload names one ("sha256 + zlib …"). */
export function headlineDetail(all: readonly BenchResult[]): string {
  const same = headlineSet(all);
  const first = same[0];
  if (!first) return '';
  const values = same.map((r) => `${r.node_id ? `${r.node_id}: ` : ''}${valueWithUnit(r.value, r.unit)}`).join(', ');
  const work = typeof first.extras.workload === 'string' ? ` ${first.unit} = input bytes processed per second by ${first.extras.workload}.` : '';
  return `${first.label}. ${values}.${work}`;
}

/** Which nodes' results had a baseline to compare with, and which had none ("cluster" for cluster-wide results). */
export function baselineCoverage(results: readonly BenchResult[]): { with: string[]; without: string[] } {
  const by = new Map<string, boolean>();
  for (const r of results) {
    if (isUnsupported(r)) continue;
    const n = r.node_id ?? 'cluster';
    by.set(n, (by.get(n) ?? false) || r.baseline != null);
  }
  const all = [...by.entries()];
  return { with: all.filter(([, b]) => b).map(([n]) => n), without: all.filter(([, b]) => !b).map(([n]) => n) };
}

/** "OpenAI-compatible · Qwen3-8B": the engine and model an LLM run measured, from its results' extras. */
export function servedModel(results: readonly BenchResult[]): string | null {
  const ex = results.find((r) => typeof r.extras.model === 'string' && r.extras.model)?.extras;
  if (!ex) return null;
  return [ex.engine, ex.model].filter((x): x is string => typeof x === 'string' && !!x).join(' · ');
}

/** Benchmarks where one node acts on the other (source → target); the rest are symmetric. */
const DIRECTIONAL = new Set(['rdma-bw-lat']);

/** "spark1 → spark2" for a directional pair, else "spark1, spark2". */
export const nodesText = (benchId: string, nodes: readonly string[]) => nodes.join(DIRECTIONAL.has(benchId) && nodes.length === 2 ? ' → ' : ', ');

/** Worst delta vs baseline over the run's results, for the history table. */
export function baselineSummary(results: readonly BenchResult[], regressionPct: number): DeltaLook | null {
  let worst: DeltaLook | null = null;
  for (const r of results) {
    const d = resultDelta(r, regressionPct);
    if (!d) continue;
    const score = (x: DeltaLook) => (x.regression ? 2 : 0) + (x.tone === 'worse' ? 1 : 0) + Math.abs(x.pct) / 1000;
    if (!worst || score(d) > score(worst)) worst = d;
  }
  return worst;
}

// ------------------------------------------------------------------------------------------------ history

export interface HistoryFilters {
  bench: string;
  node: string;
  status: RunStatus | '';
}
export const NO_HISTORY_FILTERS: HistoryFilters = { bench: '', node: '', status: '' };

export function filterRuns(runs: readonly BenchRun[], f: HistoryFilters): BenchRun[] {
  return runs
    .filter((r) => (!f.bench || r.bench_id === f.bench) && (!f.node || r.nodes.includes(f.node)) && (!f.status || r.status === f.status))
    .sort((a, b) => b.created_ts - a.created_ts);
}

export const runDuration = (r: BenchRun): number | null => (r.started_ts != null && r.finished_ts != null ? Math.max(0, r.finished_ts - r.started_ts) : null);

/** "Tue 6 Oct, 14:20". */
export function formatDateTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const d = new Date(ts * 1000);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------------------------------ compare

/** Stable JSON (sorted keys) so two param objects compare by content. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

const paramsId = (r: BenchRun) => r.params_key || stableJson(r.params);

/** Parameter names whose values differ between runs (empty: directly comparable). Different benches count too. */
export function differingParams(runs: readonly BenchRun[]): string[] {
  if (runs.length < 2) return [];
  const first = runs[0];
  if (!first) return [];
  if (runs.every((r) => r.bench_id === first.bench_id && paramsId(r) === paramsId(first))) return [];
  const names = new Set(runs.flatMap((r) => Object.keys(r.params)));
  const out = [...names].filter((n) => runs.some((r) => stableJson(r.params[n]) !== stableJson(first.params[n])));
  if (runs.some((r) => r.bench_id !== first.bench_id)) out.unshift('benchmark');
  return out.length ? out : ['parameters'];
}

export interface CompareCell {
  runId: string;
  value: number | null;
  /** Vs the first run (null for the first run itself and for missing values). */
  delta: DeltaLook | null;
}
export interface CompareRow {
  key: string;
  label: string;
  unit: string;
  better: 'higher' | 'lower';
  node_id: string | null;
  cells: CompareCell[];
}

/**
 * Metric rows x run columns, each delta against the first run (the reference column). Runs of different
 * benchmarks get no deltas at all; runs with different parameters get deltas but never a regression flag (the
 * console never compares them either).
 */
export function compareMatrix(cmp: BenchCompare, regressionPct: number): CompareRow[] {
  const ids = cmp.runs.map((r) => r.id);
  const mixed = new Set(cmp.runs.map((r) => r.bench_id)).size > 1;
  const comparable = differingParams(cmp.runs).length === 0;
  const ref = ids[0];
  return cmp.metrics.map((m) => {
    const base = ref ? (m.values[ref] ?? null) : null;
    return {
      key: `${m.metric}|${m.node_id ?? ''}`,
      label: m.label,
      unit: m.unit,
      better: m.better,
      node_id: m.node_id,
      cells: ids.map((id, i) => {
        const value = m.values[id] ?? null;
        if (mixed) return { runId: id, value, delta: null };
        return { runId: id, value, delta: i === 0 ? null : deltaLook(value, base, m.better, regressionPct, comparable ? undefined : false, m.unit) };
      }),
    };
  });
}

export const MAX_COMPARE = 4;

/** ids from "?ids=a,b,c": de-duplicated, at most MAX_COMPARE. */
export function parseCompareIds(search: string): string[] {
  const raw = new URLSearchParams(search).get('ids') ?? '';
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_COMPARE);
}

// ------------------------------------------------------------------------------------------------ run series

export type SeriesKind = 'sm_mhz' | 'temp_c' | 'power_w' | 'util' | 'throttle_mask' | 'tflops';

const KIND_RE: readonly [SeriesKind, RegExp][] = [
  ['throttle_mask', /throttle/i],
  ['tflops', /tflops/i],
  ['sm_mhz', /(sm_mhz|sm_clock|clock_mhz|clocks?$)/i],
  ['temp_c', /temp/i],
  ['power_w', /power(_w)?$/i],
  ['util', /util/i],
];

export function seriesKind(key: string): SeriesKind | null {
  for (const [kind, re] of KIND_RE) if (re.test(key)) return kind;
  return null;
}

const TS_KEYS = new Set(['ts', 't', 'time', 't_s', 'elapsed_s']);

export interface ParsedSeries {
  /** Epoch seconds per node (nodes can be sampled separately). */
  ts: Record<string, number[]>;
  /** node -> kind -> values aligned with ts[node]. */
  byNode: Record<string, Partial<Record<SeriesKind, number[]>>>;
}

export const TELEMETRY_PREFIX = 'telemetry.';

/**
 * Read BenchRun.series into per-node, per-kind arrays. `source` picks the console's recorded GPU telemetry
 * ("telemetry.<node>.<key>") or the benchmark's own series (everything else). Keys may be node-prefixed
 * ("spark1.sm_mhz", "spark1:temp_c") or bare (single-node runs). Time comes from a ts/t/t_s key (epoch, or
 * seconds from the start when small); without one, samples are spread evenly over the run.
 */
export function parseRunSeries(run: Pick<BenchRun, 'series' | 'nodes' | 'started_ts' | 'finished_ts' | 'created_ts'>, source: 'bench' | 'telemetry' = 'bench'): ParsedSeries {
  const out: ParsedSeries = { ts: {}, byNode: {} };
  const rawTs: Record<string, number[]> = {};
  const fallbackNode = run.nodes[0] ?? '';
  for (const [fullKey, values] of Object.entries(run.series)) {
    if (!Array.isArray(values)) continue;
    const isTelemetry = fullKey.startsWith(TELEMETRY_PREFIX);
    if (isTelemetry !== (source === 'telemetry')) continue;
    const key = isTelemetry ? fullKey.slice(TELEMETRY_PREFIX.length) : fullKey;
    let node = fallbackNode;
    let rest = key;
    for (const n of run.nodes) {
      if (key.startsWith(`${n}.`) || key.startsWith(`${n}:`) || key.startsWith(`${n}/`)) {
        node = n;
        rest = key.slice(n.length + 1);
        break;
      }
    }
    if (TS_KEYS.has(rest)) {
      rawTs[node] = values;
      continue;
    }
    const kind = seriesKind(rest);
    if (!kind) continue;
    const slot = (out.byNode[node] ??= {});
    slot[kind] ??= values;
  }
  const start = run.started_ts ?? run.created_ts;
  for (const node of Object.keys(out.byNode)) {
    const shared = rawTs[node] ?? rawTs[fallbackNode];
    const len = Math.max(0, ...Object.values(out.byNode[node] ?? {}).map((v) => v.length));
    if (shared?.length) {
      const relative = (shared[0] ?? 0) < 1e9;
      out.ts[node] = shared.map((t) => (relative ? start + t : t));
    } else {
      const span = Math.max(1, (run.finished_ts ?? start + len) - start);
      out.ts[node] = Array.from({ length: len }, (_, i) => start + (len > 1 ? (i * span) / (len - 1) : 0));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ soak statistics

export interface SoakStats {
  clockMean: number | null;
  /** Coefficient of variation of the SM clock, % (lower = steadier). */
  clockCvPct: number | null;
  maxTemp: number | null;
  /** Share of samples with each throttle reason set, % (info-level "Idle" excluded). */
  throttled: { title: string; pct: number; severity: 'info' | 'warning' | 'critical' }[];
  /** Thermal or hardware limits (warning/critical reasons), % of samples: power capping is routine under load. */
  throttledAnyPct: number | null;
  /** At the power cap, % of samples. */
  powerCappedPct: number | null;
  /** The run recorded throughput at all. */
  hasTflops: boolean;
  firstMinuteTflops: number | null;
  lastMinuteTflops: number | null;
  /** Last vs first minute, % (positive: faster at the end). Null until the run is long enough for two minutes. */
  tflopsChangePct: number | null;
  /** Length of the first/last windows when the payload used shorter ones than a minute (a third of a short run). */
  tflopsWindowS?: number;
}

/** First- and last-minute throughput need two separate minutes of data. */
export const SOAK_MIN_SPAN_S = 120;

const finite = (xs: readonly number[] | undefined) => (xs ?? []).filter((x) => Number.isFinite(x));
const meanOf = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function soakStats(ts: readonly number[], s: Partial<Record<SeriesKind, number[]>>): SoakStats {
  const clocks = finite(s.sm_mhz);
  const clockMean = meanOf(clocks);
  let clockCvPct: number | null = null;
  if (clockMean && clocks.length > 1) {
    const variance = clocks.reduce((a, c) => a + (c - clockMean) ** 2, 0) / clocks.length;
    clockCvPct = (Math.sqrt(variance) / clockMean) * 100;
  }
  const temps = finite(s.temp_c);
  const maxTemp = temps.length ? Math.max(...temps) : null;

  const masks = finite(s.throttle_mask);
  const counts = new Map<string, { title: string; n: number; severity: 'info' | 'warning' | 'critical' }>();
  let any = 0;
  let capped = 0;
  for (const m of masks) {
    const reasons = decodeThrottle(m).filter((r) => r.code !== 'gpu_idle');
    if (reasons.some((r) => r.severity !== 'info')) any++;
    if (reasons.some((r) => r.code === 'sw_power_cap')) capped++;
    for (const r of reasons) {
      const c = counts.get(r.code) ?? { title: r.title, n: 0, severity: r.severity };
      c.n++;
      counts.set(r.code, c);
    }
  }
  const throttled = [...counts.values()].map((c) => ({ title: c.title, severity: c.severity, pct: (c.n / masks.length) * 100 })).sort((a, b) => b.pct - a.pct);

  const tf = s.tflops ?? [];
  const t0 = ts[0];
  const tEnd = ts[ts.length - 1];
  const window = (from: number, to: number) => meanOf(tf.filter((v, i) => Number.isFinite(v) && (ts[i] ?? NaN) >= from && (ts[i] ?? NaN) <= to));
  const longEnough = t0 !== undefined && tEnd !== undefined && tEnd - t0 >= SOAK_MIN_SPAN_S; // windows must not overlap
  const firstMinuteTflops = longEnough ? window(t0, t0 + 60) : null;
  const lastMinuteTflops = longEnough ? window(tEnd - 60, tEnd) : null;
  return {
    clockMean,
    clockCvPct,
    maxTemp,
    throttled,
    throttledAnyPct: masks.length ? (any / masks.length) * 100 : null,
    powerCappedPct: masks.length ? (capped / masks.length) * 100 : null,
    hasTflops: tf.some((v) => Number.isFinite(v)),
    firstMinuteTflops,
    lastMinuteTflops,
    tflopsChangePct: deltaPct(lastMinuteTflops, firstMinuteTflops),
  };
}

/**
 * First/last-minute throughput from the payload's own results when the run has them. The payload averages every
 * timed GEMM window (about 0.5 s each); the series only holds the latest window once a second, and on GB10 that
 * 1 Hz sampling aliases with a periodic dip (measured: 0.3-0.5% high), so the panel would disagree with the results
 * table. The series stay the fallback while the run is live.
 */
export function withSoakResults(stats: SoakStats, results: readonly BenchResult[], node: string): SoakStats {
  const find = (metric: string) => results.find((r) => r.node_id === node && r.metric === metric);
  const first = find('tflops_first')?.value ?? null;
  const last = find('tflops_last')?.value ?? null;
  if (first === null || last === null) return stats;
  const w = find('tflops_first')?.extras.window_s;
  const windowS = typeof w === 'number' && w < 60 ? w : undefined;
  return { ...stats, hasTflops: true, firstMinuteTflops: first, lastMinuteTflops: last, tflopsChangePct: find('tflops_change_pct')?.value ?? deltaPct(last, first), ...(windowS ? { tflopsWindowS: windowS } : {}) };
}

// ------------------------------------------------------------------------------------------------ competition

export interface Competition {
  node: string;
  /** "spark1 is currently serving DeepSeek-V4.1-Flash-EXL3 at 96% GPU; results will be lower and the workload will slow down." */
  text: string;
  /** Something is running that the benchmark will compete with. */
  busy: boolean;
}

const GPU_BUSY_PCT = 10;
const CPU_BUSY_PCT = 25;
const DISK_BUSY_PCT = 20;
const LINK_BUSY_BPS = 100e6; // 0.8 Gb/s over a CX7 rail

/** Peak receive/transmit bytes/s of one interconnect interface over a recent window. */
export interface LinkTraffic {
  name: string;
  /** "rail A" (from the interface label), else the interface name. */
  label: string;
  rx: number;
  tx: number;
}

export function railLabel(n: Pick<NetIfInfo, 'name' | 'label'>): string {
  const m = /rail\s+(\w+)/i.exec(n.label);
  return m ? `rail ${m[1] ?? ''}` : n.name;
}

/** Per-rail traffic from the latest sample only (callers with a live window pass `linkTraffic` instead). */
function latestTraffic(s: Sample, rails: readonly NetIfInfo[]): LinkTraffic[] {
  return rails.flatMap((r) => {
    const n = s.net.find((x) => x.name === r.name);
    return n ? [{ name: r.name, label: railLabel(r), rx: n.rx_bps, tx: n.tx_bps }] : [];
  });
}

const gbps = (bytesPerS: number) => `${((bytesPerS * 8) / 1e9).toFixed(1)} Gb/s`;

function gpuWorkload(procs: readonly ProcSample[] | null | undefined): { verb: string; what: string } | null {
  const top = topGpuProcess(procs);
  if (!top) return null;
  return { verb: isServing(top) ? 'serving' : 'running', what: workloadName(top) };
}

/**
 * What a benchmark will compete with on each node, from the latest live samples. GPU-bound benches look at GPU
 * load and GPU processes; CPU, storage and interconnect benches at CPU, NVMe and CX7 load respectively. For the
 * interconnect, a GPU workload counts as busy on its own (a TP=2 model across the nodes uses the link in bursts), and
 * `linkTraffic` gives each rail's peak over a recent window rather than one instantaneous sample.
 */
export function competition(
  spec: Pick<BenchSpec, 'category' | 'impact'>,
  nodes: readonly string[],
  latest: (node: string) => Sample | null,
  interconnects: (node: string) => readonly NetIfInfo[] = () => [],
  linkTraffic?: (node: string, rails: readonly NetIfInfo[]) => LinkTraffic[],
): Competition[] {
  const consequence = 'results will be lower and the workload will slow down';
  return nodes.map((node) => {
    const s = latest(node);
    if (!s) return { node, text: `${node} has not reported live data, so its current load is unknown.`, busy: false };
    const gpu = s.gpu[0];
    const util = gpu?.util ?? null;
    const work = gpuWorkload(s.procs);
    const pct = (v: number) => `${Math.round(v)}%`;
    switch (spec.category) {
      case 'cpu': {
        const busy = s.cpu.util >= CPU_BUSY_PCT;
        return busy
          ? { node, busy, text: `${node} CPUs are ${pct(s.cpu.util)} busy right now; ${consequence}.` }
          : { node, busy, text: `${node} CPUs are mostly idle (${pct(s.cpu.util)}).` };
      }
      case 'storage': {
        const disk = [...s.disk].sort((a, b) => b.busy_pct - a.busy_pct)[0];
        const busy = (disk?.busy_pct ?? 0) >= DISK_BUSY_PCT;
        return busy && disk
          ? { node, busy, text: `${node} ${disk.name} is ${pct(disk.busy_pct)} busy right now; ${consequence}.` }
          : { node, busy: false, text: `${node} storage is mostly idle.` };
      }
      case 'interconnect': {
        const rails = interconnects(node);
        const traffic = (linkTraffic ? linkTraffic(node, rails) : latestTraffic(s, rails)).filter((t) => t.rx + t.tx >= LINK_BUSY_BPS);
        const moving = traffic.map((t) => `${t.label} ${gbps(t.rx)} in / ${gbps(t.tx)} out`).join(', ');
        if (traffic.length) {
          const why = work ? ` (${work.verb} ${work.what})` : '';
          return { node, busy: true, text: `${node} ConnectX-7 traffic${why}: ${moving}; ${consequence}.` };
        }
        if (work) return { node, busy: true, text: `${node} is ${work.verb} ${work.what}; a model spread over both nodes uses the ConnectX-7 link, so ${consequence}.` };
        return { node, busy: false, text: `${node} ConnectX-7 link is quiet.` };
      }
      default: {
        const busy = (util ?? 0) >= GPU_BUSY_PCT || work !== null;
        if (!busy) return { node, busy, text: `${node} GPU is idle${util !== null ? ` (${pct(util)})` : ''}.` };
        const at = util !== null ? ` at ${pct(util)} GPU` : '';
        return work
          ? { node, busy, text: `${node} is currently ${work.verb} ${work.what}${at}; ${consequence}.` }
          : { node, busy, text: `${node} GPU is ${pct(util ?? 0)} busy; ${consequence}.` };
      }
    }
  });
}

/** "Runs GPU matmul on spark1 and spark2 (source spark1, target spark2)." */
export function runSentence(spec: Pick<BenchSpec, 'name' | 'min_nodes'>, nodes: readonly string[]): string {
  if (spec.min_nodes === 2 && nodes.length === 2) return `Runs ${spec.name} between ${nodes[0] ?? ''} (source) and ${nodes[1] ?? ''} (target).`;
  return `Runs ${spec.name} on ${listNodes(nodes)}.`;
}

export const cancelSentence = (nodes: readonly string[]) =>
  `Stops the benchmark on ${listNodes(nodes)} and removes its containers and temp files. Partial results are discarded.`;

// ------------------------------------------------------------------------------------------------ telemetry overlay

export interface NodeSeries {
  node: string;
  ts: readonly number[];
  /** key -> values aligned with ts. */
  values: Readonly<Record<string, readonly (number | null)[]>>;
}

/**
 * Put several nodes' series on one time axis (uPlot needs a shared x): timestamps are rounded to `stepS` and merged;
 * a node with no sample at a step is a gap there. Returns ts plus, per key, one value array per node (input order).
 */
export function alignByNode(nodes: readonly NodeSeries[], keys: readonly string[], stepS = 1): { ts: number[]; byKey: Record<string, (number | null)[][]> } {
  const slot = (t: number) => Math.round(t / stepS) * stepS;
  const all = new Set<number>();
  for (const n of nodes) for (const t of n.ts) all.add(slot(t));
  const ts = [...all].sort((a, b) => a - b);
  const index = new Map(ts.map((t, i) => [t, i]));
  const byKey: Record<string, (number | null)[][]> = {};
  for (const k of keys) {
    byKey[k] = nodes.map((n) => {
      const out = new Array<number | null>(ts.length).fill(null);
      const vals = n.values[k];
      if (!vals) return out;
      n.ts.forEach((t, i) => {
        const j = index.get(slot(t));
        const v = vals[i];
        if (j !== undefined && v != null && Number.isFinite(v)) out[j] = v;
      });
      return out;
    });
  }
  return { ts, byKey };
}

/** Stopwatch style: "0:42", "12:05", "1:02:03". */
export function stopwatch(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ------------------------------------------------------------------------------------------------ metadata

const META_WORDS: Record<string, string> = { cuda: 'CUDA', gpu: 'GPU', nvml: 'NVML', sm: 'SM', mhz: 'MHz', sha: 'SHA', git: 'Git', id: 'ID', uuid: 'UUID', ts: 'time', os: 'OS', cpu: 'CPU', ip: 'IP', url: 'URL', tflops: 'TFLOPS' };

/** Labels for the telemetry snapshot keys agents record at the start and end of a run. */
const META_LABELS: Record<string, string> = {
  suite_git: 'Suite commit',
  suite_git_dirty: 'Suite has local changes',
  suite_sha256: 'Suite checksum (SHA-256)',
  gpu_cc: 'GPU compute capability',
  role: 'Role',
  start: 'At start',
  end: 'At end',
  est_duration_s: 'Estimated duration',
  timeout_s: 'Timeout',
  started_ts: 'Started',
  finished_ts: 'Finished',
  ts: 'Time',
  mem_used: 'Memory used',
  mem_gpu: 'GPU memory',
  sm_mhz: 'SM clock',
  temp_c: 'GPU temp',
  gpu_c: 'GPU temp',
  power_w: 'GPU power',
  util: 'GPU util',
  throttle_mask: 'Throttling',
};

/** "sm_mhz_start" -> "SM MHz start"; "suite_git" -> "Suite Git". */
export function metaLabel(key: string): string {
  const known = META_LABELS[key];
  if (known) return known;
  const words = key.split(/[_\s.]+/).filter(Boolean).map((w) => META_WORDS[w.toLowerCase()] ?? w);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Known metadata first (driver, CUDA, GPU, image, suite), then the rest in their own order. */
export const META_ORDER = ['hostname', 'driver', 'cuda', 'nvml', 'gpu', 'gpu_name', 'gpu_uuid', 'image', 'suite_git', 'suite_sha', 'git_sha', 'agent_version', 'engine', 'runner'];

export function orderedMeta(meta: Record<string, unknown>): [string, unknown][] {
  const rank = (k: string) => {
    const i = META_ORDER.indexOf(k);
    return i < 0 ? META_ORDER.length : i;
  };
  return Object.entries(meta).sort((a, b) => rank(a[0]) - rank(b[0]));
}

type Meta = Record<string, unknown>;
const isObj = (v: unknown): v is Meta => !!v && typeof v === 'object' && !Array.isArray(v);

/** Metadata per node: the console's run.metadata.nodes, else each agent's own, else the flat metadata. */
export function nodeMeta(run: Pick<BenchRun, 'metadata' | 'nodes' | 'node_states'>): Record<string, Meta> {
  // In the run's node order: a live run's node_states arrive in whatever order the agents first reported.
  const rank = (n: string) => (run.nodes.includes(n) ? run.nodes.indexOf(n) : run.nodes.length);
  const inRunOrder = (entries: [string, Meta][]) => Object.fromEntries(entries.sort((a, b) => rank(a[0]) - rank(b[0])));
  const nodes = run.metadata.nodes;
  if (isObj(nodes) && Object.values(nodes).some(isObj)) return inRunOrder(Object.entries(nodes).filter((e): e is [string, Meta] => isObj(e[1])));
  const fromAgents = Object.entries(run.node_states ?? {}).filter(([, st]) => Object.keys(st.metadata).length);
  if (fromAgents.length) return inRunOrder(fromAgents.map(([n, st]) => [n, st.metadata]));
  const flat = Object.fromEntries(Object.entries(run.metadata).filter(([k]) => k !== 'nodes' && k !== 'bench_name'));
  return Object.keys(flat).length ? Object.fromEntries(run.nodes.slice(0, 1).map((n) => [n, flat])) : {};
}

/** The run's log: the console saves it when the run ends; until then, each agent's live tail, prefixed the same way. */
export function runLog(run: Pick<BenchRun, 'log_tail' | 'nodes' | 'node_states'>): string[] {
  if (run.log_tail.length) return run.log_tail;
  return run.nodes.flatMap((n) => (run.node_states?.[n]?.log_tail ?? []).map((line) => `[${n}] ${line}`));
}

/** Driver / CUDA / GPU of a run (the first node that reports each). */
export function runFacts(run: Pick<BenchRun, 'metadata' | 'nodes' | 'node_states'>): { driver?: string; cuda?: string; gpu?: string } {
  const all = Object.values(nodeMeta(run));
  const get = (...keys: string[]) => {
    for (const m of all) for (const k of keys) if (typeof m[k] === 'string' || typeof m[k] === 'number') return String(m[k]);
    return undefined;
  };
  return { driver: get('driver', 'driver_version'), cuda: get('cuda', 'cuda_version'), gpu: get('gpu', 'gpu_name') };
}

/** A metadata value as text, with units read from its key ("sm_mhz" -> "2.10 GHz", "gpu_c" -> "61 °C"). */
const ROLE_TEXT: Record<string, string> = { single: 'Single node', rank: 'NCCL rank', server: 'Server', client: 'Client' };

export function metaText(key: string, value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'role' && typeof value === 'string') return ROLE_TEXT[value] ?? value;
  if (typeof value === 'number') {
    if (/_s$/.test(key)) return formatDuration(value);
    if (key === 'ts' || key.endsWith('_ts')) return `${formatDateTime(value)}:${String(new Date(value * 1000).getSeconds()).padStart(2, '0')}`;
    if (/^mem|bytes$/i.test(key)) return formatBytes(value);
    if (/(_w|power)$/i.test(key)) return formatWatts(value);
    if (key === 'util' || key.endsWith('_pct')) return formatPercent(value);
    if (key === 'throttle_mask') return decodeThrottle(value).map((r) => r.title).join(', ') || 'None';
    if (/mhz/i.test(key)) return formatFreq(value);
    if (/(_c|temp)$/i.test(key) || /temp_c/i.test(key)) return formatTemp(value);
    return Number.isInteger(value) ? value.toLocaleString('en-US') : formatValue(value); // counts stay whole
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => metaText(key, v)).join(', ');
  if (isObj(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]) return metaText(entries[0][0], entries[0][1]);
    return entries.map(([k, v]) => `${metaLabel(k)} ${metaText(k, v)}`).join(' · ');
  }
  return JSON.stringify(value);
}
