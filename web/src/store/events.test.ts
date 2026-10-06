import type { Event } from '../lib/types';
import { MAX_EVENTS, mergeEvent, mergeEvents, openAlertCount, openAlertLevel, useEvents } from './events';

const ev = (id: number, patch: Partial<Event> = {}): Event => ({
  id, ts: id, node_id: 'spark1', severity: 'warning', kind: 'alert', rule_id: null, title: `e${id}`, detail: '', metric: null, value: null, resolved_ts: null, acked: false, ...patch,
});

describe('events store', () => {
  beforeEach(() => { useEvents.setState({ events: [] }); });

  it('keeps at most MAX_EVENTS, newest first, and upserts by id', () => {
    for (let i = 1; i <= MAX_EVENTS + 50; i++) useEvents.getState().upsert(ev(i));
    const { events } = useEvents.getState();
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events[0]?.id).toBe(MAX_EVENTS + 50);
    useEvents.getState().upsert(ev(MAX_EVENTS + 50, { resolved_ts: 9999 }));
    expect(useEvents.getState().events).toHaveLength(MAX_EVENTS);
    expect(useEvents.getState().events[0]?.resolved_ts).toBe(9999);
  });

  it('counts open warning/critical alerts only', () => {
    expect(openAlertCount([ev(1), ev(2, { resolved_ts: 5 }), ev(3, { severity: 'info' }), ev(4, { kind: 'node' }), ev(5, { severity: 'critical' })])).toBe(2);
  });

  it('openAlertLevel is the worst open alert on that node only', () => {
    expect(openAlertLevel([], 'spark1')).toBeNull();
    expect(openAlertLevel([ev(1, { severity: 'info' }), ev(2, { resolved_ts: 5, severity: 'critical' })], 'spark1')).toBeNull();
    expect(openAlertLevel([ev(1), ev(2, { node_id: 'spark2', severity: 'critical' })], 'spark1')).toBe('warning');
    expect(openAlertLevel([ev(1), ev(2, { severity: 'critical' })], 'spark1')).toBe('critical');
    expect(openAlertLevel([ev(1, { kind: 'recovered', severity: 'critical' })], 'spark1')).toBeNull();
  });
});

describe('mergeEvents', () => {
  it('unions by id, newest first, and never moves acked/resolved backwards', () => {
    const streamed = [ev(3, { acked: true }), ev(2)];
    const fetched = [ev(2, { resolved_ts: 1_010 }), ev(3), ev(1)];
    const out = mergeEvents(streamed, fetched);
    expect(out.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(out[0]?.acked).toBe(true);
    expect(out[1]?.resolved_ts).toBe(1_010);
  });
  it('mergeEvent keeps the newer copy fields but monotonic flags', () => {
    expect(mergeEvent(ev(1, { acked: true, resolved_ts: 5 }), ev(1, { detail: 'new' }))).toMatchObject({ acked: true, resolved_ts: 5, detail: 'new' });
  });
});
