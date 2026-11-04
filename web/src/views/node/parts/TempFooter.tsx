import { useCallback } from 'react';
import { headroomGpu, type HeadroomGpu } from '../../../lib/condition';
import { gpuKey } from '../../../lib/metrics';
import { useCluster } from '../../../store/cluster';
import type { LiveStore } from '../../../store/live';
import { useLiveDerived } from '../partsC/hooks';
import { tempHeadroom } from './gpu';

/** Headroom to the GPU's slowdown/shutdown points; coloured only when close or over, and always said in words.
 *  `name` ("GPU 3") says which GPU on a node with several. */
export function TempFooter({ temp, slowdown, shutdown, name = null }: { temp: number | null; slowdown: number | null; shutdown: number | null; name?: string | null }) {
  const h = tempHeadroom(temp, slowdown, shutdown);
  if (!h) return null;
  return <span className={h.level === 'ok' ? undefined : `nlevel-${h.level}`}>{name ? `${name} · ${h.text}` : h.text}</span>;
}

const sameHeadroom = (a: HeadroomGpu, b: HeadroomGpu) => a.temp === b.temp && a.slowdown === b.slowdown && a.shutdown === b.shutdown && a.name === b.name;

/** The node's temperature footer: its one GPU's headroom at the node reading `value`, or on a node with several the
 *  GPU closest to its own slowdown, named. */
export function NodeTempFooter({ nodeId, value }: { nodeId: string; value: number | null }) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const compute = useCallback((st: LiveStore) => headroomGpu(info, value, (i) => st.latestValue(nodeId, gpuKey(i, 'temp_c'))), [info, value, nodeId]);
  const gpu = useLiveDerived(nodeId, compute, sameHeadroom);
  return <TempFooter temp={gpu.temp} slowdown={gpu.slowdown} shutdown={gpu.shutdown} name={gpu.name} />;
}
