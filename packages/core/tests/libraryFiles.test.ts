/**
 * Library files that name their schema in `xsi:noNamespaceSchemaLocation`: validated against that schema of
 * the game's `libraries`, with completion, hover, the outline and the quick fixes the schema gives; the
 * patches, the sides of their comparison and merge files of a game file that names one, against that. The fixture's `unlocks.xsd` is
 * the game's, trimmed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeComparisonSide,
  analyzeText,
  checkFile,
  comparePatch,
  completionAt,
  documentSymbols,
  hoverAt,
  loadGameData,
  loadScriptIndex,
  newProblems,
  quickFixes,
  type AnalysisContext,
  type ComparisonSide,
  type DocumentAnalysis,
} from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);
const context: AnalysisContext = { schemas: game.schemas, properties: game.properties, texts: game.texts };
/** An extension's library file; it need not exist, the analysis reads only its uri. */
const libraryFile = path.join(unpacked, 'extensions', 'my_mod', 'libraries', 'unlocks.xml');
const libraryUri = pathToFileURL(libraryFile).href;

const unlocks = (body: string, schema = 'unlocks.xsd'): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<unlocks xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${schema}">\n${body}\n</unlocks>\n`;

const valid = unlocks('  <discount id="d1" name="Cheap">\n    <conditions weight="1"/>\n    <rechecktime min="2h"/>\n  </discount>');

function analyze(text: string, uri = libraryUri, analysisContext: AnalysisContext = context): DocumentAnalysis {
  return analyzeText(text, analysisContext, uri);
}

function findings(analysis: DocumentAnalysis): string[] {
  return analysis.diagnostics.map(
    (diagnostic) => `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.code}: ${diagnostic.message}`
  );
}

/** The analysis of a text with a `|` marker for the caret, and the caret offset. */
function at(marked: string): { analysis: DocumentAnalysis; offset: number } {
  const offset = marked.indexOf('|');
  return { analysis: analyze(marked.slice(0, offset) + marked.slice(offset + 1)), offset };
}

function hoverText(marked: string): string | undefined {
  const { analysis, offset } = at(marked);
  const hover = hoverAt(analysis, offset, game);
  return hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : undefined;
}

describe('library files: analysis', () => {
  it('validates a library file against the schema its root names', () => {
    const analysis = analyze(valid);
    expect(analysis.detection.library).toEqual({ schema: 'unlocks', schemaLocation: 'unlocks.xsd' });
    expect(findings(analysis)).toEqual([]);
    expect([...analysis.declarations.keys()].map((element) => element.name).sort()).toEqual(['conditions', 'discount', 'rechecktime', 'unlocks']);
  });

  it('reports what the schema does not allow', () => {
    const analysis = analyze(
      unlocks('  <discount name="Cheap">\n    <conditions weight="many"/>\n    <rechektime min="2h"/>\n    <rechecktime max="soon"/>\n  </discount>')
    );
    expect(findings(analysis)).toEqual([
      "3:4 missing-required-attribute: Missing required attribute 'id' in 'discount'",
      "4:25 invalid-attribute-value: Invalid value 'many' for attribute 'weight' in 'conditions'. Expected a value of type 'xs:integer'",
      "5:6 unknown-element: Unknown element 'rechektime' in 'discount'",
      "6:23 invalid-attribute-value: Invalid value 'soon' for attribute 'max' in 'rechecktime'. Expected a value of type 'unitvalue'",
    ]);
  });

  it('takes the root the file has among the schema roots, else tells them', () => {
    expect(findings(analyze('<rechecktime xsi:noNamespaceSchemaLocation="unlocks.xsd" min="1h"/>'))).toEqual([]);
    expect(findings(analyze('<discount xsi:noNamespaceSchemaLocation="unlocks.xsd" id="a"/>'))).toEqual([
      "1:2 unknown-root-element: Root element must be one of 'rechecktime', 'unlocks'",
    ]);
  });

  it("warns in a libraries folder about a schema the game's libraries do not have", () => {
    expect(findings(analyze(unlocks('', '../libraries/nothing.xsd')))).toEqual([
      "2:95 library-schema-unknown: The game's libraries have no schema 'nothing.xsd': the file is not checked against one",
    ]);
    // Elsewhere other tooling's schemas are named: cutscenes, the UI's addons.
    const cutscene = analyze(
      '<cutscene xsi:noNamespaceSchemaLocation="cutscenes.xsd"/>',
      pathToFileURL(path.join(unpacked, 'extensions', 'my_mod', 'cutscenes', 'a.xml')).href
    );
    expect(cutscene.structure).toBeUndefined();
    expect(cutscene.diagnostics).toEqual([]);
  });

  it('leaves a library file alone without the schemas, and the excluded schemas always', () => {
    const without = analyze(valid, libraryUri, {});
    expect(without.structure).toBeUndefined();
    expect(without.diagnostics).toEqual([]);
    const properties = analyze('<scriptproperties xsi:noNamespaceSchemaLocation="scriptproperties.xsd"><bogus/></scriptproperties>');
    expect(properties.structure).toBeUndefined();
    expect(properties.diagnostics).toEqual([]);
  });

  it('is checked with expressions, variables and names left out', () => {
    const analysis = analyze(unlocks('  <discount id="$undefined.foo" name="{1, 2}">\n    <conditions weight="1"/>\n  </discount>'));
    expect(findings(analysis)).toEqual([]);
    expect(analysis.variables).toBeUndefined();
    expect(analysis.names).toBeUndefined();
  });
});

describe('library files: features', () => {
  it('completes the elements, attributes and values of the schema', () => {
    const elements = at(unlocks('  <discount id="d1">\n    <|\n  </discount>'));
    expect(completionAt(elements.analysis, elements.offset, game).map((item) => item.label)).toEqual(['actions', 'conditions', 'rechecktime']);
    const attributes = at(unlocks('  <discount |/>'));
    expect(completionAt(attributes.analysis, attributes.offset, game).map((item) => item.label)).toEqual(['id', 'name']);
  });

  it('completes while typing, with the rest of the file still to come', () => {
    const typing = at('<unlocks xsi:noNamespaceSchemaLocation="unlocks.xsd">\n  <discount id="d1">\n    <con|');
    expect(completionAt(typing.analysis, typing.offset, game).map((item) => item.label)).toEqual(['conditions']);
    const attribute = at('<unlocks xsi:noNamespaceSchemaLocation="unlocks.xsd">\n  <discount id="d1">\n    <conditions w|');
    expect(completionAt(attribute.analysis, attribute.offset, game).map((item) => item.label)).toEqual(['weight']);
  });

  it('shows the documentation of the schema', () => {
    expect(hoverText(unlocks('  <discount id="d1">\n    <conditions/>\n    <recheck|time/>\n  </discount>'))).toContain(
      'Time after which this unlock may be triggered again'
    );
    expect(hoverText(unlocks('  <discount id="d1" na|me="x"/>'))).toContain('Unlock name');
  });

  it('outlines the root and the elements with an id or a name', () => {
    const symbols = documentSymbols(analyze(valid));
    const shown = (list: typeof symbols): unknown[] =>
      list.map((symbol) => ({ name: symbol.name, ...(symbol.detail ? { detail: symbol.detail } : {}), children: shown(symbol.children ?? []) }));
    expect(shown(symbols)).toEqual([{ name: 'unlocks', children: [{ name: 'd1', detail: 'discount', children: [] }] }]);
  });

  it('offers the spelling fixes and the required attributes', () => {
    const analysis = analyze(unlocks('  <discount>\n    <conditions/>\n    <rechektime/>\n  </discount>'));
    expect(quickFixes(analysis, analysis.diagnostics, game).map((action) => action.title)).toEqual([
      "Add the required attribute 'id'",
      "Change to 'rechecktime'",
    ]);
  });

  it('is a library file for the checker', () => {
    expect(checkFile(libraryFile, 'libraries', context, game, valid)).toEqual({ findings: [], kind: 'library' });
    expect(checkFile(libraryFile, 'libraries', context, game, '<unlocks/>').kind).toBe('other');
  });
});

describe('library files: patches and merge files', () => {
  // The game's library file, which names its schema, and an extension with a patch and a merge file of it.
  const root = mkdtempSync(path.join(tmpdir(), 'x4codesense-library-patches-'));
  const gameFolder = path.join(root, 'game');
  const modsFolder = path.join(root, 'mods');
  const modLibraries = path.join(modsFolder, 'my_mod', 'libraries');
  mkdirSync(path.join(gameFolder, 'libraries'), { recursive: true });
  mkdirSync(modLibraries, { recursive: true });
  writeFileSync(path.join(gameFolder, 'libraries', 'unlocks.xml'), valid);
  writeFileSync(path.join(modsFolder, 'my_mod', 'content.xml'), '<content id="my_mod" name="My Mod" version="100"/>\n');
  const index = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
  const withIndex: AnalysisContext = { ...context, index };
  const data = { ...game, index };
  const patchFile = path.join(modLibraries, 'unlocks.xml');
  const patchUri = pathToFileURL(patchFile).href;
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const diff = (body: string): string => `<?xml version="1.0" encoding="utf-8"?>\n<diff>\n${body}\n</diff>\n`;
  /** `line severity code: text` of each diagnostic, the text the one covers. */
  const reported = (analysis: DocumentAnalysis): string[] =>
    analysis.diagnostics.map(
      (diagnostic) => `${diagnostic.range.start.line + 1} ${diagnostic.severity} ${diagnostic.code}: ${analysis.document.getText(diagnostic.range)}`
    );
  const marked = (text: string): { analysis: DocumentAnalysis; offset: number } => {
    const offset = text.indexOf('|');
    return { analysis: analyze(text.slice(0, offset) + text.slice(offset + 1), patchUri, withIndex), offset };
  };

  it('checks what a patch brings in where it lands, by names, an unknown element a warning', () => {
    const analysis = analyze(
      diff(
        `  <add sel="/unlocks">\n    <discount id="d2"/>\n    <discount name="x">\n      <conditions weight="many"/>\n      <rechektime/>\n    </discount>\n  </add>`
      ),
      patchUri,
      withIndex
    );
    // `d2` lacks its `conditions`: the order and the counts are not checked in a library file's patch.
    expect(reported(analysis)).toEqual(['5 1 missing-required-attribute: discount', '6 1 invalid-attribute-value: many', '7 2 unknown-element: rechektime']);
    expect(analysis.patch?.patched?.analysis.detection.library).toEqual({ schema: 'unlocks', schemaLocation: 'unlocks.xsd' });
  });

  it('reports an unknown element in a patch as severe as asked', () => {
    const text = diff(`  <add sel="/unlocks/discount[@id='d1']">\n    <rechektime/>\n  </add>`);
    const severity = (level: AnalysisContext['libraryPatchUnknownElements']): unknown[] =>
      analyze(text, patchUri, { ...withIndex, libraryPatchUnknownElements: level }).diagnostics.map((diagnostic) => diagnostic.severity);
    expect([severity('error'), severity('warning'), severity('info'), severity(undefined)]).toEqual([[1], [2], [3], [2]]);
  });

  it('completes and hovers what a patch brings in from the schema', () => {
    const elements = marked(diff(`  <add sel="/unlocks">\n    <discount id="d2"><conditions/></discount>\n    <|\n  </add>`));
    expect(completionAt(elements.analysis, elements.offset, data).map((item) => item.label)).toEqual(['discount']);
    const children = marked(diff(`  <add sel="/unlocks">\n    <discount id="d2"><conditions/><|</discount>\n  </add>`));
    expect(completionAt(children.analysis, children.offset, data).map((item) => item.label)).toEqual(['actions', 'rechecktime']);
    const attributes = marked(diff(`  <add sel="/unlocks">\n    <discount |/>\n  </add>`));
    expect(completionAt(attributes.analysis, attributes.offset, data).map((item) => item.label)).toEqual(['id', 'name']);
    const hovered = marked(diff(`  <add sel="/unlocks/discount[@id='d1']">\n    <actions/>\n    <recheck|time min="1h"/>\n  </add>`));
    const hover = hoverAt(hovered.analysis, hovered.offset, data);
    expect(hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '').toContain('Time after which this unlock');
  });

  it('shows in the side with the patch what the patch reports, the order not checked', () => {
    const patch = analyze(
      diff(`  <add sel="/unlocks">\n    <discount id="d2"/>\n    <discount name="x">\n      <rechektime/>\n    </discount>\n  </add>`),
      patchUri,
      withIndex
    ).patch;
    const comparison = patch && comparePatch(patch, index);
    expect(comparison?.file).toBe(path.join(gameFolder, 'libraries', 'unlocks.xml'));
    if (!comparison) {
      return;
    }
    const side = (name: ComparisonSide, text: string, sideContext = withIndex): DocumentAnalysis =>
      analyzeComparisonSide(TextDocument.create(`x4codesense-patched:/unlocks.xml`, 'xml', 1, text), name, comparison.file, sideContext);
    const before = side('before', comparison.before);
    expect(before.detection.library?.schema).toBe('unlocks');
    expect(before.diagnostics).toEqual([]);
    const after = side('after', comparison.after);
    expect(newProblems(after, before).map((problem) => `${problem.severity} ${problem.code}: ${after.document.getText(problem.range)}`)).toEqual([
      '1 missing-required-attribute: discount',
      '2 unknown-element: rechektime',
    ]);
    const severe = side('after', comparison.after, { ...withIndex, libraryPatchUnknownElements: 'error' });
    expect(severe.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([1, 1]);
  });

  it("checks a merge file that names no schema against its game file's", () => {
    const merge = '<unlocks>\n  <discount id="d2">\n    <conditions weight="many"/>\n  </discount>\n</unlocks>\n';
    const analysis = analyze(merge, patchUri, withIndex);
    expect(analysis.detection.library).toEqual({ schema: 'unlocks', schemaLocation: 'unlocks.xsd' });
    expect(reported(analysis)).toEqual(['3 1 invalid-attribute-value: many']);
    expect(checkFile(patchFile, 'libraries', withIndex, data, merge).kind).toBe('library');
    // One the game skips is that, and nothing else.
    expect(reported(analyze('<rechecktime min="soon"/>', patchUri, withIndex))).toEqual(['1 1 library-root-mismatch: rechecktime']);
  });
});
