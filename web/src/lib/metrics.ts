// Port of server/sparkline/common/metrics.py flatten(): Sample -> flat scalar metric keys.
// null/undefined values are omitted so unsupported metrics never masquerade as 0. Keys must stay identical.
import type { GpuSample, Sample } from './types';

export type GpuReading = Exclude<keyof GpuSample, 'index'>;
export type GpuField = GpuReading | 'power_limit_w' | 'proc_mem';
export const gpuKey = (index: number, field: GpuField) => `gpu${index}.${field}`;

const REDUCE = {
  mean: (xs: readonly number[]) => sum(xs) / xs.length,
  max: (xs: readonly number[]) => Math.max(...xs),
  sum: (xs: readonly number[]) => sum(xs),
};

/** In sample order, one addition at a time, as the Python flatten adds (no compensated summation). */
function sum(xs: readonly number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

interface GpuTotalRule {
  reduce: keyof typeof REDUCE;
  /** The GpuSample fields one GPU's value adds up. */
  parts: readonly GpuReading[];
  /** Emitted only when every GPU in the sample has a value and no backend failed the tick: a partial sum would
   *  understate. Otherwise emitted when any GPU has one. */
  every: boolean;
}

/** The node's GPU totals, the same table as the Python GPU_TOTALS (pinned by flatten.expected.json). */
export const GPU_TOTALS = {
  util: { reduce: 'mean', parts: ['util'], every: false },
  temp_c: { reduce: 'max', parts: ['temp_c'], every: false },
  power_w: { reduce: 'sum', parts: ['power_w'], every: true },
  mem_used: { reduce: 'sum', parts: ['vram_used', 'shared_used'], every: true },
} as const satisfies Record<string, GpuTotalRule>;

export type NodeTotal = keyof typeof GPU_TOTALS;
/** The totals whose one part is a GPU reading of the same name, so one GPU's own key holds the same value. */
export type ReadingTotal = { [K in NodeTotal]: (typeof GPU_TOTALS)[K]['parts'] extends readonly [K] ? K : never }[NodeTotal];

export const isNodeTotal = (name: string): name is NodeTotal => Object.hasOwn(GPU_TOTALS, name);
export const isReadingTotal = (field: NodeTotal): field is ReadingTotal => {
  const parts: readonly string[] = GPU_TOTALS[field].parts;
  return parts.length === 1 && parts[0] === field;
};

/** One GPU's value of a node total: the sum of the parts it reports, null when it reports none. */
export function gpuValue(g: GpuSample, field: NodeTotal): number | null {
  let value: number | null = null;
  for (const part of GPU_TOTALS[field].parts) {
    const v = g[part];
    if (v != null) value = (value ?? 0) + v;
  }
  return value;
}

/** The node's GPU totals over the GPUs in a sample, by the GPU_TOTALS rules. A backend that failed this tick dropped
 *  its GPUs out of the sample, so an `every` total is missing then. */
export function gpuTotals(s: Pick<Sample, 'gpu' | 'errors'>): Record<NodeTotal, number | null> {
  const out = {} as Record<NodeTotal, number | null>;
  for (const field of Object.keys(GPU_TOTALS) as NodeTotal[]) {
    const rule: GpuTotalRule = GPU_TOTALS[field];
    const values = s.gpu.map((g) => gpuValue(g, field));
    const got = values.filter((v) => v !== null);
    const whole = got.length === values.length && s.errors.gpu === undefined;
    out[field] = got.length && (!rule.every || whole) ? REDUCE[rule.reduce](got) : null;
  }
  return out;
}

export function mountKey(mount: string): string {
  const stripped = mount.replace(/^\/+|\/+$/g, '');
  return stripped ? stripped.replaceAll('/', '_') : 'root';
}

const MEM_KEYS = ['used', 'available', 'gpu', 'anon', 'cache', 'shmem', 'kernel', 'other', 'swap_used'] as const;

export function flatten(s: Sample): Map<string, number> {
  const out = new Map<string, number>();
  const put = (key: string, value: number | null | undefined) => {
    if (value != null) out.set(key, value);
  };

  for (const g of s.gpu) {
    const p = `gpu${g.index}.`;
    put(p + 'util', g.util);
    put(p + 'sm_mhz', g.sm_mhz);
    put(p + 'temp_c', g.temp_c);
    put(p + 'power_w', g.power_w);
    put(p + 'energy_j', g.energy_j);
    put(p + 'throttle_mask', g.throttle_mask);
    put(p + 'power_capped_pct', g.power_capped_pct);
    put(p + 'thermal_capped_pct', g.thermal_capped_pct);
    put(p + 'vram_used', g.vram_used);
    put(p + 'shared_used', g.shared_used);
  }
  for (const [field, value] of Object.entries(gpuTotals(s))) put(`gpu.${field}`, value);

  const m = s.mem;
  if (m.total) {
    for (const name of MEM_KEYS) put(`mem.${name}`, m[name]);
    put('mem.psi_some', m.psi_some);
    put('mem.psi_full', m.psi_full);
    put('mem.used_pct', (100 * m.used) / m.total);
  }

  const c = s.cpu;
  put('cpu.util', c.util);
  put('cpu.perf_util', c.perf_util);
  put('cpu.eff_util', c.eff_util);
  put('cpu.load1', c.load1);
  put('cpu.load5', c.load5);
  put('cpu.load15', c.load15);
  put('cpu.psi_some', c.psi_some);
  c.per_core.forEach((u, i) => { put(`cpu.core${i}.util`, u); });
  c.freq_mhz.forEach((f, i) => { put(`cpu.core${i}.mhz`, f); });

  for (const n of s.net) {
    const p = `net.${n.name}.`;
    put(p + 'rx_bps', n.rx_bps);
    put(p + 'tx_bps', n.tx_bps);
    put(p + 'errors', n.errors);
    put(p + 'drops', n.drops);
    put(p + 'up', n.up ? 1 : 0);
  }

  for (const d of s.disk) {
    const p = `disk.${d.name}.`;
    put(p + 'read_bps', d.read_bps);
    put(p + 'write_bps', d.write_bps);
    put(p + 'read_iops', d.read_iops);
    put(p + 'write_iops', d.write_iops);
    put(p + 'busy_pct', d.busy_pct);
  }

  for (const f of s.fs) {
    put(`fs.${f.key}.used`, f.used);
    put(`fs.${f.key}.total`, f.total);
    put(`fs.${f.key}.free`, f.free);
    if (f.used + f.free) put(`fs.${f.key}.used_pct`, (100 * f.used) / (f.used + f.free)); // like df
  }

  for (const t of s.temps) put(`temp.${t.id}`, t.c);

  return out;
}
