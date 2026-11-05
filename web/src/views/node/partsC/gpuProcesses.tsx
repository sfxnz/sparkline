import { useCallback } from 'react';
import { Unsupported } from '../../../design/components/Unsupported';
import type { NotReported } from '../../../lib/capabilities';
import { gpuCountText, gpuProcessesGap, gpusWithUnknownProcesses } from '../../../lib/gpu';
import type { Sample } from '../../../lib/types';
import { quietGpusOf } from '../../../store/attention';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { sameGap } from '../../shared/totalGap';

/** Whether the node can tell which processes use its GPUs. `gap` while it can tell none of them, else `from`
 *  ("3 of 4 GPUs") while it can tell only some, '' while it can tell all. */
export function useGpuProcessesGap(nodeId: string): { gap: NotReported | null; from: string } {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const gap = useLatest(nodeId, useCallback((s: Sample | null) => gpuProcessesGap(info, s, quietGpusOf(nodeId, info)), [nodeId, info]), sameGap);
  const from = useLatest(nodeId, useCallback((s: Sample | null) => {
    const of = info?.gpus.length ?? 0;
    const unknown = gpusWithUnknownProcesses(info, s, quietGpusOf(nodeId, info)).length;
    return unknown ? gpuCountText({ from: of - unknown, of }) : '';
  }, [nodeId, info]));
  return { gap, from };
}

export function CannotTellGpuProcesses({ nodeId, gap }: { nodeId: string; gap: NotReported }) {
  const one = useCluster((s) => s.nodes[nodeId]?.info?.gpus.length === 1);
  return <>{nodeId} cannot tell which processes use its {one ? 'GPU' : 'GPUs'} <Unsupported gap={gap} /></>;
}
