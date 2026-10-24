import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeReadText,
  describeText,
  loadTexts,
  LuaProject,
  readTextCallAt,
  readTextCalls,
  readTextCompletions,
  readTextDefinitions,
  readTextHover,
  scanLua,
  validateReadText,
  type ReadTextArgument,
} from '../src';

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

/** Completion at the `|` of a text, as `label detail` for the first items and the range they replace; undefined when none. */
function completionAt(marked: string): { items: string[]; range: string } | undefined {
  const offset = marked.indexOf('|');
  const text = marked.replace('|', '');
  const document = TextDocument.create('file:///mod/ui/menu.lua', 'lua', 1, text);
  const items = readTextCompletions(document, readTextCalls(text), offset, texts);
  if (!items) {
    return undefined;
  }
  const edit = items[0]?.textEdit;
  const range = edit && 'range' in edit ? `${edit.range.start.character}-${edit.range.end.character}` : '';
  return { items: items.map((item) => `${item.label}${item.detail ? ` ${item.detail}` : ''}`), range };
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
      '7<config.field ?an expression',
      // `field` is only a field of a table constructor, no assignment of the name.
      '?not set in this file ?not set in this file',
      '1001 ?not a whole number',
      '100<PAGE ?missing',
      '?missing ?missing',
    ]);
  });

  it('resolves fields of tables the file sets, and tells why others are not known', () => {
    const text = [
      'local eic = {',
      '  PAGE = 1972092440, MODE = "eic",',
      '  sub = { ID = 0x10, [1] = 5, 7; onClick = function() local inner = 3 end },',
      '  twice = 1,',
      '}',
      'eic.twice = 2',
      'eic.extra = 12',
      'local skill = GetSkill()',
      'local mod = require("extensions.mod.ui.config")',
      'ReadText(eic.PAGE, eic.sub.ID)',
      'ReadText(eic.PAGE, eic.extra)',
      'ReadText(eic.MODE, eic.twice)',
      'ReadText(eic.sub.inner, eic.missing)',
      'ReadText(skill.textid, mod.PAGE)',
      'ReadText(Global.PAGE, 1)',
      'for _, option in ipairs(eic) do ReadText(option.page, option.id) end',
    ].join('\n');
    expect(callsOf(text)).toEqual([
      '1972092440<eic.PAGE 16<eic.sub.ID',
      '1972092440<eic.PAGE 12<eic.extra',
      '?set to something other than a whole number ?set to different values in this file',
      '?a field this file does not set ?a field this file does not set',
      // A module and a global wait for the files of the extension.
      '?a field this file does not set ?a field this file does not set',
      '?a field this file does not set 1',
      '?a field of a loop variable ?a field of a loop variable',
    ]);
    const [, , , , modCall, globalCall] = readTextCalls(text);
    expect(modCall.id.pending).toEqual({ name: 'mod.PAGE', lookup: { kind: 'module', module: 'extensions.mod.ui.config', rest: ['PAGE'] } });
    expect(modCall.page.pending).toBeUndefined();
    expect(globalCall.page.pending).toEqual({ name: 'Global.PAGE', lookup: { kind: 'global', key: 'Global.PAGE' } });
  });

  it('gives both numbers of c and N or M, and both texts in the hover and the definitions', () => {
    const text = [
      'local PAGE = 1001',
      'local OTHER = 2',
      'ReadText(PAGE, d.mine and 1 or OTHER)',
      'ReadText(PAGE, (kind == "x") and 3 or 3)',
      'ReadText(PAGE, a and b and 1 or 2)',
      'ReadText(PAGE, a or 2)',
      'ReadText(PAGE, a and 1 or b and 2 or 3)',
      'ReadText(PAGE, (a and 1) or 2)',
      'ReadText(PAGE, a and x or 2)',
    ].join('\n');
    expect(readTextCalls(text).map((call) => call.id.choices ?? call.id.value ?? `?${call.id.reason}`)).toEqual([
      [1, 2],
      3,
      [1, 2],
      '?an expression',
      '?an expression',
      '?an expression',
      '?an expression',
    ]);
    const offset = text.indexOf('d.mine');
    const hover = hoverText(text, offset);
    expect(hover?.value).toBe(
      [
        describeText(texts, 1001, 1),
        '',
        describeText(texts, 1001, 2),
        '',
        'The page `PAGE` is 1001, set on line 1.  ',
        'The id `d.mine and 1 or OTHER` is 1 or 2.',
      ].join('\n')
    );
    expect(readTextDefinitions(readTextCalls(text), offset, texts).map((location) => location.range.start.line)).toEqual([4, 5]);
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

  it('goes to the text from the argument list when page and id are known', () => {
    const text = 'local PAGE_ID = 1001\nprint(ReadText(PAGE_ID, 2), ReadText(PAGE_ID, unknown))';
    const calls = readTextCalls(text);
    const [location] = readTextDefinitions(calls, text.indexOf(', 2') + 2, texts);
    expect(location.uri).toMatch(/\/t\/0001-l044\.xml$/);
    expect(location.range.start.line).toBe(5);
    expect(readTextDefinitions(calls, text.indexOf('2)') + 1, texts)).toHaveLength(1);
    expect(readTextDefinitions(calls, text.indexOf('unknown'), texts)).toEqual([]);
    expect(readTextDefinitions(calls, text.indexOf('print'), texts)).toEqual([]);
    expect(readTextDefinitions(readTextCalls('ReadText(1001, 999)'), 10, texts)).toEqual([]);
  });

  it('warns on the argument list about a text that does not exist, for each text of c and N or M, while typing too', () => {
    const lines = [
      'local PAGE = 1001',
      'a = ReadText(PAGE, 1)',
      'b = ReadText(PAGE, 99)',
      'c = ReadText(3000, 1)',
      'd = ReadText(PAGE, x and 1 or 98)',
      'e = ReadText(x and 3000 or 3001, y and 1 or 2)',
      'f = ReadText(PAGE, id)',
      'g = ReadText(1001, 97',
    ];
    const document = TextDocument.create('file:///mod/ui/menu.lua', 'lua', 1, lines.join('\n'));
    const warnings = validateReadText(document, readTextCalls(document.getText()), texts, 'X4CodeSense').map(
      (diagnostic) =>
        `${diagnostic.range.start.line}:${diagnostic.range.start.character}-${diagnostic.range.end.line}:${diagnostic.range.end.character} ${diagnostic.code} ${diagnostic.severity} ${diagnostic.message}`
    );
    const on = (line: number): string => `${line}:${lines[line].indexOf('(')}-${line}:${lines[line].length} text-undefined 2`;
    expect(warnings).toEqual([
      `${on(2)} Text 99 does not exist on page 1001`,
      `${on(3)} Text page 3000 does not exist`,
      `${on(4)} Text 98 does not exist on page 1001`,
      `${on(5)} Text page 3000 does not exist`,
      `${on(5)} Text page 3001 does not exist`,
      `${on(7)} Text 97 does not exist on page 1001`,
    ]);
  });

  it('completes the page and the ids of a known page, where the argument is empty or digits', () => {
    expect(completionAt('x = ReadText(|)')).toEqual({ items: ['1001 Interface', '1002 Player Choices', '2000 Formats'], range: '13-13' });
    expect(completionAt('x = ReadText(10|0)')).toEqual({ items: ['1001 Interface', '1002 Player Choices'], range: '13-16' });
    expect(completionAt('x = ReadText(1002, |)')).toEqual({ items: ['10 Yes'], range: '19-19' });
    expect(completionAt('local PAGE = 1001\nx = ReadText(PAGE, 1|)')?.items).toEqual(['1 Hull']);
    expect(completionAt('local PAGE = 1001\nx = ReadText(PAGE,|)')?.items).toHaveLength(7);
    // A name being typed is the Lua extension's; an unknown page has no ids to offer.
    expect(completionAt('x = ReadText(PA|)')).toBeUndefined();
    expect(completionAt('x = ReadText(|PAGE, 1)')).toBeUndefined();
    expect(completionAt('x = ReadText(1001, |id)')).toBeUndefined();
    expect(completionAt('x = ReadText(1001, 1| + 1)')).toBeUndefined();
    expect(completionAt('x = ReadText(1001, id|)')).toBeUndefined();
    expect(completionAt('function f(page) return ReadText(page, |) end')).toBeUndefined();
    expect(completionAt('x = |ReadText(1001, 1)')).toBeUndefined();
    expect(completionAt('x = ReadText(1001, 1)|')).toBeUndefined();
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

  it('completes in a call being written, the white space after it included', () => {
    expect(completionAt('x = ReadText(|')?.items).toHaveLength(3);
    expect(completionAt('x = ReadText( |')?.items).toHaveLength(3);
    expect(completionAt('x = ReadText(1002, |\nlocal y = 2')?.items).toEqual(['10 Yes']);
    expect(completionAt('x = ReadText(1002,\n  |\nlocal y = 2')?.items).toEqual(['10 Yes']);
    expect(completionAt('x = ReadText(1001, 3|\ny = 2')?.items).toEqual(['3 None']);
    expect(completionAt('x = ReadText(1001, 3 |\ny = 2')).toBeUndefined();
    expect(completionAt('local s = "open\nx = ReadText(2000, |')?.items).toEqual(['1 %1 sold to %2 for %3Cr']);
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

describe('ReadText with the other files of the extension', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'x4codesense-lua-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text: string): string => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    return full;
  };
  write('mymod/content.xml', '<content id="mymod"/>');
  write('mymod/ui/config.lua', 'local cfg = { PAGE = 1001, sub = { ID = 2 } }\nRegister_Require_Response("extensions.mymod.ui.config", cfg)\n');
  const base = write('mymod/ui/base.lua', '-- shared\nMyMod = MyMod or {}\nMyMod = { config = { textId = 1002 } }\nShared = 1001\n');
  write('mymod/ui/returned.xpl', 'local t = { PAGE = 2000 }\nreturn t\n');
  write('mymod/ui/esm.lua', 'local esm = { PAGE = 1001 }\nLoader.Register("extensions.mymod.ui.esm", esm, init)\n');
  write('mymod/ui/clash.lua', 'Clash = 1\nlocal Shared = 5\n');
  write('mymod/ui/clash2.lua', 'Clash = 2\n');
  // A packed copy below the extension is an extension of its own: not one of its files.
  write('mymod/dist/1.00/out/mymod/content.xml', '<content id="mymod"/>');
  write('mymod/dist/1.00/out/mymod/ui/base.lua', 'MyMod = { config = { textId = 9 } }\nShared = 9\n');
  write('othermod/content.xml', '<content id="othermod"/>');
  write('othermod/ui/config.lua', 'local c = { PAGE = 1 }\nreturn c\n');
  const menuText = [
    'local cfg = require("extensions.mymod.ui.config")',
    'local ret = require "extensions.mymod.ui.returned"',
    'local esm = Loader.Require("extensions.mymod.ui.esm")',
    'local other = require("extensions.othermod.ui.config")',
    'local ffi = require("ffi")',
    'ReadText(cfg.PAGE, cfg.sub.ID)',
    'ReadText(MyMod.config.textId, 10)',
    'ReadText(ret.PAGE, 1)',
    'ReadText(esm.PAGE, 1)',
    'ReadText(other.PAGE, ffi.C)',
    'ReadText(Shared, Clash)',
    'ReadText(Missing, cfg.Missing)',
  ].join('\n');
  const menu = write('mymod/ui/menu.lua', menuText);
  const folders = [path.join(root, 'mymod'), path.join(root, 'othermod')];

  const resolved = (project: LuaProject, file = menu, text = menuText): string[] =>
    project.resolveAll(readTextCalls(text), file).map((call) => `${shown(call.page)} ${shown(call.id)}`);

  it('follows modules and globals within the extension that holds the file', () => {
    expect(resolved(new LuaProject(folders))).toEqual([
      '1001<cfg.PAGE 2<cfg.sub.ID',
      '1002<MyMod.config.textId 10',
      '2000<ret.PAGE 1',
      '1001<esm.PAGE 1',
      '?a field of the module extensions.othermod.ui.config, which is no file of this extension ?a field of the module ffi, which is no file of this extension',
      '1001<Shared ?set to different values in the files of this extension',
      '?not set in the files of this extension ?a field this file does not set',
    ]);
  });

  it('says in the hover which file sets the value', () => {
    const [call] = new LuaProject(folders).resolveAll(readTextCalls(menuText), menu);
    expect(call.page.constant).toEqual({ name: 'cfg.PAGE', offset: 14, file: path.join(root, 'mymod', 'ui', 'config.lua'), line: 0 });
    const document = TextDocument.create('file:///mymod/ui/menu.lua', 'lua', 1, menuText);
    expect(describeReadText(document, call, texts)).toContain('The page `cfg.PAGE` is 1001, set in `config.lua` on line 1.');
  });

  it('follows nothing for a file outside the extensions, and the open text before the file on disk', () => {
    const outside = write('loose/menu.lua', menuText);
    expect(resolved(new LuaProject(folders), outside)[1]).toBe('?a field this file does not set 10');
    const project = new LuaProject(folders, undefined, (file) => (file === base ? 'MyMod = { config = { textId = 1001 } }\n' : undefined));
    expect(resolved(project)[1]).toBe('1001<MyMod.config.textId 10');
  });

  it('reads a file again after forget, and the files of the extension again after forgetListings', () => {
    const project = new LuaProject(folders);
    expect(resolved(project)[6]).toBe('?not set in the files of this extension ?a field this file does not set');
    const added = write('mymod/ui/added.lua', 'Missing = 2000\n');
    expect(resolved(project)[6]).toBe('?not set in the files of this extension ?a field this file does not set');
    project.forgetListings();
    expect(resolved(project)[6]).toBe('2000<Missing ?a field this file does not set');
    writeFileSync(added, 'Missing = 1002\n');
    project.forget(added);
    expect(resolved(project)[6]).toBe('1002<Missing ?a field this file does not set');
  });
});
