// CPU core layout, derived from NodeInfo.cores at runtime (never hard-coded): performance first, then efficiency.
import { DASH, type Formatter } from '../../../lib/format';
import type { CoreInfo } from '../../../lib/types';

export interface CoreGroup {
  kind: CoreInfo['kind'];
  name: string;
  /** The model shared by the group's cores ("Cortex-X925"); null when unknown or mixed. */
  model: string | null;
  /** Highest max frequency in the group, MHz. */
  maxMhz: number | null;
  cores: CoreInfo[];
}

const ORDER: readonly CoreInfo['kind'][] = ['performance', 'efficiency', 'unknown'];
const NAME: Record<CoreInfo['kind'], string> = { performance: 'Performance', efficiency: 'Efficiency', unknown: 'Other' };

export function groupCores(cores: readonly CoreInfo[]): CoreGroup[] {
  return ORDER.flatMap((kind) => {
    const list = cores.filter((c) => c.kind === kind).sort((a, b) => a.id - b.id);
    if (!list.length) return [];
    const models = new Set(list.map((c) => c.model));
    const first = list[0]?.model ?? null;
    const mhz = list.map((c) => c.max_mhz).filter((m): m is number => m != null);
    return [{ kind, name: NAME[kind], model: models.size === 1 ? first : null, maxMhz: mhz.length ? Math.max(...mhz) : null, cores: list }];
  });
}

/** Mean of the values present (missing ones ignored); null when none have data. */
export function meanUtil(values: readonly (number | null | undefined)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v == null || Number.isNaN(v)) continue;
    sum += v;
    n++;
  }
  return n ? sum / n : null;
}

/** Load average shown against the core count: "4.20" + "on 20 cores". */
export function loadFormatter(cores: number): Formatter {
  const unit = `on ${cores} ${cores === 1 ? 'core' : 'cores'}`;
  return (v) => (Number.isFinite(v) ? { value: v.toFixed(v < 10 ? 2 : 1), unit } : { value: DASH, unit: '' });
}

/** Group label line: "10 × Cortex-X925 · up to 3.90 GHz". */
export function groupDetail(g: CoreGroup): string {
  const parts = [`${g.cores.length} × ${g.model ?? 'mixed cores'}`];
  if (g.maxMhz != null) parts.push(`up to ${(g.maxMhz / 1000).toFixed(2)} GHz`);
  return parts.join(' · ');
}
