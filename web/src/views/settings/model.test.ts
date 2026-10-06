import type { ConsoleSettings } from '../../lib/types';
import { apply, changed, costExample, toDraft, validate } from './model';

const s: ConsoleSettings = { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 };

describe('settings model', () => {
  it('accepts the defaults', () => {
    expect(validate(toDraft(s))).toEqual({});
  });
  it('mirrors the server rules (0 < stale < offline, 0 < regression < 100, currency 1-8)', () => {
    const d = toDraft(s);
    expect(validate({ ...d, energy_rate_per_kwh: '-1' }).energy_rate_per_kwh).toBeDefined();
    expect(validate({ ...d, energy_rate_per_kwh: 'x' }).energy_rate_per_kwh).toBeDefined();
    expect(validate({ ...d, currency: '' }).currency).toBeDefined();
    expect(validate({ ...d, currency: 'TOOLONGCUR' }).currency).toBeDefined();
    expect(validate({ ...d, stale_after_s: '40' }).offline_after_s).toBe('Must be longer than the stale delay.');
    expect(validate({ ...d, regression_pct: '100' }).regression_pct).toBeDefined();
    expect(validate({ ...d, regression_pct: '0' }).regression_pct).toBeDefined();
  });
  it('validates only the requested fields', () => {
    expect(validate({ ...toDraft(s), currency: '' }, ['regression_pct'])).toEqual({});
  });
  it('applies a section over the current settings and detects changes numerically', () => {
    const d = { ...toDraft(s), energy_rate_per_kwh: '0,31', currency: ' € ', regression_pct: '7' };
    expect(apply(s, d, ['energy_rate_per_kwh', 'currency'])).toEqual({ ...s, energy_rate_per_kwh: 0.31, currency: '€' });
    expect(changed(s, { ...toDraft(s), stale_after_s: '5.0' }, ['stale_after_s'])).toBe(false);
    expect(changed(s, d, ['regression_pct'])).toBe(true);
  });
  it('gives a sanity-check cost example', () => {
    expect(costExample('0.28', '£', 35)).toBe('At 35 W for 24 hours (0.84 kWh) the GPU rail costs about £0.24.');
    expect(costExample('abc', '£')).toBeNull();
  });
});
