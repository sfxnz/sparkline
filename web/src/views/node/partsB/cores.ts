import type { SeriesSpec } from '../../../charts/TimeSeriesChart';
import { DASH, type Formatter } from '../../../lib/format';
import { ALL_CORES, type CoreGroup, type CoreLayout } from '../../../lib/cores';

const UTIL_KEY = { performance: 'cpu.perf_util', efficiency: 'cpu.eff_util' } as const;

export function utilSeries(layout: CoreLayout, { designs = false } = {}): SeriesSpec[] {
  if (!layout.split) return [{ key: 'cpu.util', label: ALL_CORES }];
  return layout.groups.flatMap((g) => (g.kind === 'unknown' ? [] : [{ key: UTIL_KEY[g.kind], label: designs && g.design ? `${g.name} (${g.design})` : g.name }]));
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

export function groupSize(g: CoreGroup): string {
  const n = g.cores.length;
  if (g.design) return `${n} × ${g.design}`;
  return g.cores.some((c) => c.model) ? `${n} × mixed cores` : `${n} ${n === 1 ? 'core' : 'cores'}`;
}

export function groupDetail(layout: CoreLayout, g: CoreGroup): string {
  const parts = [!layout.split && layout.product ? layout.product : groupSize(g)];
  if (g.maxMhz != null) parts.push(`up to ${(g.maxMhz / 1000).toFixed(2)} GHz`);
  return parts.join(' · ');
}
