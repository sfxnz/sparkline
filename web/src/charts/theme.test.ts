import { axisLabels } from './theme';
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
