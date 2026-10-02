import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  attributeNamed,
  loadGameData,
  loadScriptIndex,
  parsedValue,
  semanticTokens,
  type AnalysisContext,
  type DocumentAnalysis,
  type ParsedExpression,
  type ParsedValueCache,
} from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);
const context: AnalysisContext = { schemas: game.schemas, properties: game.properties, validateVariables: true };

const actions = (body: string): string =>
  `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <actions>\n        ${body}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;

/** The tree of the first attribute of the analysis with this value. */
function treeOf(analysis: DocumentAnalysis | undefined, value: string): ParsedExpression {
  const attribute = analysis?.structure?.elements.flatMap((element) => element.attributes).find((candidate) => candidate.value === value);
  if (!attribute) {
    throw new Error(`no attribute with the value ${value}`);
  }
  return parsedValue(attribute);
}

describe('parsed values kept from one analysis of a document to the next', () => {
  it('keeps the trees of the values an edit leaves, and parses the others', () => {
    const cache: ParsedValueCache = {};
    const text = actions('<set_value name="$s" exact="player.ship"/>\n        <set_value name="$n" exact="$s.pilot"/>');
    const first = analyzeText(text, { ...context, expressionCache: cache });
    const second = analyzeText(text.replace('$s.pilot', '$s.pilot.name'), { ...context, expressionCache: cache });
    expect(treeOf(second, 'player.ship')).toBe(treeOf(first, 'player.ship'));
    expect(treeOf(second, '$s.pilot.name').expression).toMatchObject({ kind: 'property', name: 'name' });
    expect(cache.trees?.get('$s.pilot.name')).toBe(treeOf(second, '$s.pilot.name'));
    expect(cache.trees?.has('$s.pilot')).toBe(false);
    // Without the cache every analysis parses afresh.
    expect(treeOf(analyzeText(text, context), 'player.ship')).not.toBe(treeOf(first, 'player.ship'));
  });

  it('hands on the trees of the previous analysis only', () => {
    const cache: ParsedValueCache = {};
    const both = actions('<set_value name="$a" exact="player.ship"/>\n        <set_value name="$b" exact="player.money"/>');
    const first = analyzeText(both, { ...context, expressionCache: cache });
    analyzeText(actions('<set_value name="$b" exact="player.money"/>'), { ...context, expressionCache: cache });
    const third = analyzeText(both, { ...context, expressionCache: cache });
    expect(treeOf(third, 'player.money')).toBe(treeOf(first, 'player.money'));
    expect(treeOf(third, 'player.ship')).not.toBe(treeOf(first, 'player.ship'));
  });

  it('finds what an analysis afresh finds at every step of typing, also where the type of a kept chain changes', () => {
    const cache: ParsedValueCache = {};
    const base = '<set_value name="$s" exact="player.ship"/>\n        <debug_text text="$s.frob"/>\n        ';
    const typed = '<set_value name="$t" exact="$s.pilot.frob"/>';
    const texts: string[] = [];
    for (let cut = 0; cut <= typed.length; cut++) {
      texts.push(actions(base + typed.slice(0, cut)));
    }
    // `$s` becomes a string and a ship again: the chains on it keep their trees and are resolved again.
    texts.push(actions(base.replace('player.ship', "'text'") + typed), actions(base + typed));
    const messages: string[][] = [];
    for (const text of texts) {
      const cached = analyzeText(text, { ...context, expressionCache: cache });
      const afresh = analyzeText(text, context);
      expect(cached.diagnostics, text).toEqual(afresh.diagnostics);
      expect(semanticTokens(cached, game), text).toEqual(semanticTokens(afresh, game));
      messages.push(cached.diagnostics.filter((diagnostic) => diagnostic.code === 'expression-unknown-property').map((diagnostic) => diagnostic.message));
    }
    expect(messages.slice(-3)).toEqual([
      [
        "'ship' has no property 'frob' ($s is a ship, set by set_value at line 5)",
        "'entity' has no property 'frob' ($s is a ship, set by set_value at line 5)",
      ],
      [
        "'string' has no property 'frob' ($s is a string, set by set_value at line 5)",
        "'string' has no property 'pilot' ($s is a string, set by set_value at line 5)",
      ],
      [
        "'ship' has no property 'frob' ($s is a ship, set by set_value at line 5)",
        "'entity' has no property 'frob' ($s is a ship, set by set_value at line 5)",
      ],
    ]);
  });

  it("keeps the trees of a patch's target apart from the patch's own", () => {
    const fixtures = fileURLToPath(new URL('./fixtures/patches', import.meta.url));
    const index = loadScriptIndex(path.join(fixtures, 'game'), [path.join(fixtures, 'mods')], game.schemas);
    const file = path.join(fixtures, 'mods', 'late_mod', 'md', 'setup.xml');
    const uri = pathToFileURL(file).toString();
    const text = readFileSync(file, 'utf8');
    const edited = text.replace('<set_value name="$b" exact="2" />', '<set_value name="$b" exact="3" />');
    const cache: ParsedValueCache = {};
    const patchContext: AnalysisContext = { ...context, index };
    const first = analyzeText(text, { ...patchContext, expressionCache: cache }, uri);
    const second = analyzeText(edited, { ...patchContext, expressionCache: cache }, uri);
    const target = (analysis: DocumentAnalysis): DocumentAnalysis | undefined => analysis.patch?.patched?.analysis;
    expect(cache.patched?.trees?.get('3')).toBe(treeOf(target(second), '3'));
    expect(cache.trees?.has('3')).toBe(false);
    expect(treeOf(target(second), "'easy'")).toBe(treeOf(target(first), "'easy'"));
    expect(treeOf(target(second), '1')).toBe(treeOf(target(first), '1'));
    // `$count` and `$b` were both 2, and shared their tree.
    const exactOf = (analysis: DocumentAnalysis | undefined, name: string): ParsedExpression | undefined => {
      const element = analysis?.structure?.elements.find((candidate) => attributeNamed(candidate, 'name')?.value === name);
      const exact = element && attributeNamed(element, 'exact');
      return exact && parsedValue(exact);
    };
    expect(exactOf(target(first), '$b')).toBe(exactOf(target(first), '$count'));
    expect(exactOf(target(second), '$count')).toBe(exactOf(target(first), '$count'));
    expect(second.diagnostics).toEqual(analyzeText(edited, patchContext, uri).diagnostics);
  });
});
