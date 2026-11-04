import type { NodeInfo, UnsupportedKind } from './types';

export interface NotReported {
  label: string;
  detail: string;
}

const WORDING: Record<UnsupportedKind, (reason: string) => NotReported> = {
  hardware: (reason) => ({ label: 'Not reported by this hardware', detail: reason }),
  access: (reason) => ({ label: reason, detail: 'The hardware can report this, but the agent lacks the privilege to read it.' }),
  dependency: (reason) => ({ label: reason, detail: 'A helper tool is missing on this node; installing it unlocks this metric.' }),
};

function covers(metric: string, key: string): boolean {
  const pattern = metric.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\d+');
  return new RegExp(`^${pattern}(?:\\.|$)`).test(key);
}

export function notReported(info: NodeInfo | null | undefined, key: string): NotReported | null {
  const u = info?.unsupported.find((x) => covers(x.metric, key));
  return u ? WORDING[u.kind ?? 'hardware'](u.reason) : null;
}

export function notReportedByHardware(reason: string): NotReported {
  return WORDING.hardware(reason);
}
