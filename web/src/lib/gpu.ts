import type { NotReported } from './capabilities';
import type { GpuInfo, NodeInfo, Sample } from './types';

/** The GPU with this `index`. A sample holds only the GPUs that reported this tick, so when one vendor's backend
 *  fails, position 0 is another vendor's card: never read a GPU by its position. */
export function gpuAt<T extends { index: number }>(gpus: readonly T[] | null | undefined, index: number): T | undefined {
  return gpus?.find((g) => g.index === index);
}

export interface SilentBackend {
  backend: string;
  /** The backend's error from `errors.gpu`, when the agent named it. */
  message: string | null;
  gpus: GpuInfo[];
}

const backendOf = (g: GpuInfo) => g.backend ?? 'nvml';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Backends whose GPUs the node lists but sent no reading in this sample, with each one's error. The agent writes
 *  `errors.gpu` as "<backend>: <error>", one per failing backend, joined with "; ". */
export function silentBackends(info: NodeInfo | null | undefined, errors: string | undefined, reporting: readonly number[]): SilentBackend[] {
  const gpus = info?.gpus ?? [];
  const names = [...new Set(gpus.map(backendOf))];
  const split = names.length ? new RegExp(`; (?=(?:${names.map(escape).join('|')}): )`) : null;
  const parts = errors && split ? errors.split(split) : [];
  const out: SilentBackend[] = [];
  for (const g of gpus) {
    if (reporting.includes(g.index)) continue;
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

/** Why the agent cannot read GPU `index` at all, though its backend sees it (a lost GPU): its `gpu<i>` entry. */
export function lostGpu(info: NodeInfo | null | undefined, index: number): NotReported | null {
  const u = info?.unsupported.find((x) => x.metric === `gpu${String(index)}`);
  return u ? { kind: u.kind ?? 'hardware', label: 'Not responding', detail: u.reason } : null;
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
