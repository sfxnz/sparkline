import { GPU_TOTALS, isNodeTotal } from './metrics';
import { UNSUPPORTED_KINDS, type NodeInfo, type Unsupported, type UnsupportedKind } from './types';

export interface NotReported {
  kind: UnsupportedKind;
  label: string;
  detail: string;
}

const LABEL: Record<UnsupportedKind, string> = {
  hardware: 'Not reported by this hardware',
  access: 'No access',
  dependency: 'Helper tool missing',
  agent: 'Not collected yet',
};

/** Most actionable first: a fix the operator can make before a gap the hardware imposes. */
const ACTIONABLE: readonly UnsupportedKind[] = ['access', 'dependency', 'agent', 'hardware'];

const isKind = (k: unknown): k is UnsupportedKind => (UNSUPPORTED_KINDS as readonly unknown[]).includes(k);

function covers(metric: string, key: string): boolean {
  const pattern = metric.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\d+');
  return new RegExp(`^${pattern}(?:\\.|$)`).test(key);
}

/** An exact key or literal prefix beats a `gpu*` wildcard; otherwise the longer entry names the key more closely. */
function moreSpecific(a: Unsupported, b: Unsupported): boolean {
  const aWild = a.metric.includes('*');
  return aWild !== b.metric.includes('*') ? !aWild : a.metric.length > b.metric.length;
}

/** Why the agent cannot read GPU `index` at all, though its backend sees it (a lost GPU): its `gpu<i>` entry. */
export function lostGpu(info: NodeInfo | null | undefined, index: number): NotReported | null {
  const u = info?.unsupported.find((x) => x.metric === `gpu${String(index)}`);
  return u ? { ...describeGap(u), label: 'Not responding' } : null;
}

export function notReported(info: NodeInfo | null | undefined, key: string): NotReported | null {
  let best: Unsupported | undefined;
  for (const u of info?.unsupported ?? []) if (covers(u.metric, key) && (!best || moreSpecific(u, best))) best = u;
  if (!best) return null;
  const total = /^gpu\.(\w+)$/.exec(key)?.[1];
  if (total && isNodeTotal(total) && info && info.gpus.length > 1 && info.gpus.some((g) => GPU_TOTALS[total].parts.some((p) => !notReported(info, `gpu${g.index}.${p}`)))) {
    return { ...describeGap(best), label: 'No total' };
  }
  const gpuKey = /^gpu(\d+)(?:\.|$)/.exec(key);
  const lost = gpuKey ? lostGpu(info, Number(gpuKey[1])) : null;
  return lost?.detail === best.reason ? lost : describeGap(best);
}

export function describeGap(u: Unsupported): NotReported {
  const kind = isKind(u.kind) ? u.kind : 'hardware';
  return { kind, label: LABEL[kind], detail: u.reason };
}

/** The `net` gap as it bears on the ConnectX-7 interconnect. An `agent` gap says only that Sparkline skipped Wi-Fi or
 *  virtual interfaces; when none of the node's interfaces is an interconnect, it has no link to report. */
export function interconnectGap(info: NodeInfo | null | undefined): NotReported | null {
  const gap = notReported(info, 'net');
  return gap && (gap.kind !== 'agent' || (info?.net ?? []).some((n) => n.role === 'interconnect')) ? gap : null;
}

/** One gap that holds for every node in `gaps` (display order). Nodes that share a kind and reason keep it. Otherwise
 *  the tooltip names each node's reason, one line per node, under the label the nodes share or a neutral one. */
export function gapAcross(gaps: readonly (readonly [string, NotReported])[]): NotReported | null {
  const first = gaps[0]?.[1];
  if (!first) return null;
  if (gaps.every(([, g]) => g.kind === first.kind && g.detail === first.detail)) return first;
  const kind = ACTIONABLE.find((k) => gaps.some(([, g]) => g.kind === k)) ?? first.kind;
  return { kind, label: gaps.every(([, g]) => g.label === first.label) ? first.label : 'Not reported on any node', detail: gaps.map(([id, g]) => `${id}: ${g.detail}`).join('\n') };
}

export function notReportedByHardware(reason: string): NotReported {
  return { kind: 'hardware', label: LABEL.hardware, detail: reason };
}
