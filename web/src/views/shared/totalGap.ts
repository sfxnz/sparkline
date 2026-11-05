import { useCallback } from 'react';
import type { NotReported } from '../../lib/capabilities';
import { gpuCountText, nodeTotalGap, totalFrom } from '../../lib/gpu';
import type { NodeTotal } from '../../lib/metrics';
import type { Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useLatest } from '../../store/live';

export const sameGap = (a: NotReported | null, b: NotReported | null) => a?.label === b?.label && a?.detail === b?.detail;

/** "3 of 4 GPUs" while the node's `field` total reads only some of its GPUs (`totalFrom`), else ''. */
export function useTotalFrom(nodeId: string, field: Exclude<NodeTotal, 'power_w'>): string {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  return useLatest(nodeId, useCallback((s: Sample | null) => {
    const count = totalFrom(info, s, field);
    return count ? gpuCountText(count) : '';
  }, [info, field]));
}

export function useTotalGap(nodeId: string, field: NodeTotal): NotReported | null {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  return useLatest(nodeId, useCallback((s: Sample | null) => nodeTotalGap(info, s, field), [info, field]), sameGap);
}
