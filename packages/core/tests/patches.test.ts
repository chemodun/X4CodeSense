import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Range } from 'vscode-languageserver-types';
import {
  afterEarlier,
  analyzeText,
  attributeNamed,
  comparePatch,
  completionAt,
  definitionAt,
  documentTree,
  evaluateXPath,
  hoverAt,
  loadGameData,
  loadScriptIndex,
  mergeFile,
  parseXml,
  parseXPath,
  prepareRenameAt,
  referencesAt,
  renameAt,
  scriptFolders,
  sourceRange,
  sourcesOf,
  type AnalysisContext,
  type DocumentAnalysis,
  type PatchNode,
  type PatchSource,
} from '../src';

const fixtures = fileURLToPath(new URL('./fixtures/patches', import.meta.url));
const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const gameFolder = path.join(fixtures, 'game');
const modsFolder = path.join(fixtures, 'mods');
const game = loadGameData(unpacked);
const index = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
const context: AnalysisContext = { schemas: game.schemas, properties: game.properties, index };

const setup = path.join(gameFolder, 'md', 'setup.xml');
const api = path.join(modsFolder, 'base_mod', 'md', 'api.xml');
const earlyPatch = path.join(modsFolder, 'early_mod', 'md', 'setup.xml');
const latePatch = path.join(modsFolder, 'late_mod', 'md', 'setup.xml');
const misplacedPatch = path.join(modsFolder, 'late_mod', 'md', 'api.xml');
const nestedPatch = path.join(modsFolder, 'late_mod', 'extensions', 'base_mod', 'md', 'api.xml');
const absentPatch = path.join(modsFolder, 'late_mod', 'extensions', 'absent_mod', 'md', 'gone.xml');

const relative = (file: string): string => path.relative(fixtures, file).replace(/\\/g, '/');

function analyzeFile(file: string, text = readFileSync(file, 'utf8'), withContext: AnalysisContext = context): DocumentAnalysis {
  return analyzeText(text, withContext, pathToFileURL(file).toString());
}

/** `line severity code: message` of each diagnostic. */
function report(analysis: DocumentAnalysis): string[] {
  return analysis.diagnostics.map((diagnostic) => `${diagnostic.range.start.line + 1} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
}

/** The text a diagnostic's range covers. */
function covered(analysis: DocumentAnalysis, code: string): string[] {
  return analysis.diagnostics.filter((diagnostic) => diagnostic.code === code).map((diagnostic) => analysis.document.getText(diagnostic.range));
}

function cueNames(document: PatchNode | undefined): string[] {
  return document
    ? evaluateXPath(parseXPath('//cue'), document).map((selection) => (selection.kind === 'node' ? (selection.node.attribute('name') ?? '') : ''))
    : [];
}

describe('patch targets', () => {
  it('lists the patch folders of extensions with the folders they patch', () => {
    const folders = scriptFolders(gameFolder, [modsFolder]).map(
      (folder) =>
        `${relative(folder.folder)} ${folder.source}${folder.patches ? ` -> ${folder.patches.name}${folder.patches.folder ? ` at ${relative(folder.patches.folder)}` : ''}` : ''}`
    );
    expect(folders).toEqual([
      'game/md game',
      'game/aiscripts game',
      'game/libraries game',
      'mods/base_mod/md ws_12345 -> md at game/md',
      'mods/base_mod/aiscripts ws_12345 -> aiscripts at game/aiscripts',
      'mods/base_mod/libraries ws_12345 -> libraries at game/libraries',
      'mods/early_mod/md early_mod -> md at game/md',
      'mods/early_mod/aiscripts early_mod -> aiscripts at game/aiscripts',
      'mods/early_mod/libraries early_mod -> libraries at game/libraries',
      'mods/late_mod/md late_mod -> md at game/md',
      'mods/late_mod/aiscripts late_mod -> aiscripts at game/aiscripts',
      'mods/late_mod/libraries late_mod -> libraries at game/libraries',
      'mods/late_mod/extensions/absent_mod/md late_mod -> extensions/absent_mod/md',
      'mods/late_mod/extensions/base_mod/md late_mod -> extensions/base_mod/md at mods/base_mod/md',
    ]);
  });

  it('tells the DLCs from the other extensions', () => {
    const folders = [
      { folder: path.join(gameFolder, 'md'), source: 'game' },
      { folder: path.join(gameFolder, 'extensions', 'ego_dlc_a', 'md'), source: 'ego_dlc_a', bundled: true },
      { folder: path.join(gameFolder, 'extensions', 'ego_dlc_a', 'aiscripts'), source: 'ego_dlc_a', bundled: true },
      { folder: path.join(modsFolder, 'base_mod', 'md'), source: 'ws_12345' },
      { folder: path.join(modsFolder, 'late_mod', 'extensions', 'base_mod', 'md'), source: 'late_mod' },
      // An installed game's extensions folder holds mods as well.
      { folder: path.join(gameFolder, 'extensions', 'near', 'md'), source: 'near' },
    ];
    expect(sourcesOf(folders)).toEqual({ dlcs: ['ego_dlc_a'], extensions: ['ws_12345', 'late_mod', 'near'] });
    expect(sourcesOf(scriptFolders(gameFolder, [modsFolder]))).toEqual({ dlcs: [], extensions: ['ws_12345', 'early_mod', 'late_mod'] });
  });

  it('ties a patch to the file it changes, or tells why there is none', () => {
    expect(index.patchTarget(latePatch)).toEqual({ file: setup, name: 'md/setup.xml' });
    expect(index.patchTarget(nestedPatch)).toEqual({ file: api, name: 'extensions/base_mod/md/api.xml' });
    expect(index.patchTarget(misplacedPatch)).toEqual({ name: 'md/api.xml', missing: 'the game has no md/api.xml' });
    expect(index.patchTarget(absentPatch)).toEqual({
      name: 'extensions/absent_mod/md/gone.xml',
      missing: "the extension 'absent_mod' is not among the extensions read",
    });
    expect(index.patchTarget(setup)).toBeUndefined();
  });

  it('knows the patches of a file in load order, and what they add', () => {
    expect(index.patchesOf(setup).map((patch) => patch.source)).toEqual(['early_mod', 'late_mod']);
    expect(index.patchesBefore(latePatch, setup).map((patch) => relative(patch.file))).toEqual(['mods/early_mod/md/setup.xml']);
    expect(index.patchesBefore(earlyPatch, setup)).toEqual([]);
    const script = index.scripts('md', 'Setup')[0];
    expect(index.cuesOf(script).map((cue) => `${cue.name}${cue.patch ? ` (${relative(cue.patch)})` : ''}`)).toEqual([
      'Start',
      'Later',
      'Early (mods/early_mod/md/setup.xml)',
      'Late (mods/late_mod/md/setup.xml)',
    ]);
    // A top-level patch changes the game's file only, never an extension's file of the same name.
    expect(index.patchesOf(api).map((patch) => relative(patch.file))).toEqual(['mods/late_mod/extensions/base_mod/md/api.xml']);
  });
});

describe('patch analysis', () => {
  const late = analyzeFile(latePatch);

  it('applies the earlier patches, then each operation in order', () => {
    const patch = late.patch;
    expect(patch?.earlier.map(relative)).toEqual(['mods/early_mod/md/setup.xml']);
    expect(patch?.operations.map((operation) => `${operation.kind} ${operation.status}`)).toEqual([
      'add applied',
      'replace applied',
      'replace applied',
      'add applied',
      'remove no-match',
      'remove no-match',
      'add skipped',
      'remove several-matches',
      'replace invalid',
    ]);
    expect(patch?.operations[4].matchingSteps).toBe(4);
    expect(patch?.operations[7].matches).toBe(4);
    const document = patch?.document;
    expect(cueNames(document)).toEqual(['Start', 'Later', 'Early', 'Late']);
    const values = document
      ? evaluateXPath(parseXPath('//set_value'), document).map((selection) =>
          selection.kind === 'node' ? `${selection.node.attribute('name')}=${selection.node.attribute('exact')}` : ''
        )
      : [];
    expect(values).toEqual(['$count=2', '$a=1', '$b=2', "$mode='easy'"]);
    expect(document && evaluateXPath(parseXPath("//cue[@name='Later']/@instantiate"), document).length).toBe(1);
  });

  it('reports what the game would log, at the step or the operation concerned', () => {
    expect(report(late)).toEqual([
      "13 1 patch-no-match: No matching node in md/setup.xml after 1 earlier patch: 'set_value[@name='$gone']' selects nothing",
      "14 3 patch-no-match: No matching node in md/setup.xml after 1 earlier patch: 'cue[@name='Missing']' selects nothing (silent)",
      '18 1 patch-several-matches: Multiple matching nodes in md/setup.xml after 1 earlier patch: the path selects 4, an operation needs exactly one',
      '19 1 patch-invalid-operation: Cannot replace the root element: the game skips this operation',
    ]);
    expect(covered(late, 'patch-no-match')).toEqual(["/set_value[@name='$gone']", "//cue[@name='Missing']"]);
  });

  it('reports a patch with nothing to patch, and where a patch of an extension file goes', () => {
    expect(report(analyzeFile(misplacedPatch))).toEqual([
      "3 2 patch-target-missing: Nothing to patch: the game has no md/api.xml; a patch of base_mod's file goes to extensions/base_mod/md/api.xml",
    ]);
    expect(report(analyzeFile(absentPatch))).toEqual([
      "3 2 patch-target-missing: Nothing to patch: the extension 'absent_mod' is not among the extensions read",
    ]);
    const nested = analyzeFile(nestedPatch);
    expect(report(nested)).toEqual([]);
    expect(nested.patch?.target.file).toBe(api);
    expect(nested.patch?.operations.map((operation) => operation.status)).toEqual(['applied']);
  });

  it('follows the editor text of the target', () => {
    const edited = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const text = readFileSync(setup, 'utf8').replace('<cue name="Later" />', '');
    edited.setStructure(setup, text, parseXml(text), 'game', true);
    const analysis = analyzeFile(latePatch, undefined, { ...context, index: edited });
    expect(analysis.patch?.operations[3].status).toBe('no-match');
  });
});

/** The diagnostics of a patched target's analysis that lie in the patch's pieces, as `start-end code: message`. */
function mappedFindings(analysis: DocumentAnalysis, target: DocumentAnalysis): string[] {
  const patch = analysis.patch;
  const written = patch?.patched?.written;
  if (!patch || !written) {
    return [];
  }
  return target.diagnostics
    .slice(target.structure?.problems.length ?? 0)
    .flatMap((diagnostic) => {
      const range = sourceRange(written, patch.source, target.document.offsetAt(diagnostic.range.start), target.document.offsetAt(diagnostic.range.end));
      return range ? [`${range.start}-${range.end} ${String(diagnostic.code)}: ${diagnostic.message}`] : [];
    })
    .sort();
}

describe('what a patch brings in, checked where it lands', () => {
  const full = readFileSync(latePatch, 'utf8');
  const late = analyzeFile(latePatch, full);
  const withMistakes = full
    .replace('<cue name="Late" />', '<cue name="Late" bogus="1"><actions><set_value name="$c" exact="1 +" /><wrong /></actions></cue>')
    .replace('@exact">2</replace>', '@exact">2 +</replace>')
    .replace('<set_value name="$a" exact="1" />', '<set_value name="$a" exact="$count + $nothing" />')
    .replace('type="@instantiate"', 'type="@instantiat"');

  it('writes the patched target out, each piece tied to its file', () => {
    const patch = late.patch;
    const written = patch?.patched?.written;
    expect(written && parseXml(written.text).problems).toEqual([]);
    const back = (text: string, part = text): string => {
      const start = (written?.text.indexOf(text) ?? -1) + text.indexOf(part);
      const range = written && patch ? sourceRange(written, patch.source, start, start + part.length) : undefined;
      return range ? full.slice(range.start, range.end) : '';
    };
    expect(back('<cue name="Late" />')).toBe('<cue name="Late" />');
    expect(back('<set_value name="$b" exact="2" />')).toBe('<set_value name="$b" exact="2" />');
    // A value set by `replace .../@exact`, and an attribute added with `type="@instantiate"`: name and value.
    expect(back('exact="2"/>', '2')).toBe('2');
    expect(back('instantiate="true"', 'instantiate')).toBe('instantiate');
    expect(back('instantiate="true"', 'true')).toBe('true');
    // The target's own text is no piece of the patch.
    expect(back('<cue name="Start">')).toBe('');
  });

  it('reports what is wrong in the pieces of the patch, at their place', () => {
    const analysis = analyzeFile(latePatch, withMistakes);
    const own = new Set(report(late));
    expect(report(analysis).filter((line) => !own.has(line))).toEqual([
      // The inserted cue brings a fifth `set_value`.
      '18 1 patch-several-matches: Multiple matching nodes in md/setup.xml after 1 earlier patch: the path selects 5, an operation needs exactly one',
      "12 1 unknown-attribute: Unknown attribute 'instantiat' in 'cue'",
      "5 1 unknown-attribute: Unknown attribute 'bogus' in 'cue'",
      "5 1 unknown-element: Unknown element 'wrong' in 'actions'",
      '7 1 expression-syntax: Expression expected',
      '5 1 expression-syntax: Expression expected',
      // Content that lands in the target's cue sees its variables: `$count` is set there, `$nothing` nowhere.
      "9 2 variable-undefined: Variable '$nothing' is never set in cue 'Start'",
    ]);
    expect(covered(analysis, 'unknown-attribute')).toEqual(['instantiat', 'bogus']);
    expect(covered(analysis, 'unknown-element')).toEqual(['wrong']);
    // After the `+`: in the text of `replace .../@exact`, and in the inserted cue.
    expect(
      analysis.diagnostics
        .filter((diagnostic) => diagnostic.code === 'expression-syntax')
        .map((diagnostic) => analysis.document.offsetAt(diagnostic.range.start))
    ).toEqual([withMistakes.indexOf('2 +</replace>') + 3, withMistakes.indexOf('exact="1 +"') + 10]);
    expect(covered(analysis, 'variable-undefined')).toEqual(['$nothing']);
  });

  it('leaves out what the target and earlier patches get wrong', () => {
    const edited = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const target = readFileSync(setup, 'utf8').replace('<cue name="Start">', '<cue name="Start" bogus="1">');
    edited.setStructure(setup, target, parseXml(target), 'game', true);
    const early = readFileSync(earlyPatch, 'utf8').replace('<cue name="Early" />', '<cue name="Early" wrong="1" />');
    edited.setStructure(earlyPatch, early, parseXml(early), 'early_mod', true);
    expect(report(analyzeFile(latePatch, undefined, { ...context, index: edited }))).toEqual(report(late));
  });

  it('checks only where the pieces are, and finds there what a check of the whole target finds', () => {
    const analysis = analyzeFile(latePatch, withMistakes);
    const patched = analysis.patch?.patched;
    expect(patched).toBeDefined();
    const whole = analyzeText(patched?.written.text ?? '', context, pathToFileURL(setup).toString());
    expect(mappedFindings(analysis, patched?.analysis ?? whole)).toEqual(mappedFindings(analysis, whole));
  });
});

describe('editor features in patches', () => {
  // The fixture game's scripts are the game a rename must leave alone.
  const data = { ...game, index, folder: gameFolder };
  const editable = { editableFolders: [modsFolder] };
  const full = readFileSync(latePatch, 'utf8');
  const late = analyzeFile(latePatch, full);
  const reading = full.replace('<set_value name="$a" exact="1" />', '<set_value name="$a" exact="$count + 1" />');
  const withRead = analyzeFile(latePatch, reading);
  const at = (text: string, needle: string, delta = 0): number => text.indexOf(needle) + delta;
  const hoverText = (analysis: DocumentAnalysis, offset: number): string => {
    const found = hoverAt(analysis, offset, data)?.contents;
    return found && typeof found === 'object' && 'value' in found ? found.value : '';
  };
  const place = (location: { uri: string; range: { start: { line: number; character: number } } }): string =>
    `${relative(fileURLToPath(location.uri))}:${location.range.start.line}:${location.range.start.character}`;
  const labels = (analysis: DocumentAnalysis, offset: number): string[] => completionAt(analysis, offset, data).map((item) => item.label);
  const edits = (edit: ReturnType<typeof renameAt>): string[] =>
    edit && 'changes' in edit
      ? Object.entries(edit.changes ?? {}).flatMap(([uri, changes]) => changes.map((change) => `${place({ uri, range: change.range })} ${change.newText}`))
      : [String(edit && 'refused' in edit ? edit.refused : edit)];

  it('hovers what the content brings in as it is where it lands', () => {
    const offset = at(full, '<set_value name="$b"', 3);
    const found = hoverAt(late, offset, data);
    expect(hoverText(late, offset)).toContain('Sets a variable');
    expect(found?.range && late.document.getText(found.range)).toBe('set_value');
    // A variable of the target's cue, set in the target: the line is the target's.
    expect(hoverText(withRead, at(reading, '$count + 1', 2))).toContain('First set in \\<set\\_value\\> at line 7 of setup.xml');
    // The attribute `type` adds, as the element the operation selects declares it.
    expect(hoverText(late, at(full, '@instantiate', 3))).toContain('**instantiate** of \\<cue\\>');
  });

  it('goes from the content to the files the patched target is written in', () => {
    const target = readFileSync(setup, 'utf8').split('\n');
    const line = target.findIndex((text) => text.includes('name="$count"'));
    expect(definitionAt(withRead, at(reading, '$count + 1', 2), data).map(place)).toEqual([`game/md/setup.xml:${line}:${target[line].indexOf('$count')}`]);
    expect(definitionAt(late, at(full, 'name="$b"', 7), data).map(place)).toEqual([`mods/late_mod/md/setup.xml:9:21`]);
    const selecting = reading.split('\n').findIndex((text) => text.includes("set_value[@name='$count']"));
    expect(referencesAt(withRead, at(reading, '$count + 1', 2), data).map(place)).toEqual([
      'mods/late_mod/md/setup.xml:8:32',
      `game/md/setup.xml:${line}:${target[line].indexOf('$count')}`,
      // The path of the patch's `replace` selects the `set_value` by the variable's name.
      `mods/late_mod/md/setup.xml:${selecting}:${reading.split('\n')[selecting].indexOf("$count'")}`,
    ]);
  });

  it('completes the content as it is where it lands', () => {
    // A variable of the target's cue, and the edit in the patch.
    const typing = full.replace('<set_value name="$b" exact="2" />', '<set_value name="$b" exact="$" />');
    const analysis = analyzeFile(latePatch, typing);
    const offset = at(typing, 'exact="$"', 8);
    const items = completionAt(analysis, offset, data);
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining(['$count', '$mode']));
    const edit = items.find((item) => item.label === '$count')?.textEdit;
    expect(edit && 'range' in edit ? analysis.document.getText(edit.range) : '').toBe('$');
    // Attributes where one is being added to an element of the content.
    const attributes = full.replace('<set_value name="$b" exact="2" />', '<set_value ');
    expect(labels(analyzeFile(latePatch, attributes), at(attributes, '<set_value \n', 11))).toEqual(expect.arrayContaining(['name', 'exact']));
  });

  it('completes an element right after a bare < where the content lands', () => {
    const intoCues = readFileSync(earlyPatch, 'utf8').replace('<cue name="Early" />', '<cue name="Early" />\n    <');
    const analysis = analyzeFile(earlyPatch, intoCues);
    expect(labels(analysis, at(intoCues, '\n    <\n', 6))).toEqual(expect.arrayContaining(['cue', 'library']));
    const intoActions = full.replace('<set_value name="$b" exact="2" />', '<set_value name="$b" exact="2" />\n    <');
    const actions = labels(analyzeFile(latePatch, intoActions), at(intoActions, '\n    <\n', 6));
    expect(actions).toEqual(expect.arrayContaining(['set_value', 'signal_cue_instantly']));
    expect(actions).not.toContain('cue');
  });

  it('tells what a path selects as its operation finds the target, and goes there', () => {
    expect(hoverText(late, at(full, "[@name='Early']", 9))).toBe(
      '**cue\\[@name=\'Early\'\\]**\n\nSelects 1 node:\n\n- `<cue name="Early">` · added by the patch of `early_mod`, line 5'
    );
    expect(hoverText(late, at(full, "set_value[@name='$count']", 2))).toContain(
      'Selects 1 node up to here:\n\n- `<set_value name="$count">` · setup.xml, line 7'
    );
    // The comment the third operation replaces is still there for it.
    expect(hoverText(late, at(full, 'comment()', 2))).toContain('- `<!-- patchmarker -->` · setup.xml, line 8');
    expect(hoverText(late, at(full, "if=\"//cue[@name='Missing']", 8))).toBe("**cue\\[@name='Missing'\\]**\n\nSelects nothing");
    expect(definitionAt(late, at(full, "[@name='Early']", 9), data).map(place)).toEqual(['mods/early_mod/md/setup.xml:4:5']);
    expect(definitionAt(late, at(full, '@instantiate', 3), data)).toHaveLength(1);
  });

  it('completes a path from what it selects', () => {
    expect(labels(late, at(full, "//cue[@name='Early']", 13))).toEqual(['Start', 'Later', 'Early']);
    expect(labels(late, at(full, "//cue[@name='Early']", 7))).toEqual(['name']);
    expect(labels(late, at(full, "//cue[@name='Early']", 2))).toEqual(['mdscript', 'cues', 'cue', 'actions', 'set_value', 'comment()']);
    expect(labels(late, at(full, "/actions/set_value[@name='$count']", 9))).toEqual(['set_value', 'comment()']);
    expect(labels(late, at(full, '/@exact', 2))).toEqual(['name', 'exact']);
    // The attributes `type` may add: not the ones the element has.
    const typing = full.replace('type="@instantiate"', 'type="@inst"');
    const typed = labels(analyzeFile(latePatch, typing), at(typing, '@inst"', 5));
    expect(typed).toContain('instantiate');
    expect(typed).not.toContain('name');
  });

  it('finds and renames a cue through the paths that select it', () => {
    const offset = at(full, "[@name='Early']", 9);
    expect(referencesAt(late, offset, data).map(place)).toEqual(['mods/late_mod/md/setup.xml:3:25', 'mods/early_mod/md/setup.xml:4:15']);
    expect(prepareRenameAt(late, offset, data, editable)).toMatchObject({ placeholder: 'Early' });
    expect(edits(renameAt(late, offset, 'First', data, editable))).toEqual(['mods/late_mod/md/setup.xml:3:25 First', 'mods/early_mod/md/setup.xml:4:15 First']);
    expect(edits(renameAt(late, offset, 'First', data))).toEqual(['cue Early of Setup is also written in setup.xml (early_mod), outside the workspace']);
    expect(edits(renameAt(late, at(full, "[@name='Start']", 9), 'Begin', data, editable))).toEqual([
      'cue Start of Setup is also written in setup.xml of the game, which cannot be renamed',
    ]);
    // A cue the patch replaces is gone from the patched text, not from the target's file.
    const replacing = full.replace(
      `<add sel="//cue[@name='Later']" type="@instantiate">true</add>`,
      `<replace sel="//cue[@name='Later']"><cue name="Later2" /></replace>`
    );
    const lines = { patch: replacing.split('\n'), target: readFileSync(setup, 'utf8').split('\n') };
    const patchLine = lines.patch.findIndex((line) => line.includes('<replace sel="//cue[@name=\'Later\']"'));
    const targetLine = lines.target.findIndex((line) => line.includes('<cue name="Later"'));
    expect(referencesAt(analyzeFile(latePatch, replacing), at(replacing, "[@name='Later']", 9), data).map(place)).toEqual([
      `mods/late_mod/md/setup.xml:${patchLine}:${lines.patch[patchLine].indexOf('Later')}`,
      `game/md/setup.xml:${targetLine}:${lines.target[targetLine].indexOf('Later')}`,
    ]);
    // From the script: the path of the patch that selects the cue is renamed with it.
    const script = analyzeFile(api);
    const text = script.document.getText();
    expect(index.cueReferences('Api', 'Register').map((reference) => `${relative(reference.position.file)}:${reference.position.line}`)).toEqual([
      'mods/late_mod/extensions/base_mod/md/api.xml:3',
    ]);
    expect(hoverText(script, at(text, 'Register', 2))).toContain('Referenced 0 times here, 1 time in 1 other file');
    expect(edits(renameAt(script, at(text, 'Register', 2), 'Enrol', data, editable))).toEqual([
      'mods/base_mod/md/api.xml:4:15 Enrol',
      'mods/late_mod/extensions/base_mod/md/api.xml:3:25 Enrol',
    ]);
  });

  it('finds and renames an interrupt library item through the paths that select it', () => {
    // An AI script of the game's folder and a patch of it, both as an editor has them.
    const scripts = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const library = path.join(gameFolder, 'aiscripts', 'lib.shared.xml');
    const libraryText = [
      '<aiscript name="lib.shared">',
      '  <interrupts>',
      '    <library>',
      '      <actions name="SharedActions">',
      '        <set_value name="$shared" exact="1"/>',
      '      </actions>',
      '    </library>',
      '  </interrupts>',
      '  <attention min="unknown">',
      '    <actions>',
      '      <include_interrupt_actions ref="SharedActions"/>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
    ].join('\n');
    const patch = path.join(modsFolder, 'late_mod', 'aiscripts', 'lib.shared.xml');
    const patchText = `<diff>\n  <add sel="//library/actions[@name='SharedActions']">\n    <set_value name="$more" exact="2"/>\n  </add>\n</diff>\n`;
    scripts.setStructure(library, libraryText, parseXml(libraryText), 'game', true);
    scripts.setStructure(patch, patchText, parseXml(patchText), 'late_mod', true);
    const withScripts = { ...data, index: scripts };
    const analysis = analyzeFile(patch, patchText, { ...context, index: scripts });
    expect(analysis.patch?.operations.map((operation) => operation.status)).toEqual(['applied']);
    const offset = at(patchText, "'SharedActions'", 2);
    expect(referencesAt(analysis, offset, withScripts).map(place)).toEqual([
      'mods/late_mod/aiscripts/lib.shared.xml:1:37',
      'game/aiscripts/lib.shared.xml:3:21',
      'game/aiscripts/lib.shared.xml:10:38',
    ]);
    expect(edits(renameAt(analysis, offset, 'Shared', withScripts, editable))).toEqual([
      'interrupt actions SharedActions is also written in lib.shared.xml of the game, which cannot be renamed',
    ]);
    // The patch's path is one of the item's references.
    expect(scripts.libraryReferences('actions', 'SharedActions').map((reference) => relative(reference.position.file))).toEqual([
      'game/aiscripts/lib.shared.xml',
      'mods/late_mod/aiscripts/lib.shared.xml',
    ]);
  });

  it('finds an order that what a patch brings in names, where it lands', () => {
    const scripts = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const target = path.join(gameFolder, 'aiscripts', 'order.go.xml');
    const targetText = [
      '<aiscript name="order.go">',
      '  <order id="Go"/>',
      '  <attention min="unknown">',
      '    <actions>',
      '      <create_order object="this.ship" id="\'Go\'"/>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
    ].join('\n');
    const patch = path.join(modsFolder, 'late_mod', 'aiscripts', 'order.go.xml');
    const patchText = `<diff>\n  <add sel="//attention/actions">\n    <create_order object="this.ship" id="'Go'"/>\n  </add>\n</diff>\n`;
    scripts.setStructure(target, targetText, parseXml(targetText), 'game', true);
    scripts.setStructure(patch, patchText, parseXml(patchText), 'late_mod', true);
    const withScripts = { ...data, index: scripts };
    const analysis = analyzeFile(patch, patchText, { ...context, index: scripts });
    expect(analysis.patch?.operations.map((operation) => operation.status)).toEqual(['applied']);
    const offset = at(patchText, "'Go'", 2);
    expect(referencesAt(analysis, offset, withScripts).map(place)).toEqual([
      'mods/late_mod/aiscripts/order.go.xml:2:42',
      'game/aiscripts/order.go.xml:1:13',
      'game/aiscripts/order.go.xml:4:44',
    ]);
    expect(definitionAt(analysis, offset, withScripts).map(place)).toEqual(['game/aiscripts/order.go.xml:1:13']);
    const hover = hoverAt(analysis, offset, withScripts)?.contents;
    expect(hover && typeof hover === 'object' && 'value' in hover ? hover.value : '').toMatch(/^\*\*Go\*\* \*\(order of `order\.go`\)\*/);
    expect(analysis.diagnostics.filter((diagnostic) => diagnostic.code === 'order-undefined')).toEqual([]);

    // An order nothing defines, in what the patch brings in: reported in the patch, at the name.
    const unknown = patchText.replace("'Go'", "'Gone'");
    scripts.setStructure(patch, unknown, parseXml(unknown), 'late_mod', true);
    const reported = analyzeFile(patch, unknown, { ...context, index: scripts }).diagnostics.filter((diagnostic) => diagnostic.code === 'order-undefined');
    expect(reported.map((diagnostic) => `${diagnostic.range.start.line}:${diagnostic.range.start.character} ${diagnostic.message}`)).toEqual([
      "2:42 No order 'Gone' is known",
    ]);
  });

  it('renames what the content names where it lands, in the files it is written in', () => {
    expect(edits(renameAt(late, at(full, 'name="$b"', 8), 'bb', data, editable))).toEqual(['mods/late_mod/md/setup.xml:9:21 $bb']);
    expect(prepareRenameAt(late, at(full, 'name="Late"', 7), data, editable)).toMatchObject({ placeholder: 'Late' });
    expect(edits(renameAt(late, at(full, 'name="Late"', 7), 'Last', data, editable))).toEqual(['mods/late_mod/md/setup.xml:4:15 Last']);
    // Set in the game's cue: the game cannot be renamed.
    expect(prepareRenameAt(withRead, at(reading, '$count + 1', 2), data, editable)).toEqual({
      refused: '$count is also written in setup.xml of the game, which cannot be renamed',
    });
  });
});

describe('the target before and after a patch', () => {
  const target = readFileSync(setup, 'utf8');
  const withEarly = target.replace('<cue name="Later" />\n', '<cue name="Later" />\n    <cue name="Early" />\n');

  it('writes the target as its file has it, then with each change in place', () => {
    const early = comparePatch(analyzeFile(earlyPatch).patch!, index);
    expect(early).toMatchObject({ name: 'md/setup.xml', file: setup, before: target, after: withEarly });
    expect(early?.own.map((piece) => withEarly.slice(piece.start, piece.end))).toEqual(['<cue name="Early" />']);
    // Before: early_mod's patch applied. After: only the lines the patch changes differ; what it brings in
    // takes the column of what it replaces, a changed self-closing element stays so.
    const late = comparePatch(analyzeFile(latePatch).patch!, index);
    expect(late?.before).toBe(withEarly);
    expect(late?.after).toBe(
      withEarly
        .replace(
          '<set_value name="$count" exact="1" />\n        <!-- patchmarker -->\n',
          '<set_value name="$count" exact="2"/>\n        <set_value name="$a" exact="1" />\n        <set_value name="$b" exact="2" />\n'
        )
        .replace('<cue name="Later" />', '<cue name="Later" instantiate="true"/>')
        .replace('<cue name="Early" />\n', '<cue name="Early" />\n    <cue name="Late" />\n')
    );
  });

  it("keeps each line's own line break", () => {
    const edited = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const crlf = target.replace(/\n/g, '\r\n');
    edited.setStructure(setup, crlf, parseXml(crlf), 'game', true);
    const compared = comparePatch(analyzeFile(earlyPatch, undefined, { ...context, index: edited }).patch!, edited);
    expect(compared?.before).toBe(crlf);
    expect(compared?.after).toBe(crlf.replace('<cue name="Later" />\r\n', '<cue name="Later" />\r\n    <cue name="Early" />\n'));
  });

  it('keeps the start of the file: a byte order mark, the XML declaration, both or neither', () => {
    const body = target.slice(target.indexOf('<!--'));
    const declaration = target.slice(0, target.indexOf('<!--'));
    const byteOrderMark = String.fromCharCode(0xfeff);
    for (const start of ['', byteOrderMark, declaration, byteOrderMark + declaration]) {
      const edited = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
      edited.setStructure(setup, start + body, parseXml(start + body), 'game', true);
      const compared = comparePatch(analyzeFile(earlyPatch, undefined, { ...context, index: edited }).patch!, edited);
      expect(compared?.before, JSON.stringify(start)).toBe(start + body);
      expect(compared?.after, JSON.stringify(start)).toBe(start + body.replace('<cue name="Later" />\n', '<cue name="Later" />\n    <cue name="Early" />\n'));
    }
  });

  it('writes what a patch brings in at the column of what it replaces or goes into, its lines moved with it', () => {
    const text = [
      '<diff>',
      `  <replace sel="//cue[@name='Start']/actions/set_value[@name='$mode']">`,
      '    <do_any>',
      `      <set_value name="$mode" exact="'easy'" weight="75" />`,
      `      <set_value name="$mode" exact="'hard'`,
      `                  " weight="25" />`,
      '    </do_any>',
      '  </replace>',
      `  <add sel="//cue[@name='Later']">`,
      '      <actions />',
      '  </add>',
      '</diff>',
      '',
    ].join('\n');
    expect(comparePatch(analyzeFile(latePatch, text).patch!, index)?.after).toBe(
      withEarly
        .replace(
          `        <set_value name="$mode" exact="'easy'" />\n`,
          [
            '        <do_any>',
            `          <set_value name="$mode" exact="'easy'" weight="75" />`,
            `          <set_value name="$mode" exact="'hard'`,
            // Inside a value: as written.
            `                  " weight="25" />`,
            '        </do_any>',
            '',
          ].join('\n')
        )
        // Into an element with no children: one step deeper than it, its new end tag at its column.
        .replace('<cue name="Later" />', '<cue name="Later" >\n      <actions />\n    </cue>')
    );
  });

  it("tells where the patch's own text is in the text after it, for carets and typing there", () => {
    const text = readFileSync(latePatch, 'utf8');
    const late = comparePatch(analyzeFile(latePatch).patch!, index)!;
    // Not the names of the attributes the patch sets: they are copied from `sel` and `type`. What the side
    // shows at another column is one piece per line, after the indentation that differs.
    expect(late.own.map((piece) => late.after.slice(piece.start, piece.end))).toEqual([
      '2',
      '<set_value name="$a" exact="1" />',
      '\n',
      '<set_value name="$b" exact="2" />',
      'true',
      '<cue name="Late" />',
    ]);
    expect(late.own.map((piece) => piece.indent)).toEqual([
      undefined,
      { side: '        ', patch: '    ' },
      undefined,
      { side: '        ', patch: '    ' },
      undefined,
      undefined,
    ]);
    for (const piece of late.own) {
      expect(text.slice(piece.patchStart, piece.patchStart + piece.end - piece.start)).toBe(late.after.slice(piece.start, piece.end));
    }
    // Typing inside a piece is typing in the patch: the text after it is the text before with the same insert.
    const piece = late.own[5];
    const at = '<cue name="'.length;
    const typed = analyzeFile(latePatch, text.slice(0, piece.patchStart + at) + 'r' + text.slice(piece.patchStart + at));
    expect(comparePatch(typed.patch!, index)?.after).toBe(late.after.slice(0, piece.start + at) + 'r' + late.after.slice(piece.start + at));
  });

  it('has nothing to compare without a target file', () => {
    expect(comparePatch(analyzeFile(misplacedPatch).patch!, index)).toBeUndefined();
    expect(comparePatch(analyzeFile(absentPatch).patch!, index)).toBeUndefined();
  });
});

describe('patch documents without the index', () => {
  const text = [
    '<diff>',
    '  <add sel="//cue" pos="inside"/>',
    '  <replace/>',
    '  <insert sel="//cue"/>',
    `  <add sel="//cue[@name='a'" />`,
    '  <remove sel="//cue[count(cues) > 1]" />',
    '  <add sel="//cue" type="name">x</add>',
    `  <replace sel="//loadout/@ref[.='a' or.='b']">c</replace>`,
    '  <replace sel="//cue"><cue name="a"/><cue name="b"/></replace>',
    '  <remove sel="//cue" if="not(//cue[)" />',
    '</diff>',
  ].join('\n');

  it('checks the structure from diff.xsd and the paths with the XPath parser', () => {
    const analysis = analyzeText(text, { schemas: game.schemas });
    expect(analysis.patch).toBeUndefined();
    expect(report(analysis)).toEqual([
      "2 1 invalid-attribute-value: Invalid value 'inside' for attribute 'pos' in 'add'. Expected one of 'before', 'after', 'prepend'",
      "3 1 missing-required-attribute: Missing required attribute 'sel' in 'replace'",
      "4 1 unknown-element: Unknown element 'insert' in 'diff'",
      "7 1 invalid-attribute-value: Invalid value 'name' for attribute 'type' in 'add'. Expected a value of type 'type'",
      "5 1 patch-path-syntax: Predicate '[' is not closed",
      '6 3 patch-path-unsupported: The function count() is not understood by X4CodeSense; the game may accept it',
      "10 1 patch-path-syntax: Predicate '[' is not closed",
    ]);
    expect(covered(analysis, 'patch-path-syntax')).toEqual(["[@name='a'", '[']);
  });
});

describe('patches while typing', () => {
  const full = readFileSync(latePatch, 'utf8');

  it('never throws, and keeps the operations before the cut', () => {
    for (let cut = full.indexOf('<diff>') + '<diff>'.length; cut <= full.length; cut += 7) {
      const analysis = analyzeFile(latePatch, full.slice(0, cut));
      expect(analysis.patch?.target.file, `cut at ${cut}`).toBe(setup);
      const first = analysis.patch?.operations[0];
      if (cut > full.indexOf('</add>')) {
        expect(first?.status, `cut at ${cut}`).toBe('applied');
      }
      // Each well-formedness problem once: the patch document's own, none of the patched target's.
      const problems = analysis.structure?.problems ?? [];
      const codes = new Set<string>(problems.map((problem) => problem.code));
      expect(analysis.diagnostics.filter((diagnostic) => codes.has(String(diagnostic.code))).length, `cut at ${cut}`).toBe(problems.length);
    }
  });

  it('checks half-typed content where it lands, without taking in the nodes after it', () => {
    // Inserted after the cue Start, so the target's cue Later follows the half-typed elements.
    const typed = full.replace(
      `<add sel="//cue[@name='Early']" pos="after">\n    <cue name="Late" />`,
      `<add sel="//cue[@name='Start']" pos="after">\n    <cue name="Late"><actions><set_value name="$c" exa`
    );
    const analysis = analyzeFile(latePatch, typed);
    expect(analysis.patch?.operations[0].status).toBe('applied');
    const patched = analysis.patch?.patched?.analysis.structure;
    expect(patched?.problems.map((problem) => problem.code)).toEqual(['missing-attribute-value']);
    const later = patched?.elements.find((element) => element.name === 'cue' && attributeNamed(element, 'name')?.value === 'Later');
    expect(later?.parent?.name).toBe('cues');
    expect(covered(analysis, 'unknown-attribute')).toEqual(['exa']);
  });

  it('compares a half-typed patch with its target, which it leaves as it was before', () => {
    const before = comparePatch(analyzeFile(latePatch).patch!, index)?.before;
    for (let cut = full.indexOf('<diff>') + '<diff>'.length; cut <= full.length; cut += 7) {
      const analysis = analyzeFile(latePatch, full.slice(0, cut));
      const compared = analysis.patch && comparePatch(analysis.patch, index);
      expect(compared?.before, `cut at ${cut}`).toBe(before);
      expect(compared?.after.startsWith('<?xml'), `cut at ${cut}`).toBe(true);
    }
  });

  it('reports a half-typed path at the point where it stops', () => {
    const typed = full.replace(`sel="//cue[@name='Early']"`, `sel="//cue[@name='Ea`);
    const analysis = analyzeFile(latePatch, typed);
    expect(analysis.diagnostics.some((diagnostic) => diagnostic.code === 'patch-path-syntax')).toBe(true);
    expect(analysis.patch?.operations[0].status).toBe('unknown');
    // The later operations may depend on what the first one would have done: none is said to select nothing.
    expect(analysis.patch?.operations.filter((operation) => operation.status === 'no-match')).toEqual([]);
  });

  it('completes a half-typed path from what it selects so far', () => {
    const typed = full.replace(`sel="//cue[@name='Early']"`, `sel="//cue[@name='Ea`);
    const analysis = analyzeFile(latePatch, typed);
    const offset = typed.indexOf(`'Ea`) + 3;
    const items = completionAt(analysis, offset, { ...game, index });
    expect(items.map((item) => item.label)).toEqual(['Start', 'Later', 'Early']);
    const edit = items[2].textEdit;
    expect(edit && 'range' in edit ? analysis.document.getText(edit.range) : '').toBe('Ea');
  });

  it('answers the editor features anywhere in a patch without failing', () => {
    const data = { ...game, index };
    const cuts = [full.length, full.indexOf('<remove')];
    for (let cut = full.indexOf('<diff>'); cut < full.length; cut += 37) {
      cuts.push(cut);
    }
    for (const cut of cuts) {
      const text = full.slice(0, cut);
      const analysis = analyzeFile(latePatch, text);
      const document = analysis.document;
      // What is shown and replaced lies around the caret, also when it was found in the patched target.
      const around = (range: Range | undefined, offset: number): boolean =>
        range === undefined || (document.offsetAt(range.start) <= offset && offset <= document.offsetAt(range.end));
      for (let offset = 0; offset <= text.length; offset += cut === full.length ? 1 : 5) {
        const found = hoverAt(analysis, offset, data);
        expect(around(found?.range, offset), `hover at ${offset} of ${cut}`).toBe(true);
        for (const item of completionAt(analysis, offset, data)) {
          const edit = item.textEdit;
          expect(around(edit && 'range' in edit ? edit.range : undefined, offset), `${item.label} at ${offset} of ${cut}`).toBe(true);
        }
        definitionAt(analysis, offset, data);
        referencesAt(analysis, offset, data);
        prepareRenameAt(analysis, offset, data);
        renameAt(analysis, offset, 'renamed', data);
      }
    }
  });
});

describe('rename through the paths of patches', () => {
  // A fresh index with the files as an editor has them: an extension's script, and another's patch of it.
  const scripts = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
  const data = { ...game, index: scripts, folder: gameFolder };
  const withScripts = { ...context, index: scripts };
  const editable = { editableFolders: [modsFolder] };
  const set = (file: string, lines: string[], source: string): string => {
    const text = `${lines.join('\n')}\n`;
    scripts.setStructure(file, text, parseXml(text), source, true);
    return text;
  };
  const apiText = set(
    api,
    [
      '<mdscript name="Api">',
      '  <cues>',
      '    <cue name="Register">',
      '      <actions>',
      '        <set_value name="$registered" exact="1"/>',
      '        <do_if value="$registered == 1">',
      '          <set_value name="$done" exact="true"/>',
      '        </do_if>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
    ],
    'ws_12345'
  );
  const nestedText = set(
    nestedPatch,
    [
      '<diff>',
      `  <replace sel="//cue[@name='Register']/actions/set_value[@name='$registered']/@exact">2</replace>`,
      `  <add sel="//cue[@name='Register']/actions/do_if[@value='$registered == 1']" pos="before">`,
      '    <set_value name="$before" exact="0"/>',
      '  </add>',
      `  <remove sel="//cue[@name='Register']/actions/do_if[not(@value='$registered == 1')]" silent="true"/>`,
      '</diff>',
    ],
    'late_mod'
  );
  const at = (text: string, needle: string, delta = 0): number => text.indexOf(needle) + delta;
  /** `file:line:character` of each place, lines and characters from 0. */
  const where = (file: string, text: string, needle: string, delta = 0): string => {
    const offset = text.indexOf(needle) + delta;
    const lines = text.slice(0, offset).split('\n');
    return `${relative(file)}:${lines.length - 1}:${lines[lines.length - 1].length}`;
  };
  const place = (location: { uri: string; range: { start: { line: number; character: number } } }): string =>
    `${relative(fileURLToPath(location.uri))}:${location.range.start.line}:${location.range.start.character}`;
  const edits = (edit: ReturnType<typeof renameAt>): string[] =>
    edit && 'changes' in edit
      ? Object.entries(edit.changes ?? {})
          .flatMap(([uri, changes]) => changes.map((change) => `${place({ uri, range: change.range })} ${change.newText}`))
          .sort()
      : [String(edit && 'refused' in edit ? edit.refused : edit)];

  it("renames a variable in the literals of another extension's paths that select by it", () => {
    const script = analyzeFile(api, apiText, withScripts);
    const offset = at(apiText, '$registered', 2);
    const places = [
      where(api, apiText, '$registered'),
      where(api, apiText, '$registered == 1'),
      where(nestedPatch, nestedText, "$registered']"),
      // In an expression compared whole: the variable's part of the literal.
      where(nestedPatch, nestedText, "$registered == 1'"),
    ].sort();
    expect(edits(renameAt(script, offset, 'signed', data, editable))).toEqual(places.map((found) => `${found} $signed`));
    expect(referencesAt(script, offset, data).map(place).sort()).toEqual(places);
    // The literal under not() selects other values: it repeats none.
    expect(nestedText.split('\n')[5]).toContain("not(@value='$registered == 1')");
    expect(prepareRenameAt(script, offset, data, editable)).toMatchObject({ placeholder: '$registered' });
  });

  it("refuses a rename when a path that repeats it is outside the workspace, or of the game's files", () => {
    const script = analyzeFile(api, apiText, withScripts);
    const offset = at(apiText, '$registered', 2);
    const baseOnly = { editableFolders: [path.join(modsFolder, 'base_mod')] };
    const refusal = { refused: '$registered is also written in api.xml (late_mod), outside the workspace' };
    expect(renameAt(script, offset, 'signed', data, baseOnly)).toEqual(refusal);
    expect(prepareRenameAt(script, offset, data, baseOnly)).toEqual(refusal);
    // A variable no path names renames as before.
    expect(edits(renameAt(script, at(apiText, '$done', 2), 'finished', data, baseOnly))).toEqual([`${where(api, apiText, '$done')} $finished`]);
  });

  it('renames a label of an AI script in the path of a patch of it', () => {
    const library = path.join(gameFolder, 'aiscripts', 'lib.label.xml');
    const libraryText = set(
      library,
      [
        '<aiscript name="lib.label">',
        '  <attention min="unknown">',
        '    <actions>',
        '      <label name="start"/>',
        '      <resume label="start"/>',
        '    </actions>',
        '  </attention>',
        '</aiscript>',
      ],
      'game'
    );
    const patch = path.join(modsFolder, 'late_mod', 'aiscripts', 'lib.label.xml');
    const patchText = set(patch, ['<diff>', `  <add sel="//label[@name='start']" pos="after">`, '    <wait exact="1s"/>', '  </add>', '</diff>'], 'late_mod');
    const script = analyzeFile(library, libraryText, withScripts);
    const offset = at(libraryText, 'start', 2);
    expect(edits(renameAt(script, offset, 'begin', data, editable))).toEqual(
      [where(library, libraryText, '"start"', 1), where(library, libraryText, 'label="start"', 7), where(patch, patchText, "'start'", 1)]
        .sort()
        .map((found) => `${found} begin`)
    );
  });

  it('renames in the path of a later operation of the same patch what an earlier one brought in', () => {
    const patch = path.join(modsFolder, 'late_mod', 'md', 'setup.xml');
    const own = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const text = [
      '<diff>',
      `  <add sel="//cue[@name='Start']/actions">`,
      '    <set_value name="$fresh" exact="1"/>',
      '  </add>',
      `  <replace sel="//cue[@name='Start']/actions/set_value[@name='$fresh']/@exact">2</replace>`,
      '</diff>',
      '',
    ].join('\n');
    own.setStructure(patch, text, parseXml(text), 'late_mod', true);
    const analysis = analyzeFile(patch, text, { ...context, index: own });
    expect(analysis.patch?.operations.map((operation) => operation.status)).toEqual(['applied', 'applied']);
    const renamed = renameAt(analysis, at(text, '$fresh', 2), 'new', { ...game, index: own, folder: gameFolder }, editable);
    expect(edits(renamed)).toEqual([where(patch, text, '$fresh'), where(patch, text, "$fresh'")].sort().map((found) => `${found} $new`));
  });

  it('never throws on a half-typed literal, which repeats nothing', () => {
    const typed = nestedText.replace(`set_value[@name='$registered']/@exact">2</replace>`, `set_value[@name='$regis`);
    const own = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    own.setStructure(api, apiText, parseXml(apiText), 'ws_12345', true);
    own.setStructure(nestedPatch, typed, parseXml(typed), 'late_mod', true);
    const script = analyzeFile(api, apiText, { ...context, index: own });
    const offset = at(apiText, '$registered', 2);
    const found = referencesAt(script, offset, { ...game, index: own, folder: gameFolder }).map(place);
    expect(found).not.toContain(where(nestedPatch, typed, '$regis'));
    expect(found).toContain(where(nestedPatch, typed, "$registered == 1'"));
  });
});

describe('library files', () => {
  const libraries = (folder: string, name: string): string => path.join(folder, 'libraries', name);
  const gameWares = libraries(gameFolder, 'wares.xml');
  const gameIcons = libraries(gameFolder, 'icons.xml');
  const baseWares = libraries(path.join(modsFolder, 'base_mod'), 'wares.xml');
  const baseIcons = libraries(path.join(modsFolder, 'base_mod'), 'icons.xml');
  const earlyWares = libraries(path.join(modsFolder, 'early_mod'), 'wares.xml');
  const lateWares = libraries(path.join(modsFolder, 'late_mod'), 'wares.xml');
  const lateIcons = libraries(path.join(modsFolder, 'late_mod'), 'icons.xml');
  const nowhere = libraries(path.join(modsFolder, 'late_mod'), 'nowhere.xml');
  const data = { ...game, index, folder: gameFolder };
  const full = readFileSync(lateWares, 'utf8');
  const late = analyzeFile(lateWares, full);
  const at = (text: string, needle: string, delta = 0): number => text.indexOf(needle) + delta;
  const hoverText = (analysis: DocumentAnalysis, offset: number): string => {
    const found = hoverAt(analysis, offset, data)?.contents;
    return found && typeof found === 'object' && 'value' in found ? found.value : '';
  };
  const place = (location: { uri: string; range: { start: { line: number; character: number } } }): string =>
    `${relative(fileURLToPath(location.uri))}:${location.range.start.line}:${location.range.start.character}`;
  const labels = (analysis: DocumentAnalysis, offset: number): string[] => completionAt(analysis, offset, data).map((item) => item.label);
  const wares = (document: PatchNode | undefined): string[] =>
    document
      ? evaluateXPath(parseXPath('/wares/ware'), document).map((selection) =>
          selection.kind === 'node' ? selection.node.attributes.map((attribute) => `${attribute.name}=${attribute.value}`).join(' ') : ''
        )
      : [];

  it("ties a file in an extension's libraries to the game's file of its name, and lists the files of a name in load order", () => {
    expect(index.patchTarget(lateWares)).toEqual({ file: gameWares, name: 'libraries/wares.xml' });
    expect(index.patchTarget(nowhere)).toEqual({ name: 'libraries/nowhere.xml', missing: 'the game has no libraries/nowhere.xml' });
    expect(index.patchTarget(gameWares)).toBeUndefined();
    expect(index.patchesOf(gameWares).map((file) => `${file.source} ${relative(file.file)}`)).toEqual([
      'ws_12345 mods/base_mod/libraries/wares.xml',
      'early_mod mods/early_mod/libraries/wares.xml',
      'late_mod mods/late_mod/libraries/wares.xml',
    ]);
    expect(index.patchesBefore(lateWares, gameWares).map((file) => relative(file.file))).toEqual([
      'mods/base_mod/libraries/wares.xml',
      'mods/early_mod/libraries/wares.xml',
    ]);
    expect(index.libraryFiles().map((file) => relative(file.file))).toEqual([
      'mods/base_mod/libraries/icons.xml',
      'mods/base_mod/libraries/wares.xml',
      'mods/early_mod/libraries/wares.xml',
      'mods/late_mod/libraries/icons.xml',
      'mods/late_mod/libraries/nowhere.xml',
      'mods/late_mod/libraries/wares.xml',
    ]);
    // Known by their folders, not indexed: none of them is a script.
    expect([baseWares, gameWares, earlyPatch].map((file) => index.isLibraryFile(file))).toEqual([true, false, false]);
    expect(index.hasFile(baseWares)).toBe(false);
    expect(index.sourceOf(baseWares)).toBe('ws_12345');
    expect(index.sourceOf(gameWares)).toBe('game');
  });

  it('merges the merge files and applies the patches loaded before a patch, as the game does', () => {
    const patch = late.patch;
    expect(patch?.earlier.map(relative)).toEqual(['mods/base_mod/libraries/wares.xml', 'mods/early_mod/libraries/wares.xml']);
    expect(patch?.merged.map(relative)).toEqual(['mods/base_mod/libraries/wares.xml']);
    expect(patch?.operations.map((operation) => `${operation.kind} ${operation.status}`)).toEqual(['add applied', 'remove applied', 'remove no-match']);
    expect(wares(patch?.document)).toEqual(['id=energycells price=10', 'id=base_ware price=6 volume=2']);
    // No schema tells what a library file holds: what a patch brings is not checked where it lands.
    expect(patch?.patched).toBeUndefined();
    expect(report(late)).toEqual([
      "6 3 patch-no-match: No matching node in libraries/wares.xml after 1 earlier patch and 1 merge file: 'ware[@id='missing']' selects nothing (silent)",
    ]);
    expect(report(analyzeFile(earlyWares))).toEqual([]);
    expect(report(analyzeFile(nowhere))).toEqual(['3 2 patch-target-missing: Nothing to patch: the game has no libraries/nowhere.xml']);
  });

  it('merges through the index of the root, and only a file of the same root', () => {
    const source = (file: string, text: string): PatchSource => ({ file, text, structure: parseXml(text) });
    const tree = documentTree(source('game.xml', '<wares><ware id="a"/></wares>'));
    const select = (path: string): number => evaluateXPath(parseXPath(path), tree).length;
    // Asked before the merge, so the root's index is built.
    expect(select("/wares/ware[@id='b']")).toBe(0);
    expect(mergeFile(tree, source('merge.xml', '<wares><!-- b --><ware id="b"/></wares>'))).toBe(true);
    expect(select("/wares/ware[@id='b']")).toBe(1);
    expect(tree.children[0].children.map((child) => child.kind)).toEqual(['element', 'comment', 'element']);
    expect(mergeFile(tree, source('other.xml', '<icons><icon/></icons>'))).toBe(false);
    expect(select('/wares/*')).toBe(2);
  });

  it('counts the earlier files by kind in messages', () => {
    const files = (count: number): string[] => Array.from({ length: count }, (_, number) => `f${number}`);
    expect(afterEarlier({ earlier: [], merged: [] })).toBe('');
    expect(afterEarlier({ earlier: files(2), merged: [] })).toBe(' after 2 earlier patches');
    expect(afterEarlier({ earlier: files(1), merged: files(1) })).toBe(' after 1 earlier merge file');
    expect(afterEarlier({ earlier: files(3), merged: files(2) })).toBe(' after 1 earlier patch and 2 merge files');
  });

  it("skips and reports a file whose root is neither diff nor the game file's, as the game does", () => {
    const skipped = analyzeFile(baseIcons);
    expect(report(skipped)).toEqual([
      "3 1 library-root-mismatch: The game skips this file: its root 'icon' is neither 'diff' for a patch nor 'icons' for a merge into libraries/icons.xml",
    ]);
    expect(covered(skipped, 'library-root-mismatch')).toEqual(['icon']);
    const icons = analyzeFile(lateIcons);
    expect(icons.patch?.earlier).toEqual([]);
    expect(report(icons)).toEqual(["7 1 patch-no-match: No matching node in libraries/icons.xml: 'icon[@name='base_icon']' selects nothing"]);
    // A merge file as it should be, and without the index any XML: nothing to report.
    expect(report(analyzeFile(baseWares))).toEqual([]);
    expect(report(analyzeFile(baseIcons, undefined, { schemas: game.schemas }))).toEqual([]);
  });

  it('follows the editor text of a merge file before the patch', () => {
    const edited = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const text = readFileSync(baseWares, 'utf8').replace('base_ware', 'other_ware');
    edited.setStructure(baseWares, text, parseXml(text), 'ws_12345', true);
    const analysis = analyzeFile(lateWares, full, { ...context, index: edited });
    expect(analysis.patch?.operations.map((operation) => operation.status)).toEqual(['no-match', 'applied', 'no-match']);
    expect(wares(analysis.patch?.document)).toEqual(['id=energycells price=10', 'id=other_ware price=5']);
  });

  it('answers in a library patch from the game file as the patch finds it, merged into', () => {
    expect(hoverText(late, at(full, "[@id='base_ware']", 2))).toBe(
      '**ware\\[@id=\'base\\_ware\'\\]**\n\nSelects 1 node:\n\n- `<ware id="base_ware">` · added by the merge file of `ws_12345`, line 5'
    );
    expect(definitionAt(late, at(full, "[@id='base_ware']", 2), data).map(place)).toEqual(['mods/base_mod/libraries/wares.xml:4:3']);
    expect(definitionAt(late, at(full, "[@id='water']", 2), data).map(place)).toEqual(['game/libraries/wares.xml:4:3']);
    expect(labels(late, at(full, "[@id='base_ware']", 6))).toEqual(['energycells', 'water', 'base_ware']);
  });

  it('compares the game file before and after a library patch', () => {
    const compared = late.patch && comparePatch(late.patch, index);
    expect(compared?.name).toBe('libraries/wares.xml');
    expect(compared?.before).toContain("<!-- the base mod's ware -->");
    expect(compared?.before).toContain('<ware id="base_ware" price="6"/>');
    expect(compared?.after).toContain('<ware id="base_ware" price="6" volume="2"/>');
    expect(compared?.after).not.toContain('water');
    // Its document type declaration is kept, as everything else around the root.
    const icons = analyzeFile(lateIcons).patch;
    expect(icons && comparePatch(icons, index)?.before).toBe(readFileSync(gameIcons, 'utf8'));
  });

  it('never throws on a half-typed library patch or merge file', () => {
    for (const [file, text] of [
      [lateWares, full],
      [baseWares, readFileSync(baseWares, 'utf8')],
    ]) {
      for (let cut = 0; cut <= text.length; cut += 3) {
        const analysis = analyzeFile(file, text.slice(0, cut));
        const offset = Math.max(0, cut - 2);
        hoverAt(analysis, offset, data);
        completionAt(analysis, offset, data);
        definitionAt(analysis, offset, data);
        if (analysis.patch) {
          comparePatch(analysis.patch, index);
        }
      }
    }
    // While its root is typed, a merge file shows what the game would make of it so far.
    const typed = analyzeFile(baseWares, '<?xml version="1.0" encoding="utf-8"?>\n<wares>\n  <ware id="new" pri');
    expect(typed.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('library-root-mismatch');
    expect(typed.diagnostics.length).toBeGreaterThan(0);
  });
});
