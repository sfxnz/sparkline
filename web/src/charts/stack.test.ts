import { runningTotals } from './stack';

describe('runningTotals', () => {
  it('accumulates layers bottom-up and carries gaps from below', () => {
    expect(runningTotals([[1, 2, null], [10, null, 5], [100, 100, 100]])).toEqual([
      [1, 2, null],
      [11, 2, 5],
      [111, 102, 105],
    ]);
  });
});
