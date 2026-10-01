/** Known names close in spelling to a written one, for the quick fixes that change a name. */

const maximumSuggestions = 3;

/** A known name and how far its spelling is from the written one. */
export interface SpellingSuggestion {
  name: string;
  distance: number;
}

/**
 * Optimal string alignment distance: inserting or removing a character and swapping two neighbours cost
 * one, changing a character one and a half, changing only the case a tenth. Infinity once it must exceed
 * the limit.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) {
    return Infinity;
  }
  let beforePrevious = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let smallest = i;
    for (let j = 1; j <= b.length; j++) {
      const x = a[i - 1];
      const y = b[j - 1];
      const change = x === y ? 0 : x.toLowerCase() === y.toLowerCase() ? 0.1 : 1.5;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + change);
      if (i > 1 && j > 1 && x !== y && x === b[j - 2] && a[i - 2] === y) {
        value = Math.min(value, beforePrevious[j - 2] + 1);
      }
      current[j] = value;
      smallest = Math.min(smallest, value);
    }
    if (smallest > limit) {
      return Infinity;
    }
    [beforePrevious, previous, current] = [previous, current, beforePrevious];
  }
  return previous[b.length];
}

/**
 * How far a known name may be from the written one: changes of case always; from three characters one
 * change, from six two missing or extra ones, from ten three. The `$` of a variable does not count.
 */
function allowedDistance(written: string): number {
  const length = written.replace(/^\$/, '').length;
  return length < 3 ? 0.5 : length < 6 ? 1.5 : length < 10 ? 2 : 3;
}

/** The known names closest in spelling to the written one, closest first, at most three. */
export function spellingSuggestions(written: string, known: Iterable<string>): SpellingSuggestion[] {
  const limit = allowedDistance(written);
  const found: SpellingSuggestion[] = [];
  const seen = new Set<string>();
  for (const name of known) {
    if (name === written || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const distance = editDistance(written, name, limit);
    if (distance <= limit) {
      found.push({ name, distance });
    }
  }
  found.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return found.slice(0, maximumSuggestions);
}
