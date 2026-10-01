import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Location } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import {
  analyzeComparisonSide,
  analyzeText,
  hoverAt,
  loadGameData,
  loadScriptIndex,
  parseXml,
  prepareRenameAt,
  referencesAt,
  renameAt,
  ScriptIndex,
  type DocumentAnalysis,
  type GameData,
} from '../src';

const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const gameFolder = path.join(project, 'game');
const modsFolder = path.join(project, 'mods');
const index = loadScriptIndex(gameFolder, [modsFolder]);

describe('script index', () => {
  it('indexes the scripts of the game and of the extensions', () => {
    expect(index.size).toBe(5);
    expect(index.scriptNames('md')).toEqual(['Mine', 'Setup']);
    expect(index.scriptNames('aiscripts')).toEqual(['lib.target', 'order.mine']);
    expect(index.scripts('md', 'Setup').map((script) => script.source)).toEqual(['game']);
    expect(index.scripts('md', 'Mine').map((script) => script.source)).toEqual(['my_mod']);
    expect(index.scripts('aiscripts', 'order.mine')[0].params).toEqual(['target']);
    expect(index.scripts('md', 'Nobody')).toEqual([]);
  });

  it('knows the cues of a script, with what patches of extensions add', () => {
    const setup = index.scripts('md', 'Setup')[0];
    expect(index.cuesOf(setup).map((cue) => `${cue.kind} ${cue.name}${cue.parent ? ` in ${cue.parent}` : ''}${cue.patch ? ' (patch)' : ''}`)).toEqual([
      'cue Start',
      'cue Inner in Start',
      'library Reward',
      'cue Added (patch)',
    ]);
    expect(index.cues('Setup', 'Start')[0]).toMatchObject({ instantiate: true, namespace: 'this', position: { line: 4, character: 4 } });
    expect(index.cues('Setup', 'Reward')[0]).toMatchObject({ purpose: 'run_actions', params: ['Amount'], instantiate: false });
    expect(path.basename(path.dirname(path.dirname(index.cues('Setup', 'Added')[0].patch ?? '')))).toBe('my_mod');
    // A removal by a patch is not applied: the patch support will evaluate `sel`.
    expect(index.cues('Setup', 'Inner')).toHaveLength(1);
    expect(index.cues('Setup', 'Nowhere')).toEqual([]);
  });

  it('knows the interrupt library items of AI scripts', () => {
    expect(index.libraryItems('handler', 'TargetInvalidHandler')[0]).toMatchObject({ script: 'lib.target', position: { line: 8, character: 6 } });
    expect(index.libraryItemNames('actions')).toEqual(['CheckTarget']);
    expect(index.libraryItemNames('conditions')).toEqual(['TargetConditions']);
    expect(index.libraryItems('handler', 'Nowhere')).toEqual([]);
  });

  it('tells the source of an indexed file and of a new file in an indexed folder', () => {
    expect(index.sourceOf(path.join(modsFolder, 'my_mod', 'md', 'mine.xml'))).toBe('my_mod');
    expect(index.sourceOf(path.join(modsFolder, 'my_mod', 'md', 'new.xml'))).toBe('my_mod');
    expect(index.sourceOf(path.join(gameFolder, 'aiscripts', 'new.xml'))).toBe('game');
    expect(index.sourceOf(path.join(project, 'elsewhere.xml'))).toBeUndefined();
  });

  it('says whether what other scripts see of a file changed', () => {
    const copy = loadScriptIndex(gameFolder, [modsFolder]);
    const file = path.join(modsFolder, 'my_mod', 'md', 'mine.xml');
    const text = readFileSync(file, 'utf8');
    expect(copy.setText(file, text.replace('<actions>', '<actions>\n'), 'my_mod')).toBe(false);
    expect(copy.setText(file, text.replace('name="Own"', 'name="Renamed"'), 'my_mod')).toBe(true);
    expect(copy.cues('Mine', 'Renamed')).toHaveLength(1);
    expect(copy.removeFile(file)).toBe(true);
    expect(copy.removeFile(file)).toBe(false);
    expect(copy.scripts('md', 'Mine')).toEqual([]);
    expect(copy.setText(file, '<mdscript name="Half">\n  <cues>\n    <cue name="Typing', 'my_mod')).toBe(true);
    expect(copy.scriptNames('md')).toContain('Half');
    expect(copy.setText(path.join(project, 'wares.xml'), '<wares/>', 'x')).toBe(false);
    expect(new ScriptIndex().size).toBe(0);
  });
});

describe('variables across scripts', () => {
  const game = loadGameData(unpacked);
  const withVariables = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
  const order = path.join(modsFolder, 'my_mod', 'aiscripts', 'order.mine.xml');
  const library = path.join(gameFolder, 'aiscripts', 'lib.target.xml');
  const analyse = (file: string, withIndex = true) =>
    analyzeText(readFileSync(file, 'utf8'), {
      schemas: game.schemas,
      properties: game.properties,
      validateVariables: true,
      ...(withIndex ? { index: withVariables } : {}),
    });
  const unset = (file: string, withIndex = true): string[] =>
    analyse(file, withIndex)
      .diagnostics.filter((diagnostic) => diagnostic.code === 'variable-undefined')
      .map((diagnostic) => diagnostic.message);

  it('indexes the variables interrupt library items set, with the schemas', () => {
    expect(withVariables.libraryItems('actions', 'CheckTarget')[0].variables).toEqual([
      { name: 'checked', position: { file: library, line: 6, character: 25 } },
    ]);
    expect(withVariables.libraryItems('handler', 'TargetInvalidHandler')[0].variables.map((variable) => variable.name)).toEqual(['invalid']);
    expect(index.libraryItems('actions', 'CheckTarget')[0].variables).toEqual([]);
  });

  it('counts what the library items a script uses set, and leaves library reads to the scripts that use them', () => {
    expect(unset(order)).toEqual(["Variable '$nowhere' is never set in this script"]);
    expect(unset(order, false)).toEqual([
      "Variable '$checked' is never set in this script",
      "Variable '$invalid' is never set in this script",
      "Variable '$nowhere' is never set in this script",
    ]);
    // `$target` read inside CheckTarget is set by the scripts that include it.
    expect(unset(library, false)).toEqual([]);
    const checked = analyse(order).variables?.tables[0].variables.get('checked');
    expect(checked?.elsewhere).toEqual([{ position: { file: library, line: 6, character: 25 }, via: 'interrupt actions CheckTarget' }]);
  });

  it('works out the variables of a cue in another script when asked, from the editor when it holds the file', () => {
    expect(withVariables.cueVariables('Setup', 'Start').map((variable) => `${variable.name}:${variable.position.line + 1}`)).toEqual(['started:7']);
    expect(withVariables.cueVariables('Setup', 'Inner')).toEqual([]);
    expect(withVariables.cueVariables('Nobody', 'Start')).toEqual([]);
    expect(index.cueVariables('Setup', 'Start')).toEqual([]);
    const copy = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const setup = path.join(gameFolder, 'md', 'setup.xml');
    const edited = readFileSync(setup, 'utf8').replace('$started', '$begun');
    copy.setStructure(setup, edited, parseXml(edited), 'game', true);
    expect(copy.cueVariables('Setup', 'Start').map((variable) => variable.name)).toEqual(['begun']);
    copy.setText(setup, readFileSync(setup, 'utf8'), 'game');
    expect(copy.cueVariables('Setup', 'Start').map((variable) => variable.name)).toEqual(['started']);
  });

  it('knows the libraries Mission Director scripts share, and what they write into cues they get as values', () => {
    const scripts = new ScriptIndex(game.schemas);
    const add = (name: string, lines: string[]): string => {
      const text = `<mdscript name="${name}">\n  <cues>\n${lines.join('\n')}\n  </cues>\n</mdscript>\n`;
      scripts.setStructure(path.join(project, 'open', 'md', `${name.toLowerCase()}.xml`), text, parseXml(text), 'game', true);
      return text;
    };
    const libs = add('Libs', [
      '    <library name="Constants">',
      '      <actions>',
      '        <set_value name="$constant" exact="1"/>',
      '      </actions>',
      '    </library>',
      '    <library name="Included">',
      '      <actions>',
      '        <set_value name="$y" exact="$fromIncluder"/>',
      '      </actions>',
      '    </library>',
      '    <library name="Instantiated">',
      '      <params>',
      '        <param name="p"/>',
      '      </params>',
      '      <actions>',
      '        <set_value name="$z" exact="$p + $typo"/>',
      '      </actions>',
      '    </library>',
      '    <library name="Unused">',
      '      <actions>',
      '        <set_value name="$w" exact="$unknown"/>',
      '      </actions>',
      '    </library>',
      '    <library name="Chained">',
      '      <actions>',
      '        <include_actions ref="Constants"/>',
      '      </actions>',
      '    </library>',
    ]);
    const user = add('User', [
      '    <cue name="A">',
      '      <actions>',
      '        <set_value name="$fromIncluder" exact="1"/>',
      '        <include_actions ref="md.Libs.Constants"/>',
      '        <include_actions ref="md.Libs.Included"/>',
      '        <set_value name="$sum" exact="$constant + $y + $nothing"/>',
      '        <set_value name="event.param.$reply" exact="$sum"/>',
      '      </actions>',
      '    </cue>',
      '    <cue name="B" ref="md.Libs.Instantiated">',
      '      <param name="p" value="1"/>',
      '    </cue>',
      '    <cue name="C">',
      '      <actions>',
      '        <include_actions ref="md.Libs.Chained"/>',
      '        <set_value name="$c" exact="$constant"/>',
      '      </actions>',
      '    </cue>',
    ]);
    const reader = add('Reader', [
      '    <cue name="R">',
      '      <actions>',
      '        <set_value name="$r" exact="this.$reply + $never"/>',
      '      </actions>',
      '    </cue>',
    ]);
    expect([scripts.isIncludedByOtherScripts('Libs', 'Included'), scripts.isIncludedByOtherScripts('Libs', 'Instantiated')]).toEqual([true, false]);
    expect([scripts.isUsedByOtherScripts('Libs', 'Instantiated'), scripts.isUsedByOtherScripts('Libs', 'Unused')]).toEqual([true, false]);
    expect([scripts.isWrittenThroughValues('reply'), scripts.isWrittenThroughValues('sum')]).toEqual([true, false]);
    // A library's table also gets what the libraries it includes set.
    expect(scripts.cueVariables('Libs', 'Chained').map((variable) => `${variable.name}:${variable.position.line + 1}`)).toEqual(['constant:5']);

    // With the index the check is on by default.
    const report = (text: string, withIndex = true): string[] =>
      analyzeText(text, { schemas: game.schemas, properties: game.properties, ...(withIndex ? { index: scripts } : {}) })
        .diagnostics.filter((diagnostic) => diagnostic.code === 'variable-undefined')
        .map((diagnostic) => diagnostic.message);
    // Included libraries read what their includers set, and nothing uses Unused; another script instantiates Instantiated.
    expect(report(libs)).toEqual(["Variable '$typo' is never set in library 'Instantiated'"]);
    expect(report(user)).toEqual(["Variable '$nothing' is never set in cue 'A'"]);
    expect(report(reader)).toEqual(["Variable '$never' is never set in cue 'R'"]);
    expect(report(reader, false)).toEqual([]);
    const constant = analyzeText(user, { schemas: game.schemas, index: scripts })
      .variables?.tables.find((table) => table.name === 'A')
      ?.variables.get('constant');
    expect(constant?.elsewhere.map((definition) => `${definition.via} ${definition.position.line + 1}`)).toEqual(['library Constants of Libs 5']);

    // What other scripts see changes with a new write through a value.
    const edited = user.replace('event.param.$reply', 'event.param.$answer');
    expect(scripts.setStructure(path.join(project, 'open', 'md', 'user.xml'), edited, parseXml(edited), 'game', true)).toBe(true);
    expect(report(reader)).toEqual(["Variable '$reply' is never set in cue 'R'", "Variable '$never' is never set in cue 'R'"]);
  });
});

describe('checks against the index', () => {
  const game = loadGameData(unpacked);
  const md = (body: string): string =>
    `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <actions>\n        ${body}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;
  const ai = (body: string): string =>
    `<aiscript name="a">\n  <interrupts>\n    ${body}\n  </interrupts>\n  <attention min="1">\n    <actions/>\n  </attention>\n</aiscript>\n`;
  const report = (text: string, withIndex: boolean, validateRemoteCues?: boolean): string[] =>
    analyzeText(text, { schemas: game.schemas, properties: game.properties, ...(withIndex ? { index } : {}), validateRemoteCues })
      .diagnostics.filter((diagnostic) => diagnostic.code === 'library-undefined' || diagnostic.code === 'cue-undefined')
      .map((diagnostic) => `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.code}: ${diagnostic.message}`);

  it('reports interrupt library references no script defines, once scripts are indexed', () => {
    const text = ai('<handler ref="TargetInvalidHandler"/>\n    <handler ref="MissingHandler"/>');
    expect(report(text, true)).toEqual(["4:19 library-undefined: Interrupt handler 'MissingHandler' is not defined in any known script"]);
    expect(report(text, false)).toEqual([]);
    expect(report(ai('<library><handler name="Local"/></library>\n    <handler ref="Local"/>'), true)).toEqual([]);
  });

  it('reports md.Script.Cue naming what no indexed script defines, unless turned off', () => {
    const text = md(
      '<cancel_cue cue="md.Setup.Start"/>\n        <cancel_cue cue="md.Setup.Added"/>\n        <cancel_cue cue="md.Setup.Nowhere"/>\n        <cancel_cue cue="md.Nobody.Start"/>\n        <set_value name="$x" exact="@md.Nobody.Start"/>\n        <set_value name="$y" exact="md.$global.count"/>'
    );
    const expected = ["7:35 cue-undefined: Script 'Setup' has no cue 'Nowhere'", "8:29 cue-undefined: No Mission Director script 'Nobody' is known"];
    expect(report(text, true)).toEqual(expected);
    expect(report(text, true, true)).toEqual(expected);
    expect(report(text, true, false)).toEqual([]);
    // Without the index there is nothing to check against.
    expect(report(text, false)).toEqual([]);
  });

  it('leaves references to the document itself to its own checks', () => {
    expect(report(md('<cancel_cue cue="md.S.Missing"/>'), true)).toEqual(["5:31 cue-undefined: 'Missing' is no keyword and no cue of this script"]);
  });
});

describe('references and rename across scripts', () => {
  const game = loadGameData(unpacked);
  const root = path.join(project, 'cross');
  const workspace = path.join(root, 'workspace');
  const scripts = new ScriptIndex(game.schemas);
  const withIndex: GameData = { ...game, folder: path.join(root, 'game'), index: scripts };
  const options = { editableFolders: [workspace] };
  const texts = new Map<string, string>();
  const add = (file: string, source: string, lines: string[]): string => {
    const text = `${lines.join('\n')}\n`;
    texts.set(file, text);
    scripts.setStructure(file, text, parseXml(text), source, true);
    return file;
  };
  const base = add(path.join(root, 'game', 'md', 'base.xml'), 'game', [
    '<mdscript name="Base">',
    '  <cues>',
    '    <cue name="Core"/>',
    '  </cues>',
    '</mdscript>',
  ]);
  const api = add(path.join(workspace, 'api_mod', 'md', 'api.xml'), 'api_mod', [
    '<mdscript name="Api">',
    '  <cues>',
    '    <cue name="Register" instantiate="true">',
    '      <actions>',
    '        <set_value name="$count" exact="1"/>',
    '        <signal_cue_instantly cue="Register"/>',
    '        <debug_text text="md.Api.Register.$count"/>',
    '      </actions>',
    '    </cue>',
    '    <library name="Counting">',
    '      <actions>',
    '        <set_value name="$total" exact="$tally + 1"/>',
    '      </actions>',
    '    </library>',
    '  </cues>',
    '</mdscript>',
  ]);
  const user = add(path.join(workspace, 'user_mod', 'md', 'user.xml'), 'user_mod', [
    '<mdscript name="User">',
    '  <cues>',
    '    <cue name="Use">',
    '      <actions>',
    '        <signal_cue_instantly cue="md.Api.Register"/>',
    '        <set_value name="$seen" exact="md.Api.Register.$count + md.Base.Core.$x"/>',
    '        <set_value name="$tally" exact="1"/>',
    '        <include_actions ref="md.Api.Counting"/>',
    '      </actions>',
    '    </cue>',
    '  </cues>',
    '</mdscript>',
  ]);
  const library = add(path.join(workspace, 'api_mod', 'aiscripts', 'lib.shared.xml'), 'api_mod', [
    '<aiscript name="lib.shared">',
    '  <interrupts>',
    '    <library>',
    '      <actions name="SharedActions">',
    '        <set_value name="$shared" exact="$input"/>',
    '      </actions>',
    '    </library>',
    '  </interrupts>',
    '  <attention min="unknown">',
    '    <actions/>',
    '  </attention>',
    '</aiscript>',
  ]);
  const order = add(path.join(workspace, 'user_mod', 'aiscripts', 'order.user.xml'), 'user_mod', [
    '<aiscript name="order.user">',
    '  <attention min="unknown">',
    '    <actions>',
    '      <set_value name="$input" exact="1"/>',
    '      <include_interrupt_actions ref="SharedActions"/>',
    '      <set_value name="$local" exact="$shared"/>',
    '    </actions>',
    '  </attention>',
    '</aiscript>',
  ]);
  /** Where the nth `needle` of a line of a file starts, as `file:line:character` with zero-based numbers. */
  const place = (file: string, line: number, needle: string, nth = 0): string => {
    const text = (texts.get(file) ?? '').split('\n')[line];
    let character = -1;
    for (let found = 0; found <= nth; found++) {
      character = text.indexOf(needle, character + 1);
    }
    return `${path.basename(file)}:${line}:${character}`;
  };
  /** The analysis of a file, with the caret inside the nth `needle` of a line. */
  const at = (file: string, line: number, needle: string, nth = 0): { analysis: DocumentAnalysis; offset: number } => {
    const text = texts.get(file) ?? '';
    const analysis = analyzeText(text, { schemas: game.schemas, properties: game.properties, index: scripts }, pathToFileURL(file).toString());
    const character = Number(place(file, line, needle, nth).split(':')[2]);
    return { analysis, offset: analysis.document.offsetAt({ line, character: character + 1 }) };
  };
  const places = (locations: Location[]): string[] =>
    locations.map((location) => `${path.basename(fileURLToPath(location.uri))}:${location.range.start.line}:${location.range.start.character}`).sort();
  const references = (file: string, line: number, needle: string, nth = 0): string[] => {
    const { analysis, offset } = at(file, line, needle, nth);
    return places(referencesAt(analysis, offset, withIndex));
  };
  const rename = (file: string, line: number, needle: string, newName: string, nth = 0, renameOptions = options): string[] | string | undefined => {
    const { analysis, offset } = at(file, line, needle, nth);
    const renamed = renameAt(analysis, offset, newName, withIndex, renameOptions);
    if (renamed && 'refused' in renamed) {
      return renamed.refused;
    }
    return Object.entries(renamed?.changes ?? {})
      .flatMap(([uri, edits]) =>
        edits.map((edit) => `${path.basename(fileURLToPath(uri))}:${edit.range.start.line}:${edit.range.start.character}=${edit.newText}`)
      )
      .sort();
  };
  const refusal = (file: string, line: number, needle: string, renameOptions = options): string | undefined => {
    const { analysis, offset } = at(file, line, needle);
    const prepared = prepareRenameAt(analysis, offset, withIndex, renameOptions);
    return prepared && 'refused' in prepared ? prepared.refused : undefined;
  };

  it('records the references each file makes to names other files define', () => {
    expect(scripts.cueReferences('Api', 'Register').map((reference) => `${path.basename(reference.position.file)}:${reference.position.line}`)).toEqual([
      'api.xml:6',
      'user.xml:4',
      'user.xml:5',
    ]);
    expect(scripts.cueVariableReferences('Api', 'Register', 'count')).toHaveLength(2);
    expect(scripts.scriptReferences('Api')).toHaveLength(4);
    expect(scripts.libraryReferences('actions', 'SharedActions').map((reference) => path.basename(reference.position.file))).toEqual(['order.user.xml']);
    expect(scripts.cues('Api', 'Register')[0].namePosition).toEqual({ file: api, line: 2, character: 15 });
    expect(scripts.scripts('md', 'Api')[0].namePosition).toEqual({ file: api, line: 0, character: 16 });
    expect(scripts.libraryItems('actions', 'SharedActions')[0].namePosition).toEqual({ file: library, line: 3, character: 21 });
    expect([...scripts.libraryItemUses(scripts.libraryItems('actions', 'SharedActions')[0])].sort()).toEqual(['input', 'shared']);
    expect([...scripts.cueVariableUses('Api', 'Counting')].sort()).toEqual(['tally', 'total']);
  });

  it('finds a cue in every script and renames it everywhere', () => {
    const expected = [
      place(api, 2, 'Register'),
      place(api, 5, 'Register'),
      place(api, 6, 'Register'),
      place(user, 4, 'Register'),
      place(user, 5, 'Register'),
    ].sort();
    expect(references(api, 2, 'Register')).toEqual(expected);
    expect(references(user, 4, 'Register')).toEqual(expected);
    const { analysis, offset } = at(user, 5, 'Register');
    expect(prepareRenameAt(analysis, offset, withIndex, options)).toMatchObject({ placeholder: 'Register', range: { start: { line: 5 } } });
    expect(rename(user, 4, 'Register', 'Enrol')).toEqual(expected.map((found) => `${found}=Enrol`));
  });

  it('tells in the hover how often other files name a cue, a script or a library item', () => {
    const hoverText = (file: string, line: number, needle: string): string => {
      const { analysis, offset } = at(file, line, needle);
      const found = hoverAt(analysis, offset, withIndex);
      return found && typeof found.contents === 'object' && 'value' in found.contents ? found.contents.value : '';
    };
    expect(hoverText(api, 2, 'Register')).toContain('Referenced 2 times here, 2 times in 1 other file');
    expect(hoverText(user, 4, 'Register')).toContain('Referenced 1 time in 1 other file');
    expect(hoverText(user, 4, 'Api')).toContain('Referenced 1 time in 1 other file');
    expect(hoverText(library, 3, 'SharedActions')).toContain('Referenced 0 times here, 1 time in 1 other file');
    expect(hoverText(base, 2, 'Core')).toContain('Referenced 0 times here, 1 time in 1 other file');
  });

  it('takes a side of a patch comparison for the file it shows', () => {
    // The side with a patch that adds a cue before Register: the file's places are the side's, one line down.
    const text = (texts.get(api) ?? '').replace('  <cues>\n', '  <cues>\n    <cue name="Added"/>\n');
    const document = TextDocument.create('x4codesense-patched:/api.xml?patch%3Dfile%253A%252F%252F%252Fpatch.xml', 'xml', 1, text);
    const sideContext = { schemas: game.schemas, properties: game.properties, index: scripts };
    const side = analyzeComparisonSide(document, 'after', api, sideContext);
    const offset = side.document.offsetAt({ line: 3, character: text.split('\n')[3].indexOf('Register') + 1 });
    const hover = hoverAt(side, offset, withIndex);
    expect(hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '').toContain(
      'Referenced 2 times here, 2 times in 1 other file'
    );
    const down = (found: string): string => found.replace(/^api\.xml:(\d+)/, (_all, line: string) => `api.xml:${Number(line) + 1}`);
    const expected = [place(api, 2, 'Register'), place(api, 5, 'Register'), place(api, 6, 'Register')].map(down);
    expect(places(referencesAt(side, offset, withIndex))).toEqual([...expected, place(user, 4, 'Register'), place(user, 5, 'Register')].sort());
    // Under its own uri, the file's places would be another file's.
    const alone = analyzeComparisonSide(document, 'after', undefined, sideContext);
    const aloneHover = hoverAt(alone, offset, withIndex);
    expect(aloneHover && typeof aloneHover.contents === 'object' && 'value' in aloneHover.contents ? aloneHover.contents.value : '').toContain(
      'Referenced 2 times here, 3 times in 2 other files'
    );
  });

  it('renames a variable of a cue written md.Script.Cue.$x in other scripts', () => {
    const expected = [place(api, 4, '$count'), place(api, 6, '$count'), place(user, 5, '$count')].sort();
    expect(references(user, 5, '$count')).toEqual(expected);
    expect(references(api, 4, '$count')).toEqual(expected);
    expect(rename(api, 4, '$count', 'number')).toEqual(expected.map((found) => `${found}=$number`));
  });

  it('renames a Mission Director script wherever md.Script names it', () => {
    const expected = [place(api, 0, 'Api'), place(api, 6, 'Api'), place(user, 4, 'Api'), place(user, 5, 'Api'), place(user, 7, 'Api')].sort();
    expect(references(user, 7, 'Api')).toEqual(expected);
    expect(references(api, 0, 'Api')).toEqual(expected);
    const { analysis, offset } = at(api, 0, 'Api');
    expect(prepareRenameAt(analysis, offset, withIndex, options)).toMatchObject({ placeholder: 'Api', range: { start: { line: 0, character: 16 } } });
    expect(rename(user, 5, 'Api', 'Service')).toEqual(expected.map((found) => `${found}=Service`));
  });

  it('renames an interrupt library item in every AI script', () => {
    const expected = [place(library, 3, 'SharedActions'), place(order, 4, 'SharedActions')].sort();
    expect(references(order, 4, 'SharedActions')).toEqual(expected);
    expect(rename(library, 3, 'SharedActions', 'Common')).toEqual(expected.map((found) => `${found}=Common`));
  });

  it('refuses a rename it cannot carry out everywhere', () => {
    // A cue of the game is found, but not renamed.
    expect(references(user, 5, 'Core')).toEqual([place(base, 2, 'Core'), place(user, 5, 'Core')].sort());
    expect(refusal(user, 5, 'Core')).toBe('cue Core of Base is also written in base.xml of the game, which cannot be renamed');
    expect(refusal(api, 2, 'Register', { editableFolders: [path.join(workspace, 'api_mod')] })).toBe(
      'cue Register of Api is also written in user.xml (user_mod), outside the workspace'
    );
    expect(refusal(api, 2, 'Register', {})).toContain('outside the workspace');
    expect(refusal(order, 5, '$shared')).toBe('$shared is also set by interrupt actions SharedActions in lib.shared.xml, which a rename here does not change');
    expect(refusal(order, 3, '$input')).toBe('$input is also used by interrupt actions SharedActions in lib.shared.xml, which a rename here does not change');
    expect(refusal(library, 4, '$input')).toBe(
      '$input is used in the interrupt library, which runs in the scripts that use it, such as the one using actions SharedActions'
    );
    expect(refusal(user, 6, '$tally')).toBe('$tally is also used by library Counting of Api, included here, which a rename here does not change');
    expect(refusal(api, 11, '$tally')).toBe('$tally is in library Counting, whose variables scripts elsewhere set');
    // Without such ties a variable renames as before.
    expect(refusal(order, 5, '$local')).toBeUndefined();
    expect(rename(order, 5, '$local', '$mine')).toEqual([`${place(order, 5, '$local')}=$mine`]);
  });

  it('works while a script is being typed', () => {
    const typing = add(path.join(workspace, 'user_mod', 'md', 'typing.xml'), 'user_mod', [
      '<mdscript name="Typing">',
      '  <cues>',
      '    <cue name="T">',
      '      <actions>',
      '        <signal_cue_instantly cue="md.Api.Register',
    ]);
    const everywhere = [
      place(api, 2, 'Register'),
      place(api, 5, 'Register'),
      place(api, 6, 'Register'),
      place(user, 4, 'Register'),
      place(user, 5, 'Register'),
      place(typing, 4, 'Register'),
    ].sort();
    expect(references(typing, 4, 'Register')).toEqual(everywhere);
    expect(references(api, 2, 'Register')).toEqual(everywhere);
    expect(rename(typing, 4, 'Register', 'Enrol')).toEqual(everywhere.map((found) => `${found}=Enrol`));
    scripts.removeFile(typing);
  });

  it('refuses when a script is defined twice or a file changed since it was indexed', () => {
    const twice = add(path.join(workspace, 'other_mod', 'md', 'api.xml'), 'other_mod', ['<mdscript name="Api">', '  <cues/>', '</mdscript>']);
    expect(refusal(user, 4, 'Register')).toBe(
      'Mission Director script Api is defined 2 times (api.xml, api.xml): its references cannot tell which one they mean'
    );
    scripts.removeFile(twice);
    const unsaved = path.join(workspace, 'user_mod', 'md', 'gone.xml');
    const text =
      '<mdscript name="Gone">\n  <cues>\n    <cue name="G">\n      <actions>\n        <cancel_cue cue="md.Api.Register"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    scripts.setText(unsaved, text, 'user_mod');
    expect(refusal(user, 4, 'Register')).toBe('gone.xml changed since it was indexed; save it and try again');
    scripts.removeFile(unsaved);
    expect(refusal(user, 4, 'Register')).toBeUndefined();
  });
});
