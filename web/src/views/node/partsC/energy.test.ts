import { powerStats } from './energy';

describe('powerStats', () => {
  it('averages present values and takes the peak from bucket maxima', () => {
    expect(powerStats([30, null, 40], [35, null, 52])).toEqual({ avg: 35, peak: 52 });
  });
  it('uses the values themselves for the peak without maxima', () => {
    expect(powerStats([30, 41, 40])).toEqual({ avg: 37, peak: 41 });
  });
  it('is null for no data', () => {
    expect(powerStats([null])).toEqual({ avg: null, peak: null });
  });
});
