import { lostGpu, notReported, type NotReported } from './capabilities';
import { gpuKey, gpuTotals, type GpuField, type NodeTotal } from './metrics';
import type { GpuInfo, NodeInfo, Sample } from './types';

/** The GPU with this `index`. A sample holds only the GPUs that reported this tick, so when one vendor's backend
 *  fails, position 0 is another vendor's card: never read a GPU by its position. */
export function gpuAt<T extends { index: number }>(gpus: readonly T[] | null | undefined, index: number): T | undefined {
  return gpus?.find((g) => g.index === index);
}

/** The GPU indexes a node lists, or [0] when it lists none, so a node without GPUs keeps its gpu0 gaps. */
export function gpuIndexes(info: NodeInfo | null | undefined): number[] {
  return info?.gpus.length ? info.gpus.map((g) => g.index) : [0];
}

/** The key that holds the node's GPU `field`: the GPU's own key on a node with at most one GPU (the same value, and
 *  its history predates the totals), the node total on a node with several. */
export function nodeGpuKey(info: NodeInfo | null | undefined, field: NodeTotal): string {
  const [only = 0, ...more] = gpuIndexes(info);
  return more.length ? `gpu.${field}` : gpuKey(only, field);
}

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

const READING: Record<NodeTotal, string> = { util: 'utilisation', temp_c: 'temperature', power_w: 'power' };

/** Why the node's total of `field` is missing from this sample although the node is reporting. Null when it is
 *  present, when the node lists at most one GPU, or when a declared gap already explains it. */
export function totalGap(info: NodeInfo | null | undefined, s: Sample | null, field: NodeTotal): NotReported | null {
  if (!s || !info || info.gpus.length < 2 || notReported(info, `gpu.${field}`) || gpuTotals(s)[field] !== null) return null;
  const reporting = s.gpu.map((g) => g.index);
  const empty = info.gpus.filter((g) => reporting.includes(g.index) && gpuAt(s.gpu, g.index)?.[field] == null).map((g) => g.index);
  const clauses = empty.length ? [`${gpuList(empty)} sent no ${READING[field]} reading this tick`] : [];
  for (const b of silentBackends(info, s.errors.gpu, reporting)) {
    const who = gpuList(b.gpus.map((g) => g.index));
    clauses.push(b.message ? `${who} not responding (${b.message})` : `${who} sent no reading this tick`);
  }
  if (!clauses.length) {
    if (!s.errors.gpu) return null;
    clauses.push(`A GPU backend failed this tick (${s.errors.gpu})`);
  }
  const why = field === 'power_w' ? ', so a sum would understate' : '';
  return { kind: 'hardware', label: 'No total', detail: `${clauses.join('; ')}${why}.` };
}

export interface SilentBackend {
  backend: string;
  /** The backend's error from `errors.gpu`, when the agent named it. */
  message: string | null;
  gpus: GpuInfo[];
}

const backendOf = (g: GpuInfo) => g.backend ?? 'nvml';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Of the GPUs in a sample, those that really report: a lost GPU sends an empty reading every tick. */
export function reportingGpus(info: NodeInfo | null | undefined, indexes: readonly number[]): number[] {
  return indexes.filter((i) => !lostGpu(info, i));
}

/** Backends whose GPUs the node lists but sent no reading in this sample, with each one's error. A lost GPU is left
 *  out: the agent declares it, so its panels already say so. The agent writes `errors.gpu` as "<backend>: <error>",
 *  one per failing backend, joined with "; ". */
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

/** Why GPU `index` has no live value in this sample although the node lists it, or null when it reported. */
export function notResponding(info: NodeInfo | null | undefined, s: Sample | null, index: number): NotReported | null {
  if (!s || !gpuAt(info?.gpus, index) || gpuAt(s.gpu, index)) return null;
  const silent = silentBackends(info, s.errors.gpu, s.gpu.map((g) => g.index)).find((b) => b.gpus.some((g) => g.index === index));
  return { kind: 'hardware', label: 'Not responding', detail: silent?.message ?? `GPU ${index} sent no reading this tick.` };
}

/** "1", "1 and 2", "1, 2 and 3". */
export function andList(items: readonly (string | number)[]): string {
  const s = items.map(String);
  return s.length <= 1 ? (s[0] ?? '') : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1] ?? ''}`;
}

/** "GPU 1 still reports." or "GPUs 1 and 2 still report.", for GPUs that `reportingGpus` kept. */
export function stillReport(indexes: readonly number[]): string {
  return indexes.length === 1 ? `GPU ${String(indexes[0])} still reports.` : `GPUs ${andList(indexes)} still report.`;
}

export const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
