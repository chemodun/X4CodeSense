/**
 * Library files that name their schema in `xsi:noNamespaceSchemaLocation`: validated against that schema of
 * the game's `libraries`, with completion, hover, the outline and the quick fixes the schema gives. The
 * fixture's `unlocks.xsd` is the game's, trimmed.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, checkFile, completionAt, documentSymbols, hoverAt, loadGameData, quickFixes, type AnalysisContext, type DocumentAnalysis } from '../src';

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
