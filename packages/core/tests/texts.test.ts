import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, languageOfTextFile, loadGameData, loadTexts, TextDatabase, textFolders, textReferenceAt, textReferencesIn } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const extensions = fileURLToPath(new URL('./fixtures/extensions', import.meta.url));
const texts = loadTexts(unpacked, { extensionFolders: [extensions] });

describe('text files', () => {
  it('tells the language from the file name', () => {
    expect(languageOfTextFile('0001-l044.xml')).toBe('44');
    expect(languageOfTextFile('0001-L049.xml')).toBe('49');
    expect(languageOfTextFile('0001-007.xml')).toBe('7');
    expect(languageOfTextFile('0001.xml')).toBe('*');
    expect(languageOfTextFile('0002-l044.xml')).toBeUndefined();
    expect(languageOfTextFile('0001-l044.xml.bak')).toBeUndefined();
  });

  it('finds the text folders of the game and of extensions once each', () => {
    const folders = textFolders(unpacked, [extensions, path.join(extensions, 'my_mod'), extensions]).map((folder) =>
      path.relative(path.dirname(unpacked), folder).split(path.sep).join('/')
    );
    expect(folders).toEqual(['unpacked/t', 'extensions/my_mod/t']);
    expect(textFolders(undefined, [])).toEqual([]);
  });

  it('reads pages and texts of every language, also from patches that add pages', () => {
    expect(texts.fileCount).toBe(4);
    expect(texts.pages().map((page) => `${page.id} ${page.title ?? ''}`)).toEqual(['1001 Interface', '1002 Player Choices', '90001 My Mod']);
    expect(texts.page(1001)?.description).toBe('Text for interface and menus');
    expect(texts.page(1002)?.description).toBeUndefined();
    expect(texts.ids(1001)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(texts.ids(90001)).toEqual([1, 2, 3]);
    expect(texts.textCount).toBe(11);
    expect(texts.languagesOf(1001, 1, '49')).toEqual(['49', '44']);
    expect(texts.languagesOf(90001, 3)).toEqual(['*']);
    expect(texts.languageNames.get('49')).toBe('Deutsch');
    const hull = texts.texts(1001, 1).find((text) => text.language === '44');
    expect(hull).toMatchObject({ text: 'Hull', line: 4, character: 4 });
    expect(path.basename(hull?.file ?? '')).toBe('0001-l044.xml');
  });

  it('reads only the wanted languages, and every-language files always', () => {
    const german = loadTexts(unpacked, { extensionFolders: [extensions], languages: new Set(['49']) });
    expect(german.fileCount).toBe(2);
    expect(german.languagesOf(1001, 1)).toEqual(['49']);
    expect(german.has(90001, 3)).toBe(true);
    expect(loadTexts(path.join(unpacked, 'nowhere')).fileCount).toBe(0);
  });

  it('picks the preferred language, then every-language texts, then English', () => {
    expect(texts.pick(1001, 1, '49')?.text).toBe('Hülle');
    expect(texts.pick(1001, 3, '49')?.text).toBe('(Storage)None');
    expect(texts.pick(90001, 3, '49')?.text).toBe('Every language');
    expect(texts.pick(1001, 999, '44')).toBeUndefined();
  });

  it('shows texts the way the game does', () => {
    const shown = (page: number, id: number): string => texts.display(texts.pick(page, id, '44')?.text ?? '', '44');
    expect(shown(1001, 3)).toBe('None');
    expect(shown(1001, 4)).toBe('Hull and Shield');
    expect(shown(1001, 5)).toBe('First line\nSecond line (not a comment) & more');
    expect(shown(1001, 7)).toBe('Missing {1001,999}');
    expect(shown(1001, 6).startsWith('Loops Loops')).toBe(true);
    expect(texts.display('{1001,4}', '49')).toBe('Hülle and Schild');
    expect(texts.display('a (b (c) d) e \\\\ \\033', '44')).toBe('a  e \\ \\033');
  });

  it('lets a later file override a text and an open editor replace a file', () => {
    const database = new TextDatabase();
    expect(database.setFile('/game/t/0001-l044.xml', '<language><page id="1"><t id="1">Old</t></page></language>')).toBe(true);
    expect(database.setFile('/mod/t/0001-l044.xml', '<diff><add sel="/language"><page id="1"><t id="1">New</t></page></add></diff>')).toBe(true);
    expect(database.pick(1, 1, '44')?.text).toBe('New');
    expect(database.texts(1, 1).map((text) => text.text)).toEqual(['Old', 'New']);
    database.setFile('/mod/t/0001-l044.xml', '<diff><add sel="/language"><page id="1"><t id="2">Other</t></page></add></diff>');
    expect(database.pick(1, 1, '44')?.text).toBe('Old');
    expect(database.has(1, 2)).toBe(true);
    database.removeFile('/mod/t/0001-l044.xml');
    expect(database.has(1, 2)).toBe(false);
    expect(database.hasFile('/game/t/0001-l044.xml')).toBe(true);
    expect(database.setFile('/game/t/readme.xml', '<language/>')).toBe(false);
  });

  it('keeps the texts before a spot that is still being typed', () => {
    const database = new TextDatabase();
    database.setFile('/mod/t/0001-l044.xml', '<language>\n  <page id="5">\n    <t id="1">Done</t>\n    <t id="2">Half\n    <t id="3>Broken</t>\n');
    expect(database.pick(5, 1, '44')?.text).toBe('Done');
    expect(database.hasPage(5)).toBe(true);
  });
});

describe('text references', () => {
  it('finds every reference in a value', () => {
    expect(textReferencesIn("'{1001,1}' + {1001, 2} + { 20101 , 3 } + {1001,$x}")).toEqual([
      { page: 1001, id: 1, start: 1, end: 9 },
      { page: 1001, id: 2, start: 13, end: 22 },
      { page: 20101, id: 3, start: 25, end: 38 },
    ]);
  });

  it('finds the reference under a caret on its line, in any XML', () => {
    const text = '<ware name="{1001, 2}"/>\n<speak page="1001" line="4"/>\n{1001,1}';
    const at = (marker: string, shift = 0) => textReferenceAt(text, text.indexOf(marker) + shift);
    expect(at('{1001, 2}')).toEqual({ page: 1001, id: 2, start: 12, end: 21 });
    expect(at('{1001, 2}', 9)).toMatchObject({ page: 1001, id: 2 });
    expect(at('2}', 3)).toBeUndefined();
    expect(at('line="4"', 7)).toMatchObject({ page: 1001, id: 4 });
    expect(at('{1001,1}')).toMatchObject({ page: 1001, id: 1 });
    expect(at('<ware')).toBeUndefined();
  });
});

describe('text diagnostics', () => {
  const game = loadGameData(unpacked);
  const actions = (body: string): string =>
    `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <actions>\n        ${body}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;
  const report = (body: string, validateTexts?: boolean): string[] =>
    analyzeText(actions(body), { schemas: game.schemas, properties: game.properties, texts: game.texts, validateTexts })
      .diagnostics.filter((diagnostic) => diagnostic.code === 'text-undefined')
      .map(
        (diagnostic) =>
          `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}-${diagnostic.range.end.character + 1} ${diagnostic.severity} ${diagnostic.message}`
      );

  it('loads the game texts with the game data', () => {
    expect(game.texts.fileCount).toBe(2);
    expect(loadGameData(unpacked, { extensionFolders: [extensions] }).texts.has(90001, 1)).toBe(true);
  });

  it('reports references to texts that no file defines', () => {
    expect(report('<debug_text text="{1001, 1} + {1001,99} + {77, 1}"/>')).toEqual([
      '5:39-48 2 Text 99 does not exist on page 1001',
      '5:51-58 2 Text page 77 does not exist',
    ]);
    expect(report('<set_value name="$x" exact="{1001,2}"/>')).toEqual([]);
    expect(report('<speak page="1001" line="98"/>')).toEqual(['5:34-36 2 Text 98 does not exist on page 1001']);
  });

  it('leaves comments alone and can be turned off', () => {
    expect(report('<set_value name="$x" exact="1" comment="see {1001,99}"/>')).toEqual([]);
    expect(report('<debug_text text="{1001,99}"/>', false)).toEqual([]);
    expect(analyzeText(actions('<debug_text text="{1001,99}"/>'), { schemas: game.schemas }).diagnostics.filter((d) => d.code === 'text-undefined')).toEqual(
      []
    );
  });

  it('keeps checking while a value is being typed', () => {
    expect(report('<debug_text text="{1001,99}\n')).toEqual(['5:27-36 2 Text 99 does not exist on page 1001']);
  });
});
