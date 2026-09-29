import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  attributeNamed,
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
  sourceRange,
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
    expect(back('exact="2">', '2')).toBe('2');
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
