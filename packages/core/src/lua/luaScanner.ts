/**
 * A tolerant scanner of Lua source: names, numbers, strings and operators with their offsets, comments
 * left out. Not a parser: what the features need, calls and assignments, is found in the token stream.
 *
 * Tolerant as an editor needs it: a quoted string that is not closed ends at the line break, a long
 * string or long comment that is not closed at the end of the text, and each is reported.
 */

export type LuaTokenKind = 'name' | 'number' | 'string' | 'operator';

export interface LuaToken {
  kind: LuaTokenKind;
  start: number;
  end: number;
}

export interface LuaScan {
  tokens: LuaToken[];
  /** Strings and long comments that the text does not close, by where they start. */
  unclosed: { kind: 'string' | 'comment'; start: number }[];
}

/** Operators of two characters: `..` may grow to `...`. */
const pairs = new Set(['==', '~=', '<=', '>=', '..', '::', '//', '<<', '>>']);

function isNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isNamePart(code: number): boolean {
  return isNameStart(code) || isDigit(code);
}

/** The level of a long bracket opening at `offset` (`[[` 0, `[==[` 2), or -1 when there is none. */
function longBracketLevel(text: string, offset: number): number {
  let at = offset + 1;
  while (text.charCodeAt(at) === 61) {
    at++;
  }
  return text.charCodeAt(at) === 91 ? at - offset - 1 : -1;
}

/** The end of a long bracket of the level opening at `offset`, or -1 when the text does not close it. */
function longBracketEnd(text: string, offset: number, level: number): number {
  const close = `]${'='.repeat(level)}]`;
  const at = text.indexOf(close, offset + level + 2);
  return at === -1 ? -1 : at + close.length;
}

/** The end of a numeral starting at `offset`: decimal with a fraction and an exponent, or hexadecimal with a binary exponent. */
function numeralEnd(text: string, offset: number): number {
  const hex = text.charCodeAt(offset) === 48 && (text.charCodeAt(offset + 1) | 0x20) === 120;
  const exponent = hex ? 112 : 101;
  let at = offset + (hex ? 2 : 1);
  for (;;) {
    const code = text.charCodeAt(at);
    if (isNamePart(code) || code === 46) {
      at++;
    } else if ((code === 43 || code === 45) && (text.charCodeAt(at - 1) | 0x20) === exponent) {
      at++;
    } else {
      return at;
    }
  }
}

export function scanLua(text: string): LuaScan {
  const tokens: LuaToken[] = [];
  const unclosed: LuaScan['unclosed'] = [];
  const length = text.length;
  let at = 0;
  while (at < length) {
    const code = text.charCodeAt(at);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11) {
      at++;
      continue;
    }
    if (code === 45 && text.charCodeAt(at + 1) === 45) {
      const level = text.charCodeAt(at + 2) === 91 ? longBracketLevel(text, at + 2) : -1;
      if (level >= 0) {
        const end = longBracketEnd(text, at + 2, level);
        if (end === -1) {
          unclosed.push({ kind: 'comment', start: at });
        }
        at = end === -1 ? length : end;
      } else {
        const end = text.indexOf('\n', at);
        at = end === -1 ? length : end + 1;
      }
      continue;
    }
    const start = at;
    let kind: LuaTokenKind;
    const level = code === 91 ? longBracketLevel(text, at) : -1;
    if (level >= 0) {
      const end = longBracketEnd(text, at, level);
      if (end === -1) {
        unclosed.push({ kind: 'string', start });
      }
      at = end === -1 ? length : end;
      kind = 'string';
    } else if (code === 34 || code === 39) {
      at++;
      let closed = false;
      while (at < length) {
        const next = text.charCodeAt(at);
        if (next === code) {
          at++;
          closed = true;
          break;
        }
        if (next === 10 || next === 13) {
          break;
        }
        // An escape takes the character after it, a line break too (`\` before a line break continues the string).
        at += next === 92 ? 2 : 1;
      }
      if (!closed) {
        unclosed.push({ kind: 'string', start });
      }
      at = Math.min(at, length);
      kind = 'string';
    } else if (isNameStart(code)) {
      at++;
      while (at < length && isNamePart(text.charCodeAt(at))) {
        at++;
      }
      kind = 'name';
    } else if (isDigit(code) || (code === 46 && isDigit(text.charCodeAt(at + 1)))) {
      at = numeralEnd(text, at);
      kind = 'number';
    } else {
      at += pairs.has(text.slice(at, at + 2)) ? (text.startsWith('...', at) ? 3 : 2) : 1;
      kind = 'operator';
    }
    tokens.push({ kind, start, end: at });
  }
  return { tokens, unclosed };
}
