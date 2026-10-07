import { fuzzyFilter, fuzzyScore } from './fuzzy';

describe('fuzzy', () => {
  it('matches subsequences and rejects non-matches', () => {
    expect(fuzzyScore('ovw', 'Overview')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Overview')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('ranks word-start and prefix matches first', () => {
    const items = ['Group policy', 'spark1 › GPU', 'GPU'];
    expect(fuzzyFilter(items, 'gpu', (x) => x)).toEqual(['GPU', 'spark1 › GPU']);
    expect(fuzzyFilter(items, 'sp gpu', (x) => x)[0]).toBe('spark1 › GPU');
  });

  it('never matches loose letters scattered across unrelated words', () => {
    const theme = 'Switch to dark appearance appearance dark light mode toggle Actions';
    const wall = 'Enter wall mode fullscreen display tv Actions';
    expect(fuzzyScore('nccl', theme)).toBeNull();
    expect(fuzzyScore('swap', theme)).toBeNull();
    expect(fuzzyScore('fio', wall)).toBeNull();
    expect(fuzzyScore('temp', wall)).toBeNull();
    expect(fuzzyScore('temp', 'spark1 › Thermals & Power Nodes')).toBeNull();
    expect(fuzzyScore('temp', 'spark1 › GPU temperature temp thermal Metrics')).not.toBeNull();
    expect(fuzzyScore('sp2', 'spark2')).not.toBeNull();
  });

  it('ranks prefix and contiguous matches above letters-in-order', () => {
    expect(fuzzyFilter(['Overview', 'spark1 › Swap', 'Swap'], 'swap', (x) => x)).toEqual(['Swap', 'spark1 › Swap']);
    expect(fuzzyScore('mat', 'GPU matmul throughput') ?? 0).toBeGreaterThan(fuzzyScore('mt', 'GPU matmul throughput') ?? Infinity);
  });

  it('keeps input order when the query is empty', () => {
    expect(fuzzyFilter(['b', 'a'], '  ', (x) => x)).toEqual(['b', 'a']);
  });
});
