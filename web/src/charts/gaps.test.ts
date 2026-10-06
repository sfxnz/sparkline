import { insertGaps, medianStep } from './gaps';

describe('insertGaps', () => {
  it('leaves evenly spaced data alone', () => {
    const ts = [1, 2, 3, 4];
    const values = [[1, 2, 3, 4]];
    expect(insertGaps(ts, values)).toEqual({ ts, values });
  });

  it('puts one null in every series across an outage', () => {
    const out = insertGaps([1, 2, 3, 20, 21], [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1]]);
    expect(out.ts).toEqual([1, 2, 3, 11.5, 20, 21]);
    expect(out.values).toEqual([[1, 2, 3, null, 4, 5], [5, 4, 3, null, 2, 1]]);
  });

  it('uses the given step (e.g. the sample interval) over the median', () => {
    expect(insertGaps([0, 10, 20], [[1, 2, 3]], 1).ts).toEqual([0, 5, 10, 15, 20]);
    expect(insertGaps([0, 10, 20], [[1, 2, 3]], 10).ts).toEqual([0, 10, 20]);
  });

  it('handles empty and single-point input', () => {
    expect(insertGaps([], [[]])).toEqual({ ts: [], values: [[]] });
    expect(insertGaps([5], [[1]])).toEqual({ ts: [5], values: [[1]] });
    expect(medianStep([1, 2, 10])).toBe(8);
  });
});
