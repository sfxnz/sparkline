import { LiveStore } from '../../store/live';
import { lastKnown, lastKnownValue, notLive, spanPhrase } from './live';

describe('notLive', () => {
  it('is true for stale/offline/error nodes and whenever the console is lost', () => {
    expect(notLive('online', true)).toBe(false);
    expect(notLive('connecting', true)).toBe(false);
    expect(notLive('stale', true)).toBe(true);
    expect(notLive('offline', true)).toBe(true);
    expect(notLive('error', true)).toBe(true);
    expect(notLive('online', false)).toBe(true);
  });
});

describe('lastKnown', () => {
  it('returns the newest value of a key even after it stops being reported', () => {
    const store = new LiveStore(16, () => undefined);
    store.seed({ node_id: 'n', resolution_s: 1, ts: [1, 2, 3, 4], series: { 'disk.x.busy_pct': [10, 12, null, null], other: [1, 1, 1, 1] }, min: {}, max: {} });
    expect(lastKnown(store, 'n', 'disk.x.busy_pct')).toEqual({ value: 12, ts: 2 });
    expect(lastKnown(store, 'n', 'disk.x.busy_pct', 2)).toBeNull(); // only looks this far back
    expect(lastKnown(store, 'n', 'missing')).toBeNull();
    expect(lastKnown(store, 'nope', 'disk.x.busy_pct')).toBeNull();
  });

  it('lastKnownValue looks back past trailing gaps and sums several keys', () => {
    const store = new LiveStore(16, () => undefined);
    store.seed({ node_id: 'n', resolution_s: 1, ts: [1, 2, 3, 4], series: { 'net.a.rx_bps': [10, 20, null, null], 'net.b.rx_bps': [1, 2, 3, null] }, min: {}, max: {} });
    expect(lastKnownValue('n', 'net.a.rx_bps', store)).toBe(20);
    expect(lastKnownValue('n', ['net.a.rx_bps', 'net.b.rx_bps'], store)).toBe(23);
    expect(lastKnownValue('n', ['net.a.rx_bps', 'missing'], store)).toBeNull();
    expect(lastKnownValue('nope', 'net.a.rx_bps', store)).toBeNull();
  });
});

describe('spanPhrase', () => {
  const now = 1_800_000_000;
  it('uses the range wording when the data covers the range', () => {
    expect(spanPhrase('live', now - 900, now)).toBe('last 15 min');
    expect(spanPhrase('5m', now - 290, now)).toBe('last 5 min');
    expect(spanPhrase('1h', null, now)).toBe('last hour');
  });
  it('says the real span when the data is shorter (a console or agent that just started)', () => {
    expect(spanPhrase('live', now - 155, now)).toBe('last 3 min');
    expect(spanPhrase('5m', now - 88, now)).toBe('last 1 min');
    expect(spanPhrase('24h', now - 2 * 3600, now)).toMatch(/^since \d\d:\d\d$/);
  });
});
