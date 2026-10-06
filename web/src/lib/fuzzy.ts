// Subsequence fuzzy match for the command palette. Higher score = better; null = no match.
// Rewards matches at word starts and consecutive runs, so "gpu" ranks "GPU" above "Group policy".

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    const wordStart = at === 0 || /[\s\-_/›.]/.test(t[at - 1] ?? '');
    score += 1 + (wordStart ? 3 : 0) + (at === prev + 1 ? 2 : 0) - Math.min(at - ti, 5) * 0.1;
    prev = at;
    ti = at + 1;
  }
  if (t.startsWith(q)) score += 4;
  return score;
}

/** Filter and rank items by the best score over their searchable strings, keeping input order for ties. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (!query.trim()) return [...items];
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}
