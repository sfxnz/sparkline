import type { NodeInfo } from './types';

/** Reason a metric key is not reported by this node, if listed in NodeInfo.unsupported (exact key or prefix). */
export function unsupportedReason(info: NodeInfo | null | undefined, key: string): string | null {
  const u = info?.unsupported.find((x) => key === x.metric || key.startsWith(`${x.metric}.`));
  return u?.reason ?? null;
}
