import type { Event } from '../../lib/types';
import { dayKey, filterEvents, groupByDay, linkRecoveries, NO_FILTERS, openAlerts } from './model';

const ev = (id: number, patch: Partial<Event> = {}): Event => ({
  id, ts: 1_000 + id, node_id: 'spark1', severity: 'warning', kind: 'alert', rule_id: 'r', title: `e${id}`, detail: '', metric: 'gpu0.temp_c', value: null, resolved_ts: null, acked: false, ...patch,
});

describe('openAlerts', () => {
  it('lists unresolved alerts only, worst first then newest', () => {
    const out = openAlerts([ev(1), ev(2, { severity: 'critical' }), ev(3), ev(4, { resolved_ts: 9 }), ev(5, { kind: 'recovered' })]);
    expect(out.map((e) => e.id)).toEqual([2, 3, 1]);
  });
});

describe('filterEvents', () => {
  it('filters by node, severity and kind together', () => {
    const list = [ev(1), ev(2, { node_id: 'spark2' }), ev(3, { severity: 'info', kind: 'recovered' })];
    expect(filterEvents(list, NO_FILTERS)).toHaveLength(3);
    expect(filterEvents(list, { ...NO_FILTERS, node: 'spark2' }).map((e) => e.id)).toEqual([2]);
    expect(filterEvents(list, { node: 'spark1', severity: 'info', kind: 'recovered' }).map((e) => e.id)).toEqual([3]);
    expect(filterEvents(list, { ...NO_FILTERS, kind: 'node' })).toEqual([]);
  });
});

describe('groupByDay', () => {
  it('groups by local day with Today / Yesterday labels', () => {
    const now = new Date(2026, 9, 6, 15, 0).getTime() / 1000;
    const today = new Date(2026, 9, 6, 9, 0).getTime() / 1000;
    const yesterday = new Date(2026, 9, 5, 23, 59).getTime() / 1000;
    const older = new Date(2026, 9, 1, 12, 0).getTime() / 1000;
    const groups = groupByDay([ev(4, { ts: today + 60 }), ev(3, { ts: today }), ev(2, { ts: yesterday }), ev(1, { ts: older })], now);
    expect(groups.map((g) => [g.label, g.events.length])).toEqual([['Today', 2], ['Yesterday', 1], [expect.stringMatching(/1/), 1]]);
    expect(groups[0]?.key).toBe(dayKey(today));
  });
});

describe('linkRecoveries', () => {
  it('pairs a recovery with the alert it cleared (same rule, node, metric, ts = resolved_ts)', () => {
    const alert = ev(1, { ts: 100, resolved_ts: 160 });
    const other = ev(2, { ts: 110, resolved_ts: 170, node_id: 'spark2' });
    const rec = ev(3, { ts: 160, kind: 'recovered', severity: 'info' });
    const rec2 = ev(4, { ts: 170, kind: 'recovered', severity: 'info', node_id: 'spark2' });
    const stray = ev(5, { ts: 300, kind: 'recovered', severity: 'info', rule_id: 'x' });
    const { recoveryOf, alertOf } = linkRecoveries([stray, rec2, rec, other, alert]);
    expect(recoveryOf.get(1)?.id).toBe(3);
    expect(alertOf.get(3)?.id).toBe(1);
    expect(recoveryOf.get(2)?.id).toBe(4);
    expect(alertOf.has(5)).toBe(false);
  });
});
