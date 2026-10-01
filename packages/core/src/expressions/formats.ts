/**
 * The placeholders of a format, `'%s of %s'.[$a, $b]` or a text that is one, as the game's scripts write
 * them (9.00 and the mods): `%s` takes the next argument, with flags before the `s` (`%,s`, `%!s`); `%1`,
 * `%2`, … take the argument of that number, and letters after the digits are text (`%4s` is the fourth
 * argument and an `s` of seconds, `%3Cr` the third and `Cr`); `%%` is a percent sign. How the game counts
 * `%s` in a format that also numbers its placeholders is not known: there `%s` counts its own.
 */

/** A placeholder of a format: the argument it takes, counted from 0, and where it is written. */
export interface FormatPlaceholder {
  argument: number;
  start: number;
  end: number;
  numbered: boolean;
}

/** `%%`, `%<digits>`, or `%` with flags and an `s`; other letters after `%` take no argument. */
const placeholderPattern = /%(?:%|(\d+)|[^\sa-zA-Z\d%'"]*s)/g;

/** The placeholders of a format text, in order. */
export function formatPlaceholders(format: string): FormatPlaceholder[] {
  const placeholders: FormatPlaceholder[] = [];
  let sequential = 0;
  for (const match of format.matchAll(placeholderPattern)) {
    if (match[0] === '%%') {
      continue;
    }
    const numbered = match[1] !== undefined;
    const argument = numbered ? Number(match[1]) - 1 : sequential++;
    if (argument >= 0) {
      placeholders.push({ argument, start: match.index, end: match.index + match[0].length, numbered });
    }
  }
  return placeholders;
}

/** How many arguments a format takes; undefined when it mixes `%s` and numbered placeholders, whose count is not known. */
export function formatArgumentCount(placeholders: readonly FormatPlaceholder[]): number | undefined {
  if (placeholders.some((placeholder) => placeholder.numbered) && placeholders.some((placeholder) => !placeholder.numbered)) {
    return undefined;
  }
  return placeholders.reduce((most, placeholder) => Math.max(most, placeholder.argument + 1), 0);
}
