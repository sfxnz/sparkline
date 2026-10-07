import { axisLabels, heatColor, heatLut } from './theme';
import { formatBitrate, formatBytes, formatWatts } from '../lib/format';

describe('axisLabels', () => {
  it('drops a trailing .0 when every tick is whole, with one unit throughout', () => {
    expect(axisLabels([0, 20, 40], formatWatts)).toEqual(['0\u00a0W', '20\u00a0W', '40\u00a0W']);
    expect(axisLabels([0, 32, 64, 96].map((g) => g * 1024 ** 3), formatBytes)).toEqual(['0\u00a0GiB', '32\u00a0GiB', '64\u00a0GiB', '96\u00a0GiB']);
    expect(axisLabels([0, 40e9, 80e9, 120e9, 160e9].map((b) => b / 8), formatBitrate)).toEqual(['0\u00a0Gb/s', '40\u00a0Gb/s', '80\u00a0Gb/s', '120\u00a0Gb/s', '160\u00a0Gb/s']);
  });

  it('keeps the same decimals on every tick when one needs them', () => {
    const ghz = (mhz: number) => `${(mhz / 1000).toFixed(2)}\u00a0GHz`;
    expect(axisLabels([0, 250, 500, 750, 1000], ghz)).toEqual(['0\u00a0GHz', '0.25\u00a0GHz', '0.50\u00a0GHz', '0.75\u00a0GHz', '1.00\u00a0GHz']);
    expect(axisLabels([4e6, 8e6, 12e6].map((b) => b / 8), formatBitrate)).toEqual(['4\u00a0Mb/s', '8\u00a0Mb/s', '12\u00a0Mb/s']);
  });

  it('leaves ticks that span units, or do not parse, as the formatter wrote them, and blanks repeats', () => {
    expect(axisLabels([0, 600e6 / 8, 1.2e9 / 8], formatBitrate)).toEqual(['0\u00a0b/s', '600\u00a0Mb/s', '1.20\u00a0Gb/s']);
    expect(axisLabels([69.6, 70.1, 70.4], (n) => `${n.toFixed(0)} °C`)).toEqual(['70 °C', '', '']);
    expect(axisLabels([1, 2], (n) => (n > 1 ? 'high' : 'low'))).toEqual(['low', 'high']);
  });
});

describe('heatColor', () => {
  const stops = ['#000000', '#333333', '#666666', '#999999', '#ffffff'];
  it('hits the stops exactly and interpolates between them', () => {
    expect(heatColor(stops, 0)).toBe('rgb(0, 0, 0)');
    expect(heatColor(stops, 0.2)).toBe('rgb(51, 51, 51)');
    expect(heatColor(stops, 1)).toBe('rgb(255, 255, 255)');
    expect(heatColor(stops, 0.1)).toBe('rgb(26, 26, 26)');
  });
  it('clamps out-of-range and non-finite values', () => {
    expect(heatColor(stops, -1)).toBe('rgb(0, 0, 0)');
    expect(heatColor(stops, 2)).toBe('rgb(255, 255, 255)');
    expect(heatColor(stops, Number.NaN)).toBe('rgb(0, 0, 0)');
  });
});

describe('heatLut', () => {
  it('holds heatColor at every whole percent and is computed once per palette', () => {
    const stops = ['#000000', '#333333', '#666666', '#999999', '#ffffff'];
    const lut = heatLut(stops);
    expect(lut).toHaveLength(101);
    expect(lut[20]).toBe(heatColor(stops, 0.2));
    expect(lut[100]).toBe('rgb(255, 255, 255)');
    expect(heatLut(stops)).toBe(lut);
  });
});
