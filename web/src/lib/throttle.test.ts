import { decodeThrottle, THROTTLE_REASONS, worstSeverity } from './throttle';

describe('decodeThrottle', () => {
  it('matches the canonical table exactly', () => {
    expect(THROTTLE_REASONS.map((r) => [r.bit, r.code, r.title, r.severity])).toEqual([
      [0x1, 'gpu_idle', 'Idle', 'info'],
      [0x2, 'app_clocks', 'Application clock limit', 'info'],
      [0x4, 'sw_power_cap', 'Power cap', 'info'],
      [0x8, 'hw_slowdown', 'Hardware slowdown', 'critical'],
      [0x10, 'sync_boost', 'Sync boost', 'info'],
      [0x20, 'sw_thermal', 'Thermal limit', 'warning'],
      [0x40, 'hw_thermal', 'Overheating', 'critical'],
      [0x80, 'hw_power_brake', 'Power brake', 'critical'],
      [0x100, 'display_clocks', 'Display clock setting', 'info'],
    ]);
    expect(THROTTLE_REASONS[2]?.explanation).toBe('Holding clocks down to stay within the power budget. Normal under sustained heavy load.');
    expect(THROTTLE_REASONS[6]?.explanation).toBe('The GPU is too hot; hardware cut clocks sharply to protect itself.');
  });

  it('returns nothing for 0, null and invalid masks', () => {
    expect(decodeThrottle(0)).toEqual([]);
    expect(decodeThrottle(null)).toEqual([]);
    expect(decodeThrottle(undefined)).toEqual([]);
    expect(decodeThrottle(Number.NaN)).toEqual([]);
    expect(decodeThrottle(-1)).toEqual([]);
  });

  it('decodes combined bits lowest first', () => {
    expect(decodeThrottle(0x4 | 0x20 | 0x40).map((r) => r.code)).toEqual(['sw_power_cap', 'sw_thermal', 'hw_thermal']);
    expect(decodeThrottle(0x1ff)).toHaveLength(9);
  });

  it('reports unknown bits as warnings instead of dropping them', () => {
    const r = decodeThrottle(0x4 | 0x400);
    expect(r.map((x) => x.code)).toEqual(['sw_power_cap', 'unknown_0x400']);
    expect(r[1]).toMatchObject({ bit: 0x400, title: 'Unknown reason (bit 0x400)', severity: 'warning', explanation: 'The driver reported a clock-event reason this console does not recognise.' });
  });

  it('handles bits above 2^31 exactly', () => {
    expect(decodeThrottle(2 ** 40).map((x) => x.code)).toEqual([`unknown_0x${(2 ** 40).toString(16)}`]);
  });
});

describe('worstSeverity', () => {
  it('ranks critical > warning > info', () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity(decodeThrottle(0x4))).toBe('info');
    expect(worstSeverity(decodeThrottle(0x4 | 0x20))).toBe('warning');
    expect(worstSeverity(decodeThrottle(0x20 | 0x8 | 0x1))).toBe('critical');
  });
});
