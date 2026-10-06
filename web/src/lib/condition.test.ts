import { liveCondition } from './condition';

describe('liveCondition', () => {
  it('is null for a calm GPU and when nothing is known', () => {
    expect(liveCondition({ temp_c: 60, throttle_mask: 0 }, 86)).toBeNull();
    expect(liveCondition(null, 86)).toBeNull();
    expect(liveCondition({ temp_c: null, throttle_mask: null }, null)).toBeNull();
  });

  it('flags the slowdown temperature as critical, and closing in on it as a warning', () => {
    expect(liveCondition({ temp_c: 86, throttle_mask: 0 }, 86)).toEqual({ level: 'critical', text: 'is at its GPU slowdown temperature' });
    expect(liveCondition({ temp_c: 81, throttle_mask: 0 }, 86)).toEqual({ level: 'warning', text: 'is heating up' });
    expect(liveCondition({ temp_c: 79, throttle_mask: 0 }, 86)).toBeNull();
  });

  it('raises on hardware and thermal clock limits, never on idle or the power cap', () => {
    expect(liveCondition({ temp_c: 70, throttle_mask: 0x1 | 0x4 }, 86)).toBeNull();
    expect(liveCondition({ temp_c: 70, throttle_mask: 0x20 }, 86)).toEqual({ level: 'warning', text: 'has GPU clocks limited by thermal limit' });
    expect(liveCondition({ temp_c: 70, throttle_mask: 0x24 | 0x40 }, 86)).toEqual({ level: 'critical', text: 'has GPU clocks limited by overheating' });
  });
});
