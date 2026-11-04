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
};

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

export function notReported(info: NodeInfo | null | undefined, key: string): NotReported | null {
  let best: Unsupported | undefined;
  for (const u of info?.unsupported ?? []) if (covers(u.metric, key) && (!best || moreSpecific(u, best))) best = u;
  if (!best) return null;
  const kind = isKind(best.kind) ? best.kind : 'hardware';
  return { kind, label: LABEL[kind], detail: best.reason };
}

export function notReportedByHardware(reason: string): NotReported {
  return { kind: 'hardware', label: LABEL.hardware, detail: reason };
}
