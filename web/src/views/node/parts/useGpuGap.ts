import { useCallback } from 'react';
import { notReported, type NotReported } from '../../../lib/capabilities';
import { nodeGpuGap, notResponding } from '../../../lib/gpu';
import type { ReadingTotal } from '../../../lib/metrics';
import type { Sample } from '../../../lib/types';
import { silentForOf } from '../../../store/attention';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { sameGap } from '../../shared/totalGap';

/** Why a metric of GPU `index` has no value: the agent declares it not reported, or the GPU sent no reading this
 *  tick. */
export function useGpuGap(nodeId: string, index: number): (key: string) => NotReported | null {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const silent = useLatest(nodeId, useCallback((s: Sample | null) => notResponding(info, s, index, silentForOf(nodeId, info)), [nodeId, info, index]), sameGap);
  return (key) => notReported(info, key) ?? silent;
}

/** Why the node's GPU `field` has no value on its own stats (nodeGpuGap). */
export function useNodeGpuGap(nodeId: string, field: ReadingTotal): NotReported | null {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  return useLatest(nodeId, useCallback((s: Sample | null) => nodeGpuGap(info, s, field, silentForOf(nodeId, info)), [nodeId, info, field]), sameGap);
}
