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

  it('keeps input order when the query is empty', () => {
    expect(fuzzyFilter(['b', 'a'], '  ', (x) => x)).toEqual(['b', 'a']);
  });
});
