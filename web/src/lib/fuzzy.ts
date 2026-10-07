// Word-based fuzzy match for the command palette. Higher score = better; null = no match.
// Every query word must match one word of the text: as its prefix (best), inside it (3+ letters), or as letters in
// order starting at its first letter ("sp2" -> "spark2", "ovw" -> "overview"). Loose subsequences that hop across
// words never match, so "nccl" cannot match "Switch to dark appearance". Earlier words (the label) beat later ones
// (keywords, group), and a text that starts with the whole query ranks first.

const WORD_SPLIT = /[\s\-_/›.&,()·]+/;

/** `token`'s letters appear in `word` in order, starting at its first letter. */
function anchoredSubsequence(token: string, word: string): boolean {
  if (word[0] !== token[0]) return false;
  let at = 0;
  for (const ch of token) {
    at = word.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const words = t.split(WORD_SPLIT).filter(Boolean);
  let score = 0;
  for (const token of q.split(WORD_SPLIT).filter(Boolean)) {
    let best = -1;
    words.forEach((w, i) => {
      const s = w.startsWith(token) ? (w === token ? 12 : 10) : token.length >= 3 && w.includes(token) ? 5 : anchoredSubsequence(token, w) ? 3 : 0;
      if (s) best = Math.max(best, s - Math.min(i, 10) * 0.1);
    });
    if (best < 0) return null;
    score += best;
  }
  if (t.startsWith(q)) score += 4;
  return score;
}

/** Filter and rank items by score, keeping input order for ties. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (!query.trim()) return [...items];
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}
