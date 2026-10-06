import {
  bitrateParts,
  bytesParts,
  DASH,
  energyCost,
  formatAgo,
  formatBitrate,
  formatBytes,
  formatClock,
  formatCost,
  formatDuration,
  formatEnergy,
  formatFreq,
  formatPercent,
  formatTemp,
  formatWatts,
  freqParts,
  text,
} from './format';

const NB = ' ';

describe('format', () => {
  it('bytes use IEC units with one decimal', () => {
    expect(formatBytes(0)).toBe(`0${NB}B`);
    expect(formatBytes(1023)).toBe(`1023${NB}B`);
    expect(formatBytes(1536)).toBe(`1.5${NB}KiB`);
    expect(formatBytes(121.7 * 1024 ** 3)).toBe(`121.7${NB}GiB`);
    expect(formatBytes(3.6 * 1024 ** 4)).toBe(`3.6${NB}TiB`);
    expect(bytesParts(96 * 1024 ** 3)).toEqual({ value: '96.0', unit: 'GiB' });
  });

  it('bytes can be held in a fixed unit (for animation across a boundary)', () => {
    expect(bytesParts(512 * 1024 ** 2, 'GiB')).toEqual({ value: '0.5', unit: 'GiB' });
  });

  it('network rates are bits/s (SI) from bytes/s, 3 significant figures', () => {
    expect(formatBitrate(573e6)).toBe(`4.58${NB}Gb/s`);
    expect(formatBitrate(3.125e9)).toBe(`25.0${NB}Gb/s`);
    expect(formatBitrate(1.25e9 * 18.9)).toBe(`189${NB}Gb/s`);
    expect(formatBitrate(100)).toBe(`800${NB}b/s`);
    expect(formatBitrate(0)).toBe(`0${NB}b/s`);
    expect(bitrateParts(124.95e6)).toEqual({ value: '1.00', unit: 'Gb/s' }); // 999.6 Mb/s rounds up a unit
  });

  it('temperature, watts, frequency, percent', () => {
    expect(formatTemp(71.4)).toBe(`71${NB}°C`);
    expect(formatWatts(32.44)).toBe(`32.4${NB}W`);
    expect(formatWatts(240.4)).toBe(`240${NB}W`);
    expect(formatFreq(850)).toBe(`850${NB}MHz`);
    expect(formatFreq(2171)).toBe(`2.17${NB}GHz`);
    expect(freqParts(900, 'GHz')).toEqual({ value: '0.90', unit: 'GHz' });
    expect(formatPercent(91.4)).toBe('91%');
    expect(formatPercent(91.44, 1)).toBe('91.4%');
  });

  it('energy and cost', () => {
    expect(formatEnergy(3.6e6)).toBe(`1.00${NB}kWh`);
    expect(formatEnergy(3.6e6 * 12.345)).toBe(`12.3${NB}kWh`);
    expect(formatCost(energyCost(3.6e6 * 10, 0.28))).toBe('£2.80');
    expect(formatCost(1.5, '€')).toBe('€1.50');
    expect(formatCost(-0.5)).toBe('−£0.50');
  });

  it('durations and relative time', () => {
    expect(formatDuration(45)).toBe(`45${NB}s`);
    expect(formatDuration(12 * 60)).toBe(`12${NB}min`);
    expect(formatDuration(3900)).toBe(`1${NB}h 05${NB}min`);
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe(`3${NB}d 4${NB}h`);
    expect(formatAgo(100, 101)).toBe('just now');
    expect(formatAgo(100, 112)).toBe(`12${NB}s ago`);
    expect(formatAgo(0, 4 * 60 + 5)).toBe(`4${NB}min ago`);
    expect(formatAgo(0, 2 * 3600)).toBe(`2${NB}h ago`);
    expect(formatAgo(0, 3 * 86400)).toBe(`3${NB}d ago`);
  });

  it('missing values render as an em dash, never 0', () => {
    for (const f of [formatBytes, formatBitrate, formatTemp, formatWatts, formatFreq, formatPercent, formatEnergy, formatCost, formatDuration])
      expect([f(null), f(undefined), f(Number.NaN)]).toEqual([DASH, DASH, DASH]);
    expect(formatAgo(null)).toBe(DASH);
    expect(text(bytesParts(Number.NaN))).toBe(DASH);
  });

  it('clock is 24 h with seconds', () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000)).toBe('03:04:05');
  });
});
