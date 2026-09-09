/** Ordered-letter search, like try: close letters and word starts rank higher.
 * Presentation only; matches never infer eligibility or choose an action.
 * Positions index Unicode characters, so highlighting preserves the original label.
 */
export function fuzzyMatch(query: string, label: string): {score: number; positions: number[]} | null {
  const text = Array.from(label), lower = text.map(c => c.toLowerCase());
  const letters = Array.from(query.trim()).filter(c => !/\s/u.test(c)).map(c => c.toLowerCase());
  if (!letters.length) return {score: 0, positions: []};
  const positions: number[] = [];
  let from = 0, score = 0;
  for (const letter of letters) {
    const at = lower.indexOf(letter, from);
    if (at < 0) return null;
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]!)) score += 8;
    if (positions.length) score += at === from ? 12 : -Math.min(12, at - from);
    positions.push(at); from = at + 1;
  }
  // A full or contiguous match outranks scattered letters, with stable ties
  // left in the caller's original order. No recency or gameplay-policy weighting.
  const needle = Array.from(query.trim()).map(c => c.toLowerCase());
  const substring = lower.findIndex((_, i) => needle.every((c, j) => lower[i + j] === c));
  if (substring === 0 && needle.length === text.length) score += 10000;
  else if (substring >= 0) {
    score += 1000 + (substring === 0 ? 100 : 0);
    return {score: score - text.length / 100, positions: needle.map((_, i) => substring + i)};
  }
  return {score: (score - positions[0]! / 10) * 10 / (text.length + 10), positions};
}
