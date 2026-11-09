// CPU core layout, derived from NodeInfo.cores at runtime (never hard-coded): performance first, then efficiency.
import type { CoreInfo } from './types';

export interface CoreGroup {
  kind: CoreInfo['kind'];
  name: string;
  label: string;
  design: string | null;
  /** Highest max frequency in the group, MHz. */
  maxMhz: number | null;
  cores: CoreInfo[];
}

export interface CoreLayout {
  product: string | null;
  split: boolean;
  groups: CoreGroup[];
}

const ORDER: readonly CoreInfo['kind'][] = ['performance', 'efficiency', 'unknown'];
const NAME: Record<CoreInfo['kind'], string> = { performance: 'Performance', efficiency: 'Efficiency', unknown: 'Other' };
export const ALL_CORES = 'All cores';

export function coreLayout(cores: readonly CoreInfo[], cpuModel: string | null): CoreLayout {
  const product = cpuModel !== null && cores.some((c) => c.model === cpuModel) ? cpuModel : null;
  const own = product === null ? cores : cores.map((c) => (c.model === product ? { ...c, model: null } : c));
  const split = cores.some((c) => c.kind !== 'unknown');
  const groups = ORDER.flatMap((kind) => {
    const list = own.filter((c) => c.kind === kind).sort((a, b) => a.id - b.id);
    if (!list.length) return [];
    const designs = new Set(list.map((c) => c.model));
    const mhz = list.map((c) => c.max_mhz).filter((m): m is number => m != null);
    return [{
      kind,
      name: split ? NAME[kind] : ALL_CORES,
      label: split ? `${NAME[kind]} cores` : ALL_CORES,
      design: designs.size === 1 ? (list[0]?.model ?? null) : null,
      maxMhz: mhz.length ? Math.max(...mhz) : null,
      cores: list,
    }];
  });
  return { product, split, groups };
}
