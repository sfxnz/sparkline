import { useCallback } from 'react';
import { notReported, type NotReported } from '../../lib/capabilities';
import { nodeGpuKey, totalGap } from '../../lib/gpu';
import type { NodeTotal } from '../../lib/metrics';
import type { Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useLatest } from '../../store/live';

export const sameGap = (a: NotReported | null, b: NotReported | null) => a?.label === b?.label && a?.detail === b?.detail;

/** Why the node's GPU `field` has no value: the agent declares it not reported, or (several GPUs) the total
 *  dropped out of this sample. */
export function useTotalGap(nodeId: string, field: NodeTotal): NotReported | null {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const dropped = useLatest(nodeId, useCallback((s: Sample | null) => totalGap(info, s, field), [info, field]), sameGap);
  return notReported(info, nodeGpuKey(info, field)) ?? dropped;
}
