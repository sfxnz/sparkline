import { sparkX } from './Sparkline';

describe('sparkX', () => {
  it('places live points by time in the fixed window, so 40 s of data fills only the last part of 3 min', () => {
    const d = { ts: [140, 160, 180], values: [1, 2, 3], from: 0, to: 180 };
    expect(sparkX(d, 0, 182)).toBeCloseTo(141);
    expect(sparkX(d, 2, 182)).toBeCloseTo(181);
  });
  it('spreads static data by index', () => {
    const d = { ts: [5, 6, 100], values: [1, 2, 3] };
    expect([0, 1, 2].map((i) => sparkX(d, i, 102))).toEqual([1, 51, 101]);
  });
});
