// Stable selectors for useLatest (module scope, so subscriptions keep their identity across renders).
import { gpuTotals, type GpuReading, type ReadingTotal } from '../../../lib/metrics';
import type { NodeInfo, Sample } from '../../../lib/types';
import { answeredGpu, gpuAt, gpuIndexes } from '../../../lib/gpu';

type Select<T> = (s: Sample | null) => T;
const readings = new Map<string, Select<number | null>>();
const answers = new Map<number, Select<boolean | null>>();
const totals = new Map<ReadingTotal, Select<number | null>>();

/** One reading of the GPU with this index (not array position), memoised per index and reading. */
export function gpuSelector(index: number, reading: GpuReading): Select<number | null> {
  const id = `${index}.${reading}`;
  let sel = readings.get(id);
  if (!sel) readings.set(id, (sel = (s) => gpuAt(s?.gpu, index)?.[reading] ?? null));
  return sel;
}

/** Whether the GPU with this index answered in the latest sample (answeredGpu); null before the first sample. */
export function gpuAnswered(index: number): Select<boolean | null> {
  let sel = answers.get(index);
  if (!sel) answers.set(index, (sel = (s) => (s ? answeredGpu(s, index) !== undefined : null)));
  return sel;
}

/** The node's GPU `field` from the key nodeGpuKey names: its one GPU's reading, or the node total over several. */
export function nodeGpuSelector(info: NodeInfo | null | undefined, field: ReadingTotal): Select<number | null> {
  const [only = 0, ...more] = gpuIndexes(info);
  if (!more.length) return gpuSelector(only, field);
  let sel = totals.get(field);
  if (!sel) totals.set(field, (sel = (s) => (s ? gpuTotals(s)[field] : null)));
  return sel;
}

export const memAvailable = (s: Sample | null) => s?.mem.available ?? null;
export const memSwapUsed = (s: Sample | null) => s?.mem.swap_used ?? null;
export const memPsiSome = (s: Sample | null) => s?.mem.psi_some ?? null;
export const memPsiFull = (s: Sample | null) => s?.mem.psi_full ?? null;
export const cpuUtil = (s: Sample | null) => s?.cpu.util ?? null;
export const procs = (s: Sample | null) => s?.procs ?? null;
export const mem = (s: Sample | null) => s?.mem ?? null;

export function rootUsedPct(s: Sample | null): number | null {
  const f = s?.fs.find((x) => x.mount === '/');
  return f && f.used + f.free > 0 ? (100 * f.used) / (f.used + f.free) : null; // like df
}

/** ConnectX-7 rails cabled to a peer node: the same rule as the Overview card and Wall mode, so every screen agrees
 *  on "No direct link". A port with a negotiated speed but no peer is not a link to another node. */
export function cx7Rails(info: NodeInfo | null | undefined): { name: string; label: string }[] {
  return (info?.net ?? []).filter((n) => n.role === 'interconnect' && n.peer).map((n) => ({ name: n.name, label: n.label }));
}

/** Why a node has no ConnectX-7 figures (shown with "No direct link"). */
export const NO_LINK_REASON = 'No ConnectX-7 rail on this node is cabled to another node.';

/** Short rail name for legends: "ConnectX-7 rail A" -> "Rail A". */
export const railShort = (label: string) => label.replace(/^ConnectX-7\s+/i, '').replace(/^rail/, 'Rail');

/** Sum of one direction over the given interfaces (null when none reports). */
export function sumNet(s: Sample | null, names: readonly string[], dir: 'rx_bps' | 'tx_bps'): number | null {
  if (!s) return null;
  let total = 0;
  let any = false;
  for (const n of s.net) {
    if (!names.includes(n.name)) continue;
    total += n[dir];
    any = true;
  }
  return any ? total : null;
}
