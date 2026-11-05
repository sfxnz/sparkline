import { lostGpu, notReported, type NotReported } from './capabilities';
import { formatDuration } from './format';
import { GPU_TOTALS, gpuKey, gpuTotals, gpuValue, isReadingTotal, type GpuField, type GpuReading, type NodeTotal, type ReadingTotal } from './metrics';
import type { GpuInfo, GpuSample, NodeInfo, Sample } from './types';

/** The GPU with this `index`. A sample holds only the GPUs that reported this tick, so when one vendor's backend
 *  fails, position 0 is another vendor's card: never read a GPU by its position. */
export function gpuAt<T extends { index: number }>(gpus: readonly T[] | null | undefined, index: number): T | undefined {
  return gpus?.find((g) => g.index === index);
}

// Agents already in the field resend these on a GPU whose NVML reads all fail, so they never show it answered.
export const HELD_READINGS: readonly GpuReading[] = ['energy_j', 'power_capped_pct', 'thermal_capped_pct'];

const answers = (g: GpuSample) =>
  Object.entries(g).some(([k, v]) => k !== 'index' && v != null && !(HELD_READINGS as readonly string[]).includes(k));

/** GPU `index` in the sample when it answered. NVML keeps a GPU whose reads fail in the sample, every fresh reading
 *  null, so having an entry is not answering. */
export function answeredGpu(s: Sample | null | undefined, index: number): GpuSample | undefined {
  const g = gpuAt(s?.gpu, index);
  return g && answers(g) ? g : undefined;
}

export const answeredIndexes = (s: Sample) => s.gpu.filter(answers).map((g) => g.index);

/** The GPU indexes a node lists, or [0] when it lists none, so a node without GPUs keeps its gpu0 gaps. */
export function gpuIndexes(info: NodeInfo | null | undefined): number[] {
  return info?.gpus.length ? info.gpus.map((g) => g.index) : [0];
}

/** The key that holds the node's GPU `field`: the GPU's own key on a node with at most one GPU (the same value, and
 *  its history predates the totals), the node total on a node with several. A total no GPU key shares a name with
 *  (memory) is the node total on any node. */
export function nodeGpuKey(info: NodeInfo | null | undefined, field: NodeTotal): string {
  const [only = 0, ...more] = gpuIndexes(info);
  return more.length || !isReadingTotal(field) ? `gpu.${field}` : gpuKey(only, field);
}

/** Why none of the node's GPUs can be read: the first one's lost gap when every GPU the node lists is lost (GPU 0's
 *  on a node that lists none). */
export function everyGpuLost(info: NodeInfo | null | undefined): NotReported | null {
  const gaps = gpuIndexes(info).map((i) => lostGpu(info, i));
  return gaps.every((g) => g !== null) ? (gaps[0] ?? null) : null;
}

/** The node's GPU power limit: the sum over the GPUs it lists, when every one of them has a limit. */
export function powerLimit(info: NodeInfo | null | undefined): number | null {
  const gpus = info?.gpus ?? [];
  if (!gpus.length || gpus.some((g) => g.power_limit_w == null)) return null;
  return gpus.reduce((sum, g) => sum + (g.power_limit_w ?? 0), 0);
}

export const gpuCollectorDown = (info: NodeInfo | null | undefined) =>
  gpuIndexes(info).every((i) => notReported(info, `gpu${i}`) !== null && !lostGpu(info, i));

/** "GPU 2", "GPUs 1 and 2". */
export const gpuList = (indexes: readonly number[]) => `${indexes.length === 1 ? 'GPU' : 'GPUs'} ${andList(indexes)}`;

/** Why the node's GPUs, taken together, have no `field`. 'any': only when no listed GPU reports it (per-process
 *  memory). 'every': when any listed GPU lacks it (power limit, energy: a partial sum would understate). On a node
 *  that lists one GPU or none, the answer for that GPU (gpu0 when none). */
export function gpuSetGap(info: NodeInfo | null | undefined, field: GpuField, mode: 'any' | 'every'): NotReported | null {
  const indexes = gpuIndexes(info);
  const gaps = indexes.flatMap((i) => {
    const gap = notReported(info, gpuKey(i, field));
    return gap ? [{ index: i, gap }] : [];
  });
  const [first] = gaps;
  if (!first || (mode === 'any' && gaps.length < indexes.length)) return null;
  // With no GPU reporting, a lost GPU is not why the others say nothing: name one that answers but lacks the field.
  const named = mode === 'any' ? (gaps.find((g) => !lostGpu(info, g.index)) ?? first) : first;
  return indexes.length > 1 ? { ...named.gap, detail: `GPU ${named.index}: ${named.gap.detail}` } : named.gap;
}

const READING: Record<NodeTotal, string> = { util: 'utilisation', temp_c: 'temperature', power_w: 'power', mem_used: 'memory' };

export type SilentFor = (index: number) => number | null;

function silentClause(indexes: readonly number[], message: string | null, silentFor?: SilentFor): string {
  const seconds = Math.min(...indexes.map((i) => Math.round(silentFor?.(i) ?? 0)));
  const gpus = gpuList(indexes);
  if (message) return `${gpus} not responding${seconds > 0 ? ` for ${formatDuration(seconds)}` : ''} (${message})`;
  return seconds > 0 ? `${gpus} ${indexes.length === 1 ? 'has' : 'have'} sent no reading for ${formatDuration(seconds)}` : `${gpus} sent no reading this tick`;
}

const silentClauses = (info: NodeInfo | null | undefined, s: Sample, silentFor?: SilentFor) =>
  silentBackends(info, s.errors.gpu, answeredIndexes(s)).map((b) => silentClause(b.gpus.map((g) => g.index), b.message, silentFor));

export function everyGpuSilent(info: NodeInfo | null | undefined, s: Sample | null, silentFor?: SilentFor): NotReported | null {
  const gpus = info?.gpus ?? [];
  if (!s || !gpus.length || gpus.some((g) => answeredGpu(s, g.index))) return null;
  const lost = gpus.flatMap((g) => {
    const gap = lostGpu(info, g.index);
    return gap ? [`GPU ${String(g.index)}: ${gap.detail}`] : [];
  });
  return { kind: 'hardware', label: 'Not responding', detail: sentence([...lost, ...silentClauses(info, s, silentFor)].join('; ')), silent: true };
}

/** Why the node's figure of `field` (nodeGpuKey) is missing from this sample, when no declared gap explains it. */
export function totalGap(info: NodeInfo | null | undefined, s: Sample | null, field: NodeTotal, silentFor?: SilentFor): NotReported | null {
  if (!s || !info) return null;
  const key = nodeGpuKey(info, field);
  if (notReported(info, key)) return null;
  if (key !== `gpu.${field}`) {
    const [only = 0] = gpuIndexes(info);
    const reading = answeredGpu(s, only);
    if (!reading) return notResponding(info, s, only, silentFor);
    return gpuValue(reading, field) === null ? { kind: 'hardware', label: 'No total', detail: `GPU ${String(only)} sent no ${READING[field]} reading this tick.`, silent: true } : null;
  }
  if (gpuTotals(s)[field] !== null) return null;
  const silent = everyGpuSilent(info, s, silentFor);
  if (silent) return silent;
  const empty = info.gpus.filter((g) => {
    const reading = answeredGpu(s, g.index);
    return reading && gpuValue(reading, field) === null;
  }).map((g) => g.index);
  const clauses = [...(empty.length ? [`${gpuList(empty)} sent no ${READING[field]} reading this tick`] : []), ...silentClauses(info, s, silentFor)];
  if (!clauses.length) {
    if (!s.errors.gpu) return null;
    clauses.push(`A GPU backend failed this tick (${s.errors.gpu})`);
  }
  const why = GPU_TOTALS[field].every ? ', so a sum would understate' : '';
  return { kind: 'hardware', label: 'No total', detail: `${clauses.join('; ')}${why}.`, silent: true };
}

/** Why the node's GPU `field` has no value: every GPU silent (everyGpuSilent), declared not reported, or dropped out
 *  of this sample (totalGap). */
export function nodeTotalGap(info: NodeInfo | null | undefined, s: Sample | null, field: NodeTotal, silentFor?: SilentFor): NotReported | null {
  const key = nodeGpuKey(info, field);
  return (key === `gpu.${field}` ? everyGpuSilent(info, s, silentFor) : null) ?? notReported(info, key) ?? totalGap(info, s, field, silentFor);
}

/** Why the node's own stat of `field` has no value. One GPU: its declared gap, or not responding. Several:
 *  nodeTotalGap. */
export function nodeGpuGap(info: NodeInfo | null | undefined, s: Sample | null, field: ReadingTotal, silentFor?: SilentFor): NotReported | null {
  const [only = 0, ...more] = gpuIndexes(info);
  return more.length ? nodeTotalGap(info, s, field, silentFor) : (notReported(info, gpuKey(only, field)) ?? notResponding(info, s, only, silentFor));
}

/** How many of the GPUs a node lists a node total read this tick. */
export interface GpuCount {
  from: number;
  of: number;
}

/** The GPUs the node's mean utilisation or hottest temperature reads, when that is fewer than the node lists (one
 *  lost, or silent this tick). Null on a node with one GPU, and when every GPU or none has `field`. A power total is
 *  never partial: it needs every GPU. */
export function totalFrom(info: NodeInfo | null | undefined, s: Sample | null, field: Exclude<ReadingTotal, 'power_w'>): GpuCount | null {
  const listed = info?.gpus ?? [];
  if (listed.length < 2 || !s) return null;
  const from = listed.filter((g) => gpuAt(s.gpu, g.index)?.[field] != null).length;
  return from > 0 && from < listed.length ? { from, of: listed.length } : null;
}

export const gpuCountText = (c: GpuCount) => `${String(c.from)} of ${String(c.of)} GPUs`;

export interface SilentBackend {
  backend: string;
  /** The backend's error from `errors.gpu`, when the agent named it. */
  message: string | null;
  gpus: GpuInfo[];
}

const backendOf = (g: GpuInfo) => g.backend ?? 'nvml';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The agent writes `errors.gpu` as "<backend>: <error>", one per failing backend, joined with "; ". The split below
 *  relies on that form. */
export function silentBackends(info: NodeInfo | null | undefined, errors: string | undefined, reporting: readonly number[]): SilentBackend[] {
  const gpus = info?.gpus ?? [];
  const names = [...new Set(gpus.map(backendOf))];
  const split = names.length ? new RegExp(`; (?=(?:${names.map(escape).join('|')}): )`) : null;
  const parts = errors && split ? errors.split(split) : [];
  const out: SilentBackend[] = [];
  for (const g of gpus) {
    if (reporting.includes(g.index) || lostGpu(info, g.index)) continue;
    const backend = backendOf(g);
    const row = out.find((b) => b.backend === backend);
    if (row) {
      row.gpus.push(g);
      continue;
    }
    const part = parts.find((p) => p.startsWith(`${backend}: `));
    out.push({ backend, message: part ? part.slice(backend.length + 2) : null, gpus: [g] });
  }
  return out;
}

export function notResponding(info: NodeInfo | null | undefined, s: Sample | null, index: number, silentFor?: SilentFor): NotReported | null {
  if (!s || !gpuAt(info?.gpus, index) || answeredGpu(s, index) || lostGpu(info, index)) return null;
  const silent = silentBackends(info, s.errors.gpu, answeredIndexes(s)).find((b) => b.gpus.some((g) => g.index === index));
  return { kind: 'hardware', label: 'Not responding', detail: sentence(silentClause([index], silent?.message ?? null, silentFor)), silent: true };
}

/** "1", "1 and 2", "1, 2 and 3". */
export function andList(items: readonly (string | number)[]): string {
  const s = items.map(String);
  return s.length <= 1 ? (s[0] ?? '') : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1] ?? ''}`;
}

export function stillReport(indexes: readonly number[]): string {
  return indexes.length === 1 ? `GPU ${String(indexes[0])} still reports.` : `GPUs ${andList(indexes)} still report.`;
}

export const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

export function gpuProcessesGap(info: NodeInfo | null | undefined, s: Sample | null, quiet: readonly number[], silentFor?: SilentFor): NotReported | null {
  const declared = notReported(info, 'procs') ?? gpuSetGap(info, 'proc_mem', 'any');
  if (declared || !info?.gpus.length) return declared;
  const gaps = processGaps(info, s, quiet, silentFor);
  const [first] = gaps;
  if (!first || gaps.length < info.gpus.length) return null;
  if (gaps.length === 1) return first.gap;
  return everyGpuSilent(info, s, silentFor) ?? { ...first.gap, detail: sentence(gaps.map((g) => `GPU ${String(g.index)}: ${g.gap.detail}`).join('; ')) };
}

export function gpusWithUnknownProcesses(info: NodeInfo | null | undefined, s: Sample | null, quiet: readonly number[]): number[] {
  return gpuProcessesGap(info, s, quiet) ? [] : processGaps(info, s, quiet).map((g) => g.index);
}

function processGaps(info: NodeInfo | null | undefined, s: Sample | null, quiet: readonly number[], silentFor?: SilentFor): { index: number; gap: NotReported }[] {
  return (info?.gpus ?? []).flatMap((g) => {
    const gap = lostGpu(info, g.index) ?? (quiet.includes(g.index) ? notResponding(info, s, g.index, silentFor) : null);
    return gap ? [{ index: g.index, gap }] : [];
  });
}
