import { useCallback } from 'react';
import { headroomGpu, type HeadroomGpu } from '../../../lib/condition';
import { gpuKey } from '../../../lib/metrics';
import { useCluster } from '../../../store/cluster';
import { useTotalFrom } from '../../shared/totalGap';
import type { LiveStore } from '../../../store/live';
import { useLiveDerived } from '../partsC/hooks';
import { tempHeadroom } from './gpu';

/** Headroom to the GPU's slowdown/shutdown points; coloured only when close or over, and always said in words.
 *  `name` ("GPU 3") says which GPU on a node with several, `from` ("3 of 4 GPUs") how many a node's reading covers. */
export function TempFooter({ temp, slowdown, shutdown, name = null, from = '' }: { temp: number | null; slowdown: number | null; shutdown: number | null; name?: string | null; from?: string }) {
  const h = tempHeadroom(temp, slowdown, shutdown);
  if (!h) return from || null;
  return (
    <>
      <span className={h.level === 'ok' ? undefined : `nlevel-${h.level}`}>{name ? `${name} · ${h.text}` : h.text}</span>
      {from ? ` · ${from}` : null}
    </>
  );
}

const sameHeadroom = (a: HeadroomGpu, b: HeadroomGpu) => a.temp === b.temp && a.slowdown === b.slowdown && a.shutdown === b.shutdown && a.name === b.name;

/** `oneGpuTemp` is the stat's own reading, which the footer measures on a node with one GPU. */
export function NodeTempFooter({ nodeId, oneGpuTemp }: { nodeId: string; oneGpuTemp: number | null }) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const compute = useCallback((st: LiveStore) => headroomGpu(info, oneGpuTemp, (i) => st.latestValue(nodeId, gpuKey(i, 'temp_c'))), [info, oneGpuTemp, nodeId]);
  const gpu = useLiveDerived(nodeId, compute, sameHeadroom);
  const from = useTotalFrom(nodeId, 'temp_c');
  return <TempFooter temp={gpu.temp} slowdown={gpu.slowdown} shutdown={gpu.shutdown} name={gpu.name} from={from} />;
}
