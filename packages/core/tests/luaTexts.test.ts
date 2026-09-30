import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { describeText, loadTexts, readTextCallAt, readTextCalls, readTextHover, scanLua, type ReadTextArgument } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const texts = loadTexts(unpacked);

const kindLetters = { name: 'n', number: 'd', string: 's', operator: 'o' } as const;

/** The tokens of a text as `n:name`, `d:number`, `s:string`, `o:operator`. */
function tokensOf(text: string): string[] {
  return scanLua(text).tokens.map((token) => `${kindLetters[token.kind]}:${text.slice(token.start, token.end)}`);
}

/** An argument as its value (`1001`, `1001<PAGE` when it comes from a name) or `?reason`. */
function shown(argument: ReadTextArgument): string {
  if (argument.value === undefined) {
    return `?${argument.reason}`;
  }
  return argument.constant ? `${argument.value}<${argument.constant.name}` : String(argument.value);
}

/** Each call of a text as `page id`, and `(cut off)` when it has no `)`. */
function callsOf(text: string): string[] {
  return readTextCalls(text).map((call) => `${shown(call.page)} ${shown(call.id)}${call.closed ? '' : ' (cut off)'}`);
}

function hoverText(text: string, offset: number, language?: string): { value: string; range: string } | undefined {
  const document = TextDocument.create('file:///mod/ui/menu.lua', 'lua', 1, text);
  const hover = readTextHover(document, readTextCalls(text), offset, texts, language ? { language } : {});
  if (!hover) {
    return undefined;
  }
  const range = hover.range!;
  const value = typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
  return { value, range: `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}` };
}

describe('the Lua scanner', () => {
  it('reads names, numbers, strings and operators, and leaves comments out', () => {
    const text = [
      `local s = "a\\"b" .. 'c' -- ReadText(1, 2)`,
      'x = [[long',
      'ReadText(3, 4)]] --[==[ block',
      ']] still ]==] y = 0x1F + 1.5e-3 + 0x1p+4 - 0x1e+5 ... a ~= b',
    ].join('\n');
    expect(tokensOf(text)).toEqual([
      'n:local',
      'n:s',
      'o:=',
      's:"a\\"b"',
      'o:..',
      "s:'c'",
      'n:x',
      'o:=',
      's:[[long\nReadText(3, 4)]]',
      'n:y',
      'o:=',
      'd:0x1F',
      'o:+',
      'd:1.5e-3',
      'o:+',
      'd:0x1p+4',
      'o:-',
      'd:0x1e',
      'o:+',
      'd:5',
      'o:...',
      'n:a',
      'o:~=',
      'n:b',
    ]);
    expect(scanLua(text).unclosed).toEqual([]);
  });

  it('ends an unclosed string at the line break, and an unclosed long string or comment at the end', () => {
    const text = 'x = "abc\ny = [=[ never ]]';
    expect(tokensOf(text)).toEqual(['n:x', 'o:=', 's:"abc', 'n:y', 'o:=', 's:[=[ never ]]']);
    expect(scanLua(text).unclosed).toEqual([
      { kind: 'string', start: 4 },
      { kind: 'string', start: 13 },
    ]);
    expect(tokensOf('a = 1 --[[ open')).toEqual(['n:a', 'o:=', 'd:1']);
    expect(scanLua('a = 1 --[[ open').unclosed).toEqual([{ kind: 'comment', start: 6 }]);
    // A backslash before a line break continues the string.
    expect(tokensOf('s = "a\\\nb" t')).toEqual(['n:s', 'o:=', 's:"a\\\nb"', 'n:t']);
  });
});

describe('ReadText calls', () => {
  it('finds the calls, not methods and not the definition, and resolves page constants', () => {
    const text = [
      'local PAGE_ID = 1972092427',
      'local a, b = 1001, 2',
      'local text = ReadText(PAGE_ID, 4011) .. ReadText(1001, 0x10)',
      'menu.ReadText(1, 2); menu:ReadText(1, 2)',
      'print(ReadText(a, ReadText(b, 3)))',
      '-- ReadText(5, 6)',
      'print("ReadText(7, 8)")',
    ].join('\n');
    expect(callsOf(text)).toEqual(['1972092427<PAGE_ID 4011', '1001 16', '1001<a ?an expression', '2<b 3']);
    expect(callsOf('function ReadText(page, id) return page end')).toEqual([]);
  });

  it('tells why an argument is not known', () => {
    const text = [
      'local PAGE = 100',
      'local twice = 1',
      'twice = 2',
      'local same = 5',
      'same = 5',
      'local label = "x"',
      'local half = 1.5',
      'config = { field = 7 }',
      'field2 = config.field',
      'for i = 1, 3 do ReadText(PAGE, i) end',
      'local function show(id) return ReadText(PAGE, id) end',
      'ReadText(twice, same)',
      'ReadText(label, half)',
      'ReadText(config.field, PAGE + 1)',
      'ReadText(unknown, field)',
      'ReadText(1001, 2.5)',
      'ReadText(PAGE)',
      'ReadText()',
    ].join('\n');
    expect(callsOf(text)).toEqual([
      '100<PAGE ?a loop variable',
      '100<PAGE ?a parameter of a function',
      '?set to different values in this file 5<same',
      '?set to something other than a whole number ?set to something other than a whole number',
      '?a field of a table, which is not followed ?an expression',
      // `field` is only a field of a table constructor, no assignment of the name.
      '?not set in this file ?not set in this file',
      '1001 ?not a whole number',
      '100<PAGE ?missing',
      '?missing ?missing',
    ]);
  });

  it('reads assignments in a function body passed as an argument, and after a bracket left open', () => {
    const text = ['Helper.onClick(button, function()', '  local SUB_PAGE = 1001', '  return ReadText(SUB_PAGE, 2)', 'end)'].join('\n');
    expect(callsOf(text)).toEqual(['1001<SUB_PAGE 2']);
    expect(callsOf(['print(ReadText(1001,', 'local PAGE = 1001', 'x = ReadText(PAGE, 1)'].join('\n'))).toEqual(['1001 ?missing (cut off)', '1001<PAGE 1']);
  });

  it('hovers over the argument list with the text, and where a constant is set', () => {
    const text = ['local PAGE_ID = 1001', 'local label = ReadText(PAGE_ID, 1)', ''].join('\n');
    const open = text.indexOf('(');
    const close = text.indexOf(')');
    const expected = `${describeText(texts, 1001, 1)}\n\nThe page \`PAGE_ID\` is 1001, set on line 1.`;
    for (const offset of [open, open + 3, close]) {
      expect(hoverText(text, offset)).toEqual({ value: expected, range: '1:22-1:34' });
    }
    expect(hoverText(text, text.indexOf('ReadText'))).toBeUndefined();
    expect(hoverText(text, close + 1)).toBeUndefined();
    expect(hoverText(text, open, '49')?.value.startsWith(describeText(texts, 1001, 1, { language: '49' }))).toBe(true);
    expect(hoverText(text, open)?.value).toContain('Hull');
  });

  it('says in the hover which argument is not known, and why', () => {
    const text = 'local PAGE_ID = 1001\nfunction f(id) return ReadText(PAGE_ID, id) end';
    expect(hoverText(text, text.indexOf('id)', text.indexOf('ReadText')))?.value).toBe(
      ['**ReadText**(`PAGE_ID`, `id`)', '', 'The page `PAGE_ID` is 1001, set on line 1.  ', 'The id `id` is not known here: a parameter of a function.'].join(
        '\n'
      )
    );
  });

  it('takes the innermost call around the offset', () => {
    const text = 'x = ReadText(1001, ReadText(1001, 2))';
    const calls = readTextCalls(text);
    expect(readTextCallAt(calls, text.indexOf('2'))?.open).toBe(text.lastIndexOf('('));
    expect(readTextCallAt(calls, text.indexOf(','))?.open).toBe(text.indexOf('('));
  });
});

describe('ReadText calls while typing', () => {
  it('reads a call being written up to where it stops', () => {
    expect(callsOf('local PAGE_ID = 1001\nlocal t = ReadText(PAGE_ID, ')).toEqual(['1001<PAGE_ID ?missing (cut off)']);
    expect(callsOf('x = ReadText(1001, 1\nlocal y = 2')).toEqual(['1001 1 (cut off)']);
    expect(callsOf('x = ReadText(1001, 1\ny = 2')).toEqual(['1001 1 (cut off)']);
    expect(callsOf('x = ReadText(')).toEqual(['?missing ?missing (cut off)']);
    const text = 'local PAGE_ID = 1001\nlocal t = ReadText(PAGE_ID, 1';
    expect(hoverText(text, text.length)?.value).toContain('Hull');
  });

  it('finds calls after an unclosed string, and none in an unclosed long comment', () => {
    expect(callsOf('local s = "abc\nlocal t = ReadText(1001, 2)')).toEqual(['1001 2']);
    expect(callsOf('--[[ note\nReadText(1001, 2)')).toEqual([]);
  });

  it('keeps every call of a cut text within the text, its arguments within the call', () => {
    const text = [
      'local PAGE_ID = 1972092427 -- the page',
      'local function title(id)',
      '  return ReadText(PAGE_ID, id) .. " " .. ReadText(1001, 2)',
      'end',
      'local rows = { ReadText(PAGE_ID, 10), [[x]], ReadText(1001, ReadText(1001, 3)) }',
    ].join('\n');
    for (let cut = 0; cut <= text.length; cut += 7) {
      const part = text.slice(0, cut);
      for (const call of readTextCalls(part)) {
        expect(call.start).toBeLessThan(call.open);
        expect(call.open).toBeLessThan(call.end);
        expect(call.end).toBeLessThanOrEqual(cut);
        for (const argument of [call.page, call.id]) {
          expect(argument.start).toBeGreaterThan(call.open);
          expect(argument.end).toBeLessThanOrEqual(call.end);
        }
      }
    }
  });
});
