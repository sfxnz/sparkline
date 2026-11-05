import { useCallback } from 'react';
import { notReported, type NotReported } from '../../../lib/capabilities';
import { gpuIndexes, notResponding } from '../../../lib/gpu';
import { gpuKey, type NodeTotal } from '../../../lib/metrics';
import type { Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { sameGap, useTotalGap } from '../../shared/totalGap';

/** Why a metric of GPU `index` has no value: the agent declares it not reported, or the GPU sent no reading this
 *  tick. */
export function useGpuGap(nodeId: string, index: number): (key: string) => NotReported | null {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const silent = useLatest(nodeId, useCallback((s: Sample | null) => notResponding(info, s, index), [info, index]), sameGap);
  return (key) => notReported(info, key) ?? silent;
}

/** Why the node's GPU `field` has no value on the node tabs: its one GPU's gap (declared, or not responding this
 *  tick), or the gap of the node total over several GPUs. */
export function useNodeGpuGap(nodeId: string, field: NodeTotal): NotReported | null {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const [only = 0, ...more] = gpuIndexes(info);
  const gpuGap = useGpuGap(nodeId, only);
  const totalGap = useTotalGap(nodeId, field);
  return more.length ? totalGap : gpuGap(gpuKey(only, field));
}
