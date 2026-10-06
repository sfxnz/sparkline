// Port of server/sparkline/common/metrics.py flatten(): Sample -> flat scalar metric keys.
// null/undefined values are omitted so unsupported metrics never masquerade as 0. Keys must stay identical.
import type { Sample } from './types';

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
  }

  const m = s.mem;
  for (const name of MEM_KEYS) put(`mem.${name}`, m[name]);
  put('mem.psi_some', m.psi_some);
  put('mem.psi_full', m.psi_full);
  if (m.total) put('mem.used_pct', (100 * m.used) / m.total);

  const c = s.cpu;
  put('cpu.util', c.util);
  put('cpu.perf_util', c.perf_util);
  put('cpu.eff_util', c.eff_util);
  put('cpu.load1', c.load1);
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
    if (f.used + f.free) put(`fs.${f.key}.used_pct`, (100 * f.used) / (f.used + f.free)); // like df
  }

  for (const t of s.temps) put(`temp.${t.id}`, t.c);

  return out;
}
