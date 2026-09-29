import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  completionAt,
  definitionAt,
  evaluateXPath,
  hoverAt,
  loadGameData,
  loadScriptIndex,
  parseXml,
  parseXPath,
  prepareRenameAt,
  referencesAt,
  scriptFolders,
  type AnalysisContext,
  type DocumentAnalysis,
  type PatchNode,
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
      'mods/base_mod/md ws_12345 -> md at game/md',
      'mods/base_mod/aiscripts ws_12345 -> aiscripts at game/aiscripts',
      'mods/early_mod/md early_mod -> md at game/md',
      'mods/early_mod/aiscripts early_mod -> aiscripts at game/aiscripts',
      'mods/late_mod/md late_mod -> md at game/md',
      'mods/late_mod/aiscripts late_mod -> aiscripts at game/aiscripts',
      'mods/late_mod/extensions/absent_mod/md late_mod -> extensions/absent_mod/md',
      'mods/late_mod/extensions/base_mod/md late_mod -> extensions/base_mod/md at mods/base_mod/md',
    ]);
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

  it('answers the editor features anywhere in a patch without failing', () => {
    const data = { ...game, index };
    for (const text of [full, full.slice(0, full.indexOf('<remove'))]) {
      const analysis = analyzeFile(latePatch, text);
      for (let offset = 0; offset <= text.length; offset += 3) {
        hoverAt(analysis, offset, data);
        completionAt(analysis, offset, data);
        definitionAt(analysis, offset, data);
        referencesAt(analysis, offset, data);
        prepareRenameAt(analysis, offset, data);
      }
    }
  });
});
