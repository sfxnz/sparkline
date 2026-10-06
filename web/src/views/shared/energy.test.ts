import { counterDelta, counterIncrease, extendCounter, formatEnergyAuto, formatEnergyCost, historyEnergy, historyPlusLive, startOfDay } from './energy';

describe('counterDelta', () => {
  it('is last minus first for a monotonic counter', () => {
    expect(counterDelta([1000, 1500, 2600])).toBe(1600);
  });

  it('counts the reading after a reset as energy since the reset', () => {
    // 1000 -> 1500 (+500), reset to 0 then climbed to 200 (+200), -> 700 (+500)
    expect(counterDelta([1000, 1500, 200, 700])).toBe(1200);
  });

  it('handles several resets and a reset to exactly zero', () => {
    expect(counterDelta([50, 80, 0, 30, 10, 40])).toBe(30 + 0 + 30 + 10 + 30);
  });

  it('skips gaps and non-finite readings without breaking the chain', () => {
    expect(counterDelta([100, null, undefined, Number.NaN, 400])).toBe(300);
  });

  it('returns null without at least two readings', () => {
    expect(counterDelta([])).toBeNull();
    expect(counterDelta([null, 5, null])).toBeNull();
  });
});

describe('historyEnergy', () => {
  it('includes the first bucket using its minimum', () => {
    expect(historyEnergy([1100, 1300, 1600], [1000, 1150, 1350])).toBe(600);
  });

  it('starts at the first non-null bucket', () => {
    expect(historyEnergy([null, 1100, 1300], [null, 1000, 1150])).toBe(300);
  });

  it('falls back to bucket values when minima are missing, and handles a reset in range', () => {
    expect(historyEnergy([1100, 1300, 100])).toBe(300);
  });

  it('is null for empty history', () => {
    expect(historyEnergy(undefined)).toBeNull();
    expect(historyEnergy([])).toBeNull();
  });
});


const sp = (s: string) => s.replace(/\u00a0/g, ' ');

describe('formatting', () => {
  it('shows Wh below 1 kWh and kWh above', () => {
    expect(sp(formatEnergyAuto(5760))).toBe('1.60 Wh'); // 32 W for 3 min
    expect(sp(formatEnergyAuto(0.42 * 3.6e6))).toBe('420 Wh');
    expect(sp(formatEnergyAuto(5.376 * 3.6e6))).toBe('5.38 kWh');
    expect(sp(formatEnergyAuto(null))).toBe('—');
  });

  it('prices energy at the configured rate and never shows a misleading £0.00', () => {
    expect(sp(formatEnergyCost(3.6e6 * 10, 0.28, '£'))).toBe('£2.80');
    expect(sp(formatEnergyCost(5760, 0.28, '£'))).toBe('< £0.01');
    expect(sp(formatEnergyCost(0, 0.28, '€'))).toBe('€0.00');
    expect(sp(formatEnergyCost(null, 0.28, '£'))).toBe('—');
  });

  it('finds local midnight', () => {
    const now = new Date(2026, 9, 6, 14, 30, 5).getTime() / 1000;
    expect(startOfDay(now)).toBe(new Date(2026, 9, 6).getTime() / 1000);
  });
});

describe('counterIncrease', () => {
  it('sums increases and skips gaps', () => {
    expect(counterIncrease([100, null, 150, 175])).toEqual({ joules: 75, first: 100, last: 175, steps: 2 });
  });

  it('counts from zero after a counter reset', () => {
    // 100 -> 200 (+100), reset, 30 (+30), 80 (+50)
    expect(counterIncrease([100, 200, 30, 80]).joules).toBe(180);
  });

  it('is zero with fewer than two readings', () => {
    expect(counterIncrease([]).joules).toBe(0);
    expect(counterIncrease([5])).toMatchObject({ joules: 0, steps: 0 });
  });
});

describe('extendCounter', () => {
  it('extends a history total with newer live readings', () => {
    expect(extendCounter(100, [110, 130])).toBe(30); // seam +10, then +20
    expect(extendCounter(100, [130, 20, 50])).toBe(30 + 20 + 30); // restart within the live readings
    expect(extendCounter(100, [40, 60])).toBe(0); // readings below the last history value precede it: already counted
    expect(extendCounter(100, [90, 100, 120, 150])).toBe(50); // overlap with the last bucket is not counted twice
    expect(extendCounter(null, [40, 60])).toBe(20);
    expect(extendCounter(100, [])).toBe(0);
  });
});

describe('historyPlusLive', () => {
  const resp = { ts: [100, 110, 120], resolution_s: 10, series: { e: [1100, 1300, 1600] }, min: { e: [1000, 1150, 1350] } };
  it('adds live readings after the last bucket, including the seam', () => {
    const after: number[] = [];
    const total = historyPlusLive(resp, 'e', (t) => { after.push(t); return [1650, 1700]; });
    expect(after).toEqual([110]); // from the start of the last bucket: the overlap is skipped by value
    expect(total).toBe(600 + 50 + 50);
  });
  it('is the history total when there are no live readings, and null without history', () => {
    expect(historyPlusLive(resp, 'e', () => [])).toBe(600);
    expect(historyPlusLive({ ...resp, series: { e: [null, null, null] } }, 'e', () => [5, 6])).toBeNull();
  });
});
