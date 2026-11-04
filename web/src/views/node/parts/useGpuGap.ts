import { useCallback } from 'react';
import { notReported, type NotReported } from '../../../lib/capabilities';
import { notResponding } from '../../../lib/gpu';
import type { Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { sameGap } from '../../shared/totalGap';

/** Why a metric of GPU `index` has no value: the agent declares it not reported, or the GPU sent no reading this
 *  tick. */
export function useGpuGap(nodeId: string, index = 0): (key: string) => NotReported | null {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const silent = useLatest(nodeId, useCallback((s: Sample | null) => notResponding(info, s, index), [info, index]), sameGap);
  return (key) => notReported(info, key) ?? silent;
}
