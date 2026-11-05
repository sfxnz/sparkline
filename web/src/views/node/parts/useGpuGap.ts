import { useCallback } from 'react';
import { notReported, type NotReported } from '../../../lib/capabilities';
import { notResponding } from '../../../lib/gpu';
import type { Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';

const sameGap = (a: NotReported | null, b: NotReported | null) => a?.label === b?.label && a?.detail === b?.detail;

/** Why a GPU 0 metric has no value: the agent declares it not reported, or GPU 0 sent no reading this tick. */
export function useGpuGap(nodeId: string): (key: string) => NotReported | null {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const silent = useLatest(nodeId, useCallback((s: Sample | null) => notResponding(info, s, 0), [info]), sameGap);
  return (key) => notReported(info, key) ?? silent;
}
