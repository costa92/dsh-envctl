// Edits between two names, a swap of neighbouring letters ('wbe' for 'web') counting as one.
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// Candidates a mistyped name was probably meant to be, closest first.
export function closeMatches(name: string, candidates: Iterable<string>): string[] {
  const lower = name.toLowerCase();
  const scored: Array<{ candidate: string; distance: number }> = [];
  for (const candidate of new Set(candidates)) {
    const other = candidate.toLowerCase();
    const distance = editDistance(lower, other);
    const limit = Math.max(1, Math.floor(Math.max(lower.length, other.length) / 3));
    if (distance <= limit || (lower.length >= 3 && (other.includes(lower) || lower.includes(other)))) {
      scored.push({ candidate, distance });
    }
  }
  return scored.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate)).map((entry) => entry.candidate);
}

// "; did you mean 'web'?" when something is close, else "".
export function didYouMean(name: string, candidates: Iterable<string>): string {
  const matches = closeMatches(name, candidates).slice(0, 3);
  return matches.length > 0 ? `; did you mean ${matches.map((match) => `'${match}'`).join(' or ')}?` : '';
}
