import { describe, expect, it } from 'vitest';
import { isInsideString, tokenIndexAt, tokenize, type Token } from '../src/expressions/lexer';

function kinds(expression: string): string[] {
  return tokenize(expression).map((token) => `${token.kind}:${token.text}`);
}

describe('tokenize', () => {
  it('splits variables, identifiers, dots and reserved words', () => {
    expect(kinds('$ship.name == this.sector.knownname and not $done')).toEqual([
      'variable:$ship',
      'dot:.',
      'identifier:name',
      'operator:==',
      'identifier:this',
      'dot:.',
      'identifier:sector',
      'dot:.',
      'identifier:knownname',
      'reserved:and',
      'reserved:not',
      'variable:$done',
    ]);
  });

  it('reads numbers with unit suffixes, hex and exponents', () => {
    const tokens = tokenize('10s 2.5km 0xCAFE 1.5e300LF 100 42Cr .5');
    expect(tokens.map((token) => [token.text, token.suffix])).toEqual([
      ['10s', 's'],
      ['2.5km', 'km'],
      ['0xCAFE', ''],
      ['1.5e300LF', 'LF'],
      ['100', ''],
      ['42Cr', 'Cr'],
      ['.5', ''],
    ]);
    expect(tokens.every((token) => token.kind === 'number')).toBe(true);
  });

  it('reads strings with escapes and an unterminated string to the end', () => {
    const tokens = tokenize("'it\\'s' + $x + 'open");
    expect(tokens.map((token) => `${token.kind}:${token.text}`)).toEqual(["string:'it\\'s'", 'operator:+', 'variable:$x', 'operator:+', "string:'open"]);
    expect(tokens[0].unterminated).toBe(false);
    expect(tokens[4].unterminated).toBe(true);
  });

  it('reads braces, brackets, parentheses, text references and format arguments', () => {
    expect(kinds("{1001, 5}.['%s'.[$a], $b.{$i}]")).toEqual([
      'lbrace:{',
      'number:1001',
      'comma:,',
      'number:5',
      'rbrace:}',
      'dot:.',
      'lbracket:[',
      "string:'%s'",
      'dot:.',
      'lbracket:[',
      'variable:$a',
      'rbracket:]',
      'comma:,',
      'variable:$b',
      'dot:.',
      'lbrace:{',
      'variable:$i',
      'rbrace:}',
      'rbracket:]',
    ]);
  });

  it('reads operators, @, ? and unknown characters', () => {
    expect(kinds('@$a.$b? != 3 <= 4 >= 5 < 6 > 7 ! ~')).toEqual([
      'at:@',
      'variable:$a',
      'dot:.',
      'variable:$b',
      'question:?',
      'operator:!=',
      'number:3',
      'operator:<=',
      'number:4',
      'operator:>=',
      'number:5',
      'operator:<',
      'number:6',
      'operator:>',
      'number:7',
      'operator:!',
      'unknown:~',
    ]);
  });

  it('records offsets', () => {
    const tokens = tokenize('  player.ship ');
    expect(tokens.map((token) => [token.start, token.end])).toEqual([
      [2, 8],
      [8, 9],
      [9, 13],
    ]);
    expect(tokenize('')).toEqual([]);
  });
});

describe('tokenIndexAt and isInsideString', () => {
  const expression = "$a + 'text' + $b";
  const tokens: Token[] = tokenize(expression);

  it('finds the token containing an offset', () => {
    expect(tokenIndexAt(tokens, 0)).toBe(0);
    expect(tokenIndexAt(tokens, 1)).toBe(0);
    expect(tokenIndexAt(tokens, 2)).toBe(-1);
    expect(tokenIndexAt(tokens, 6)).toBe(2);
    expect(tokenIndexAt(tokens, expression.length)).toBe(-1);
  });

  it('knows when a caret is inside a string', () => {
    const start = expression.indexOf("'");
    expect(isInsideString(tokens, start)).toBe(false);
    expect(isInsideString(tokens, start + 1)).toBe(true);
    expect(isInsideString(tokens, start + 5)).toBe(true);
    expect(isInsideString(tokens, start + 6)).toBe(false);
    const open = tokenize("'open");
    expect(isInsideString(open, 5)).toBe(true);
  });
});
