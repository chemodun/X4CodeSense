/**
 * Tokenizer for the script expression language shared by AI scripts and Mission Director scripts.
 *
 * It never fails: unknown characters become `unknown` tokens and an unterminated string runs to the end.
 * Offsets are relative to the expression text, which is the decoded value of an attribute; use
 * `offsetInValue` to map them back into the document.
 */

export type TokenKind =
  | 'variable'
  | 'identifier'
  | 'reserved'
  | 'number'
  | 'string'
  | 'dot'
  | 'comma'
  | 'lbrace'
  | 'rbrace'
  | 'lbracket'
  | 'rbracket'
  | 'lparen'
  | 'rparen'
  | 'operator'
  | 'at'
  | 'question'
  | 'unknown';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  text: string;
  /** Unit suffix of a number token, such as `s`, `m` or `Cr`; empty when there is none. */
  suffix: string;
  /** True for a string token whose closing quote is missing. */
  unterminated: boolean;
}

/** Words that are operators or syntax, never keywords or property names. */
export const reservedWords: ReadonlySet<string> = new Set(['and', 'or', 'not', 'if', 'then', 'else', 'typeof', 'lt', 'le', 'gt', 'ge']);

const DOLLAR = 0x24;
const QUOTE = 0x27;
const BACKSLASH = 0x5c;
const DOT = 0x2e;
const UNDERSCORE = 0x5f;

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isIdentifierStart(code: number): boolean {
  return isLetter(code) || code === UNDERSCORE;
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || isDigit(code);
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

const singleCharacterTokens: Record<string, TokenKind> = {
  '.': 'dot',
  ',': 'comma',
  '{': 'lbrace',
  '}': 'rbrace',
  '[': 'lbracket',
  ']': 'rbracket',
  '(': 'lparen',
  ')': 'rparen',
  '@': 'at',
  '?': 'question',
  '+': 'operator',
  '-': 'operator',
  '*': 'operator',
  '/': 'operator',
  '%': 'operator',
  '^': 'operator',
  '=': 'operator',
  '<': 'operator',
  '>': 'operator',
  '!': 'operator',
};

const twoCharacterOperators: ReadonlySet<string> = new Set(['==', '!=', '<=', '>=']);

/** Splits an expression into tokens. */
export function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  const length = expression.length;
  let position = 0;

  const push = (kind: TokenKind, start: number, end: number, suffix = '', unterminated = false): void => {
    tokens.push({ kind, start, end, text: expression.slice(start, end), suffix, unterminated });
  };

  while (position < length) {
    const code = expression.charCodeAt(position);
    if (isWhitespace(code)) {
      position++;
      continue;
    }
    const start = position;
    if (code === DOLLAR) {
      position++;
      while (position < length && isIdentifierPart(expression.charCodeAt(position))) {
        position++;
      }
      push('variable', start, position);
      continue;
    }
    if (isIdentifierStart(code)) {
      while (position < length && isIdentifierPart(expression.charCodeAt(position))) {
        position++;
      }
      const text = expression.slice(start, position);
      push(reservedWords.has(text) ? 'reserved' : 'identifier', start, position);
      continue;
    }
    if (isDigit(code) || (code === DOT && isDigit(expression.charCodeAt(position + 1)))) {
      if (code === 0x30 && (expression.charCodeAt(position + 1) === 0x78 || expression.charCodeAt(position + 1) === 0x58)) {
        position += 2;
        while (position < length && isHexDigit(expression.charCodeAt(position))) {
          position++;
        }
      } else {
        while (position < length && isDigit(expression.charCodeAt(position))) {
          position++;
        }
        if (expression.charCodeAt(position) === DOT && isDigit(expression.charCodeAt(position + 1))) {
          position++;
          while (position < length && isDigit(expression.charCodeAt(position))) {
            position++;
          }
        }
        const exponent = expression.charCodeAt(position);
        if (exponent === 0x65 || exponent === 0x45) {
          let after = position + 1;
          const sign = expression.charCodeAt(after);
          if (sign === 0x2b || sign === 0x2d) {
            after++;
          }
          if (isDigit(expression.charCodeAt(after))) {
            position = after;
            while (position < length && isDigit(expression.charCodeAt(position))) {
              position++;
            }
          }
        }
      }
      const suffixStart = position;
      while (position < length && isLetter(expression.charCodeAt(position))) {
        position++;
      }
      push('number', start, position, expression.slice(suffixStart, position));
      continue;
    }
    if (code === QUOTE) {
      position++;
      let closed = false;
      while (position < length) {
        const current = expression.charCodeAt(position);
        if (current === BACKSLASH) {
          position += 2;
          continue;
        }
        position++;
        if (current === QUOTE) {
          closed = true;
          break;
        }
      }
      position = Math.min(position, length);
      push('string', start, position, '', !closed);
      continue;
    }
    const two = expression.slice(position, position + 2);
    if (twoCharacterOperators.has(two)) {
      position += 2;
      push('operator', start, position);
      continue;
    }
    const character = expression[position];
    position++;
    push(singleCharacterTokens[character] ?? 'unknown', start, position);
  }
  return tokens;
}

/** Index of the token that contains the offset (start <= offset < end), or -1. */
export function tokenIndexAt(tokens: readonly Token[], offset: number): number {
  let low = 0;
  let high = tokens.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const token = tokens[middle];
    if (offset < token.start) {
      high = middle - 1;
    } else if (offset >= token.end) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return -1;
}

/** True when a caret at the offset is inside a string literal (after its opening quote and before its closing quote). */
export function isInsideString(tokens: readonly Token[], offset: number): boolean {
  const index = tokenIndexAt(tokens, offset);
  if (index < 0) {
    // After the last token: still inside a string that was never closed.
    const last = tokens[tokens.length - 1];
    return last !== undefined && last.kind === 'string' && last.unterminated && offset >= last.end;
  }
  const token = tokens[index];
  return token.kind === 'string' && offset > token.start && (token.unterminated || offset < token.end);
}
