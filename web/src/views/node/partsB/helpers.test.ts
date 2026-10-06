import type { CoreInfo, NetIfInfo } from '../../../lib/types';
import { groupCores, groupDetail, loadFormatter, meanUtil } from './cores';
import { classifyInterfaces, counterTotal, errorSummary, lineRateUtil, rdmaRateLabel, rdmaStateLabel, speedLabel } from './net';
import type { AlertRule } from '../../../lib/types';
import { bytesRateParts, capacityLevel, capacityPolicy, capacityRules, formatIops, fsFigures, fsUsedPct, iopsParts } from './storage';

const core = (id: number, kind: CoreInfo['kind'], model: string | null, max_mhz: number | null): CoreInfo => ({ id, kind, model, max_mhz, cluster: null });
// GB10 layout from DISCOVERY.md: 0–4 and 10–14 are A725 (efficiency), 5–9 and 15–19 are X925 (performance).
const gb10 = Array.from({ length: 20 }, (_, id) =>
  id % 10 < 5 ? core(id, 'efficiency', 'Cortex-A725', 2808) : core(id, 'performance', 'Cortex-X925', 3900),
);

describe('groupCores', () => {
  it('puts performance above efficiency, cores in id order, with model and max clock', () => {
    const g = groupCores([...gb10].reverse());
    expect(g.map((x) => x.kind)).toEqual(['performance', 'efficiency']);
    expect(g[0]?.cores.map((c) => c.id)).toEqual([5, 6, 7, 8, 9, 15, 16, 17, 18, 19]);
    expect(g[1]?.cores.map((c) => c.id)).toEqual([0, 1, 2, 3, 4, 10, 11, 12, 13, 14]);
    expect(g[0]?.model).toBe('Cortex-X925');
    expect(g[0]?.maxMhz).toBe(3900);
    expect(g.map(groupDetail)).toEqual(['10 × Cortex-X925 · up to 3.90 GHz', '10 × Cortex-A725 · up to 2.81 GHz']);
  });

  it('handles a homogeneous CPU, unknown kinds and mixed models', () => {
    const g = groupCores([core(0, 'unknown', 'A', 2000), core(1, 'unknown', 'B', null)]);
    expect(g).toHaveLength(1);
    expect(g[0]?.name).toBe('Other');
    expect(g[0]?.model).toBeNull();
    expect(g[0]?.maxMhz).toBe(2000);
    expect(g.map(groupDetail)).toEqual(['2 × mixed cores · up to 2.00 GHz']);
    expect(groupCores([])).toEqual([]);
  });

  it('averages utilisation, ignoring missing cores', () => {
    expect(meanUtil([20, 40])).toBe(30);
    expect(meanUtil([null, 30, undefined, NaN])).toBe(30);
    expect(meanUtil([])).toBeNull();
  });

  it('describes load relative to the core count', () => {
    expect(loadFormatter(20)(4.2)).toEqual({ value: '4.20', unit: 'on 20 cores' });
    expect(loadFormatter(20)(24.25)).toEqual({ value: '24.3', unit: 'on 20 cores' });
    expect(loadFormatter(1)(1)).toEqual({ value: '1.00', unit: 'on 1 core' });
    expect(loadFormatter(20)(NaN).unit).toBe('');
  });
});

describe('lineRateUtil', () => {
  it('is the busiest direction as a share of line rate (bytes/s vs Mb/s)', () => {
    // 12.5 GB/s = 100 Gb/s on a 200 Gb/s link
    expect(lineRateUtil(12.5e9, 1e9, 200_000)).toBeCloseTo(50);
    expect(lineRateUtil(1e9, 12.5e9, 200_000)).toBeCloseTo(50);
    expect(lineRateUtil(125e6, 0, 10_000)).toBeCloseTo(10);
  });
  it('clamps, and is unknown without a line rate', () => {
    expect(lineRateUtil(1e12, 0, 10_000)).toBe(100);
    expect(lineRateUtil(1e9, 1e9, null)).toBeNull();
    expect(lineRateUtil(1e9, 1e9, 0)).toBeNull();
    expect(lineRateUtil(null, null, 1000)).toBe(0);
  });
});

describe('classifyInterfaces', () => {
  const nif = (name: string, role: NetIfInfo['role'], peer: string | null = null): NetIfInfo => ({ name, role, label: name, mac: null, ipv4: [], speed_mbps: null, rdma_device: null, counter_source: 'netdev', peer });
  const net = [nif('railA', 'interconnect', 'spark2'), nif('railB', 'interconnect', 'spark2'), nif('spare', 'interconnect'), nif('lan', 'lan'), nif('docker0', 'virtual'), nif('wl', 'wireless'), nif('eth9', 'other')];

  it('shows up or peered rails as cards, lists cable-less ports, hides virtual and wireless', () => {
    const up = new Set(['railA', 'lan']);
    const g = classifyInterfaces(net, (n) => up.has(n));
    expect(g.links.map((n) => n.name)).toEqual(['railA', 'railB']); // railB is down but wired to a peer: a card with "Link down"
    expect(g.notConnected.map((n) => n.name)).toEqual(['spare']);
    expect(g.lan.map((n) => n.name)).toEqual(['lan', 'eth9']);
    expect(g.hidden.map((n) => n.name)).toEqual(['docker0', 'wl']);
  });

  it('treats an up port without a known peer as a link', () => {
    expect(classifyInterfaces([nif('spare', 'interconnect')], () => true).links).toHaveLength(1);
  });
});

describe('network labels', () => {
  it('formats speeds and RDMA state', () => {
    expect(speedLabel(200_000)).toBe('200\u00a0Gb/s');
    expect(speedLabel(2500)).toBe('2.5\u00a0Gb/s');
    expect(speedLabel(100)).toBe('100\u00a0Mb/s');
    expect(speedLabel(null)).toBeNull();
    expect(rdmaRateLabel('200 Gb/sec (4X HDR)')).toBe('200 Gb/s (4X HDR)');
    expect(rdmaStateLabel('ACTIVE')).toBe('Active');
    expect(rdmaStateLabel('4: ACTIVE')).toBe('Active');
    expect(rdmaStateLabel(null)).toBeNull();
  });

  it('says errors in plain English', () => {
    expect(errorSummary(0, 0)).toEqual({ tone: 'ok', text: 'No errors or drops' });
    expect(errorSummary(1, 0)).toEqual({ tone: 'warn', text: '1 error' });
    expect(errorSummary(3, 1200)).toEqual({ tone: 'warn', text: '3 errors · 1,200 drops' });
    expect(errorSummary(null, 0).tone).toBe('unknown');
  });

  it('totals per-interval counts (rollups sum them per bucket), rounded', () => {
    expect(counterTotal([0, 3, null, 1])).toBe(4);
    expect(counterTotal([0, 0, 0])).toBe(0);
    expect(counterTotal([0.4, 0.4])).toBe(1);
    expect(counterTotal([])).toBe(0);
  });
});

describe('storage', () => {
  it('computes used share like df (used / (used + free))', () => {
    expect(fsUsedPct({ used: 82, free: 18 })).toBe(82);
    expect(fsUsedPct({ used: 0, free: 0 })).toBeNull();
  });

  const rule = (p: Partial<AlertRule>): AlertRule => ({
    id: 'disk_full', name: 'Disk almost full', enabled: true, kind: 'threshold', metric: 'fs.root.used_pct', op: '>', threshold: 90, for_s: 60, severity: 'warning', nodes: null, ...p,
  });

  it('takes its levels from the enabled disk-space alert rules, not fixed numbers', () => {
    const rules = capacityRules([rule({}), rule({ id: 'x', metric: 'mem.used_pct' }), rule({ id: 'off', enabled: false, threshold: 50 })], 'spark1', 'root');
    expect(rules).toEqual([{ pct: 90, severity: 'warning', name: 'Disk almost full' }]);
    expect(capacityLevel(87, rules)).toBe('ok'); // no alert fires at 87%, so the bar is not amber
    expect(capacityLevel(90, rules)).toBe('ok'); // rules fire above the threshold
    expect(capacityLevel(90.5, rules)).toBe('warn');
    expect(capacityLevel(null, rules)).toBe('ok');
    const two = capacityRules([rule({}), rule({ id: 'c', threshold: 97, severity: 'critical', name: 'Disk full' })], 'spark1', 'root');
    expect(capacityLevel(98, two)).toBe('crit');
    expect(capacityPolicy(two)).toBe('Alerts at 90%, critical at 97% used (Disk almost full, Disk full)');
    expect(capacityPolicy([])).toBe('No disk-space alert is set for this filesystem');
    expect(capacityRules([rule({ nodes: ['spark2'] })], 'spark1', 'root')).toEqual([]);
  });

  it('keeps bar, label and totals on one denominator, and names the root reserve', () => {
    // Real spark1 root: df says 82% used; total includes 190.8 GiB reserved for root.
    const f = fsFigures({ total: 4031871553536, used: 3119868862464, free: 707161841664 });
    expect(f.pct).toBeCloseTo(81.5, 1);
    expect(f.usable).toBe(3119868862464 + 707161841664);
    expect(f.reserved / 1024 ** 3).toBeCloseTo(190.8, 1);
  });

  it('formats throughput and IOPS with stable units', () => {
    expect(bytesRateParts(512e6)).toEqual({ value: '512', unit: 'MB/s' });
    expect(bytesRateParts(2.05e9)).toEqual({ value: '2.05', unit: 'GB/s' });
    expect(bytesRateParts(999.9e6)).toEqual({ value: '1.00', unit: 'GB/s' });
    expect(bytesRateParts(2.05e9, 'MB/s')).toEqual({ value: '2050', unit: 'MB/s' });
    expect(bytesRateParts(42)).toEqual({ value: '42', unit: 'B/s' });
    expect(bytesRateParts(NaN).unit).toBe('');
    expect(iopsParts(842.4)).toEqual({ value: '842', unit: 'IOPS' });
    expect(iopsParts(12_400)).toEqual({ value: '12.4', unit: 'k IOPS' });
    expect(formatIops(12_400)).toBe('12.4k');
  });
});
