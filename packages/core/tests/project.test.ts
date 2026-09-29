import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData, loadScriptIndex, parseXml, ScriptIndex } from '../src';

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
