import type { Event, NetIfInfo } from '../../lib/types';
import { cx7Throughput, gbpsParts, interconnectNames, tickerAlerts, wallColumns } from './model';

describe('wall model', () => {
  it('lays tiles out in balanced rows', () => {
    expect([1, 2, 3, 4, 5, 6, 9, 10].map(wallColumns)).toEqual([1, 2, 3, 2, 3, 3, 3, 4]);
    expect(wallColumns(0)).toBe(1);
  });

  it('sums rx+tx over cabled interconnect rails only', () => {
    const net = [
      { name: 'a', role: 'interconnect', peer: 'spark2' },
      { name: 'b', role: 'interconnect', peer: 'spark2' },
      { name: 'spare', role: 'interconnect', peer: null },
      { name: 'lan', role: 'lan' },
      { name: 'docker0', role: 'virtual' },
    ] as NetIfInfo[];
    const names = interconnectNames(net);
    expect(names).toEqual(['a', 'b']);
    const vals: Record<string, number> = { 'net.a.rx_bps': 10, 'net.a.tx_bps': 5, 'net.b.rx_bps': 1, 'net.lan.rx_bps': 1000 };
    expect(cx7Throughput((k) => vals[k] ?? null, names)).toBe(16);
    expect(cx7Throughput(() => null, names)).toBeNull();
    expect(cx7Throughput(() => 1, [])).toBeNull();
  });

  it('ticker shows open warning/critical alerts, worst first', () => {
    const e = (id: number, p: Partial<Event>): Event => ({ id, ts: id, node_id: 'spark1', severity: 'warning', kind: 'alert', rule_id: null, title: '', detail: '', metric: null, value: null, resolved_ts: null, acked: false, ...p });
    expect(tickerAlerts([e(1, {}), e(2, { severity: 'info' }), e(3, { severity: 'critical' }), e(4, { resolved_ts: 9 })]).map((x) => x.id)).toEqual([3, 1]);
  });
});

describe('gbpsParts', () => {
  it('keeps Gb/s, and never shows a carrying link as 0.00', () => {
    expect(gbpsParts(2.5e9 / 8)).toEqual({ value: '2.50', unit: 'Gb/s' });
    expect(gbpsParts(29e3)).toEqual({ value: '<0.01', unit: 'Gb/s' }); // 29 KB/s of control traffic
    expect(gbpsParts(0)).toEqual({ value: '0.00', unit: 'Gb/s' });
  });
});
