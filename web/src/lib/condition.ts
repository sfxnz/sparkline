// Live GPU condition: what the latest sample already shows, before any alert rule has waited out its duration.
// The UI flags these values the moment they appear (red "At slowdown", a critical clock-limit banner), so the node's
// status pill and the cluster sentence must reflect them too; alert durations only gate notifications.
import { formatTemp } from './format';
import { lostGpu } from './capabilities';
import { gpuAt, gpuIndexes, gpuList } from './gpu';
import { decodeThrottle, worstSeverity } from './throttle';
import type { GpuInfo, NodeInfo, Sample } from './types';

export interface LiveCondition {
  level: 'warning' | 'critical';
  /** Clause after the node name: "spark1 is at its GPU slowdown temperature". */
  text: string;
}

const HEADROOM_WARN_C = 6;

export interface TempRoom {
  degrees: number;
  level: 'ok' | 'warn' | 'crit';
}

export function tempRoom(tempC: number | null | undefined, limitC: number | null | undefined): TempRoom | null {
  if (tempC == null || limitC == null || !Number.isFinite(tempC) || !Number.isFinite(limitC)) return null;
  const shown = (c: number) => Math.round(c);
  const degrees = shown(limitC) - shown(tempC);
  return { degrees, level: degrees <= 0 ? 'crit' : degrees <= HEADROOM_WARN_C ? 'warn' : 'ok' };
}

export interface HeadroomGpu {
  temp: number | null;
  slowdown: number | null;
  shutdown: number | null;
  /** "GPU 3" on a node with several GPUs, null on a node with one. */
  name: string | null;
}

/** The GPU a node's temperature footer measures. A node with one GPU (or none): that GPU at `oneGpuTemp`. A node
 *  with several: the one with the least headroom to its own slowdown in `tempOf` (ties: lowest index; without any
 *  slowdown, the hottest), named. */
export function headroomGpu(info: NodeInfo | null | undefined, oneGpuTemp: number | null, tempOf: (index: number) => number | null): HeadroomGpu {
  const gpus = info?.gpus ?? [];
  if (gpus.length <= 1) {
    const [only = 0] = gpuIndexes(info);
    const g = gpuAt(gpus, only);
    return { temp: oneGpuTemp, slowdown: g?.temp_slowdown_c ?? null, shutdown: g?.temp_shutdown_c ?? null, name: null };
  }
  let best: { g: GpuInfo; temp: number; room: number } | null = null;
  for (const g of gpus.toSorted((a, b) => a.index - b.index)) {
    const temp = tempOf(g.index);
    if (temp === null) continue;
    const room = tempRoom(temp, g.temp_slowdown_c)?.degrees ?? Infinity;
    const closer = room === Infinity ? best?.room === Infinity && temp > best.temp : room < (best?.room ?? Infinity);
    if (!best || closer) best = { g, temp, room };
  }
  return best
    ? { temp: best.temp, slowdown: best.g.temp_slowdown_c, shutdown: best.g.temp_shutdown_c, name: `GPU ${best.g.index}` }
    : { temp: null, slowdown: null, shutdown: null, name: null };
}

interface ConditionInput {
  temp_c: number | null | undefined;
  throttle_mask: number | null | undefined;
}

export interface GpuCondition extends LiveCondition {
  index: number;
  /** What is wrong, short: "At slowdown", "Clocks limited by thermal limit". */
  what: string;
  /** `what` with the GPU's reading: "At slowdown, 94 °C (slows at 93 °C)". */
  reading: string;
  /** What a node sentence says after "has GPU 3" (one) or "has GPUs 2 and 3" (many). */
  clause: { one: string; many: string };
  /** The GPU reading it comes from, which an alert rule can watch; null for a GPU that sends no reading. */
  field: 'temp_c' | 'throttle_mask' | null;
}

function gpuCondition(index: number, gpu: ConditionInput, slowdownC: number | null | undefined): GpuCondition | null {
  const room = tempRoom(gpu.temp_c, slowdownC);
  const temp = `, ${formatTemp(gpu.temp_c)} (slows at ${formatTemp(slowdownC)})`;
  if (room?.level === 'crit') {
    return { index, level: 'critical', text: 'is at its GPU slowdown temperature', what: 'At slowdown', reading: `At slowdown${temp}`, clause: { one: 'at its slowdown temperature', many: 'at their slowdown temperature' }, field: 'temp_c' };
  }
  // Info-level reasons (idle, power cap, application clocks) are normal operation and never raise a node.
  const limiting = decodeThrottle(gpu.throttle_mask).filter((r) => r.severity !== 'info');
  const worst = worstSeverity(limiting);
  if (worst === 'critical' || worst === 'warning') {
    const limits = limiting.filter((r) => r.severity === worst).map((r) => r.title.toLowerCase()).join(' and ');
    const what = `Clocks limited by ${limits}`;
    return { index, level: worst, text: `has GPU clocks limited by ${limits}`, what, reading: what, clause: { one: `clocks limited by ${limits}`, many: `clocks limited by ${limits}` }, field: 'throttle_mask' };
  }
  if (room?.level === 'warn') return { index, level: 'warning', text: 'is heating up', what: 'Heating up', reading: `Heating up${temp}`, clause: { one: 'heating up', many: 'heating up' }, field: 'temp_c' };
  return null;
}

const NOT_RESPONDING = 'Not responding';

const silentCondition = (index: number): GpuCondition => ({
  index, level: 'warning', text: 'has a GPU not responding', what: NOT_RESPONDING, reading: NOT_RESPONDING, clause: { one: 'not responding', many: 'not responding' }, field: null,
});

/** The GPUs the node lists, not lost, that have sent no reading for as long as the console takes to call a whole node
 *  not reporting: stale_after_s (5 s without the console's settings), never under two sample intervals and a second.
 *  `silentFor` is how long a GPU has been missing from the live samples (null before any), counted again after a gap
 *  in the samples of at least `gapS`. */
export function quietGpus(info: NodeInfo | null | undefined, staleAfterS: number | undefined, silentFor: (index: number, gapS: number) => number | null): number[] {
  const afterS = Math.max(staleAfterS ?? 5, (2 * (info?.sample_interval_ms ?? 1000)) / 1000 + 1);
  return (info?.gpus ?? []).filter((g) => !lostGpu(info, g.index) && (silentFor(g.index, afterS) ?? 0) >= afterS).map((g) => g.index);
}

/** Each GPU's live condition in the sample, in index order; GPUs with nothing on screen to flag are left out. A lost
 *  GPU, and one in `quiet` (quietGpus), is not responding. */
export function gpuConditions(info: NodeInfo | null | undefined, s: Sample | null, quiet: readonly number[] = []): GpuCondition[] {
  const silent = (info?.gpus ?? []).filter((g) => lostGpu(info, g.index) || quiet.includes(g.index)).map((g) => silentCondition(g.index));
  const live = (s?.gpu ?? []).flatMap((g) => (silent.some((c) => c.index === g.index) ? [] : (gpuCondition(g.index, g, gpuAt(info?.gpus, g.index)?.temp_slowdown_c) ?? [])));
  return [...silent, ...live].toSorted((a, b) => a.index - b.index);
}

export interface ConditionGroup {
  /** The first GPU's condition; the others share its `what` and clause. */
  condition: GpuCondition;
  indexes: number[];
}

/** The GPUs that share each `what`, groups in the order their first GPU appears. */
export function byWhat(conditions: readonly GpuCondition[]): ConditionGroup[] {
  const groups: ConditionGroup[] = [];
  for (const c of conditions) {
    const group = groups.find((g) => g.condition.what === c.what);
    if (group) group.indexes.push(c.index);
    else groups.push({ condition: c, indexes: [c.index] });
  }
  return groups;
}

/** What a node's latest sample flags on its GPUs. */
export interface NodeConditions {
  /** Each flagged GPU's condition, in index order. */
  gpus: readonly GpuCondition[];
  /** A node with one GPU says its condition of the node ("spark1 is heating up"), not of "GPU 0". */
  oneGpu: boolean;
}

/** The node's flagged GPUs, or null when nothing on screen would be flagged. */
export function nodeConditions(info: NodeInfo | null | undefined, s: Sample | null, quiet: readonly number[] = []): NodeConditions | null {
  const gpus = gpuConditions(info, s, quiet);
  return gpus.length ? { gpus, oneGpu: (info?.gpus.length ?? 0) <= 1 && (s?.gpu.length ?? 0) <= 1 } : null;
}

/** The worst of the node's conditions, or null when it has none. A node with one GPU says it of the node ("is at its
 *  GPU slowdown temperature"); a node with several names the GPUs at that level ("has GPU 3 at its slowdown
 *  temperature"). */
export function worstCondition(c: NodeConditions): LiveCondition | null {
  const level = c.gpus.some((g) => g.level === 'critical') ? 'critical' : 'warning';
  const worst = c.gpus.filter((g) => g.level === level);
  const groups = byWhat(worst);
  const [top] = groups;
  if (!top) return null;
  if (c.oneGpu) return { level, text: top.condition.text };
  if (groups.length > 2) return { level, text: `has ${worst.length} GPUs needing attention` };
  const said = groups.map((g) => `${gpuList(g.indexes)} ${g.indexes.length > 1 ? g.condition.clause.many : g.condition.clause.one}`);
  return { level, text: `has ${said.join(' and ')}` };
}

/** The node's worst live condition, or null when nothing on screen would be flagged. */
export function nodeCondition(info: NodeInfo | null | undefined, s: Sample | null, quiet: readonly number[] = []): LiveCondition | null {
  const c = nodeConditions(info, s, quiet);
  return c && worstCondition(c);
}

/** Stable identity for equality checks (useLatest re-renders only when this changes). */
export const sameCondition = (a: LiveCondition | null, b: LiveCondition | null) => a === b || (!!a && !!b && a.level === b.level && a.text === b.text);

export const sameGpuConditions = (a: readonly GpuCondition[], b: readonly GpuCondition[]) =>
  a.length === b.length && a.every((c, i) => b[i]?.index === c.index && b[i].level === c.level && b[i].reading === c.reading);

export const sameNodeConditions = (a: NodeConditions | null, b: NodeConditions | null) =>
  a === b || (!!a && !!b && a.oneGpu === b.oneGpu && sameGpuConditions(a.gpus, b.gpus));
