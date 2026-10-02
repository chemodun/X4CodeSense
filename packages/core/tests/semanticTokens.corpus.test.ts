/**
 * Corpus gate for semantic highlighting, over every script and patch of the extracted game with its DLCs
 * (X4_EXTRACTED) and of a folder of extensions (X4_MODS), never committed: the tokens of each file are in
 * text order, apart, and on one line each once positioned; the text of each fits its type; every name in
 * an expression has a token, unless the analysis reports a problem with that expression; the tokens of the
 * slowest file take less than the file ceiling. And a keystroke as the editor analyses it, with the index,
 * the texts, the tokens and the trees of the previous analysis: in the largest script of the game it takes
 * less than the file ceiling, and in the largest of each source it finds what an analysis afresh finds.
 */
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  isExpressionAttribute,
  loadGameData,
  offsetInValue,
  parsedValue,
  positionTokens,
  semanticTokens,
  type AnalysisContext,
  type DocumentAnalysis,
  type ParsedValueCache,
  type SemanticTokenType,
  type XmlAttribute,
} from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

const operatorWords: ReadonlySet<string> = new Set(['and', 'or', 'not', 'typeof', 'lt', 'le', 'gt', 'ge']);
const operators = /^([-+*/%^=<>!.,{}[\]()@?]|==|!=|<=|>=|&lt;|&gt;|&amp;|&lt;=|&gt;=)$/;

describe.skipIf(!extracted)('semantic tokens on the corpus', { timeout: 300_000 }, () => {
  const game = loadGameData(extracted ?? '', { extensionFolders: mods ? [mods] : [], index: true });
  // The tokens need the declarations, the names and the variables, which an analysis collects when asked, not
  // its checks: without them the corpus is analysed in a fraction of the time, which the timing gates of the
  // other test files, running meanwhile, need. A file with a name that has no token is analysed again with them.
  const context: AnalysisContext = {
    schemas: game.schemas,
    properties: game.properties,
    validateStructure: false,
    validateExpressions: false,
    validateVariables: false,
    validateNames: false,
    validateRemoteCues: false,
  };
  const checked: AnalysisContext = { schemas: game.schemas, properties: game.properties, texts: game.texts };
  if (game.index) {
    context.index = game.index;
    checked.index = game.index;
  }
  const keywords = new Set([...(game.properties?.keywords.map((keyword) => keyword.name) ?? []), 'if', 'then', 'else', 'table']);
  const fits: Record<SemanticTokenType, (text: string) => boolean> = {
    variable: (text) => /^\$?\w+$/.test(text),
    property: (text) => /^\$?\w+$/.test(text),
    enumMember: (text) => /^\w+$/.test(text),
    namespace: (text) => /^\w+$/.test(text),
    // Labels and interrupt library items are named freely: `await build task`, `debug.economy.mining`.
    function: (text) => text !== '' && text.trim() === text,
    label: (text) => text !== '' && text.trim() === text,
    keyword: (text) => keywords.has(text),
    // A unit after a parenthesis stands alone.
    number: (text) => /^(\d|\.\d)|^[A-Za-z]+$/.test(text),
    string: (text) => text.startsWith("'"),
    operator: (text) => operatorWords.has(text) || operators.test(text),
  };

  /** The analysis with its names and variables collected, and those of a patch's target: a server's analysis has them before the tokens are asked for. */
  function collected(analysis: DocumentAnalysis): DocumentAnalysis {
    for (const each of [analysis, analysis.patch?.patched?.analysis]) {
      void each?.names;
      void each?.variables;
    }
    return analysis;
  }

  /** The expression attributes of an analysis with a value, in document order. */
  function expressionValues(analysis: DocumentAnalysis): XmlAttribute[] {
    return (analysis.structure?.elements ?? []).flatMap((element) => {
      const declaration = analysis.declarations.get(element);
      return element.attributes.filter(
        (attribute) => attribute.quote !== '' && attribute.value.trim() !== '' && isExpressionAttribute(declaration?.attributes.get(attribute.name))
      );
    });
  }

  /** Names in expressions without a token, with the value they are in. */
  function untokened(analysis: DocumentAnalysis, starts: ReadonlySet<number>): { name: string; start: number; end: number }[] {
    const found: { name: string; start: number; end: number }[] = [];
    for (const attribute of expressionValues(analysis)) {
      for (const token of parsedValue(attribute).tokens) {
        if (token.kind === 'identifier' && !starts.has(offsetInValue(attribute, token.start))) {
          found.push({ name: `${attribute.element.name}@${attribute.name} '${token.text}'`, start: attribute.valueStart, end: attribute.valueEnd });
        }
      }
    }
    return found;
  }

  /** True when a checked analysis reports a problem with an expression in the range. */
  function reported(analysis: DocumentAnalysis, start: number, end: number): boolean {
    const document = analysis.document;
    return analysis.diagnostics.some(
      (diagnostic) =>
        String(diagnostic.code).startsWith('expression-') &&
        document.offsetAt(diagnostic.range.start) <= end &&
        document.offsetAt(diagnostic.range.end) >= start
    );
  }

  it('classifies every expression in text order, each token fitting its type', () => {
    const problems: string[] = [];
    const counts = new Map<string, number>();
    let files = 0;
    let withoutToken = 0;
    // Timed afterwards, best of 5: the files with the most tokens. A single run here shares the machine with the other test files.
    const densest: { tokens: number; file: string; text: string }[] = [];
    for (const entry of game.index?.entries() ?? []) {
      const text = readFileSync(entry.file, 'utf8');
      const uri = pathToFileURL(entry.file).toString();
      const analysis = collected(analyzeText(text, context, uri));
      const tokens = semanticTokens(analysis, game) ?? [];
      const positioned = positionTokens(analysis.document, tokens);
      densest.push({ tokens: tokens.length, file: entry.file, text });
      densest.sort((a, b) => b.tokens - a.tokens);
      densest.splice(3);
      files++;
      const where = path.basename(entry.file);
      let end = 0;
      for (const token of tokens) {
        const key = `${token.type}${token.modifier ? `.${token.modifier}` : ''}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const tokenText = text.slice(token.start, token.end);
        if (token.start < end || token.end <= token.start || !fits[token.type](tokenText)) {
          problems.push(`${where}: ${key} '${tokenText}' at line ${analysis.document.positionAt(token.start).line + 1}`);
        }
        end = token.end;
      }
      const lines = text.split('\n');
      for (const token of positioned) {
        const line = (lines[token.line] ?? '').replace(/\r$/, '');
        if (token.length <= 0 || token.character + token.length > line.length) {
          problems.push(`${where}: a token beyond its line at ${token.line + 1}:${token.character + 1}`);
        }
      }
      // A patch's names lie in its target; its own tokens are checked above.
      const names = entry.kind === 'patch' ? [] : untokened(analysis, new Set(tokens.map((token) => token.start)));
      if (names.length > 0) {
        withoutToken += names.length;
        const checkedAnalysis = analyzeText(text, checked, uri);
        for (const name of names.filter((candidate) => !reported(checkedAnalysis, candidate.start, candidate.end))) {
          problems.push(`${where}: ${name.name} has no token, and no problem is reported with its expression`);
        }
      }
    }
    let slowest = { ms: 0, file: '' };
    for (const candidate of densest) {
      const analysis = collected(analyzeText(candidate.text, context, pathToFileURL(candidate.file).toString()));
      const ms = bestOf(5, () => positionTokens(analysis.document, semanticTokens(analysis, game) ?? []));
      if (ms > slowest.ms) {
        slowest = { ms, file: candidate.file };
      }
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const byType = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key} ${count}`)
      .join(', ');
    console.log(
      `semantic tokens: ${files} files, ${total} tokens (${byType}); names without a token ${withoutToken}; slowest of the ${densest.length} files with the most tokens ${path.basename(slowest.file)} ${slowest.ms.toFixed(1)} ms best of 5`
    );
    expect(files).toBeGreaterThan(600);
    expect(problems).toEqual([]);
    expect(slowest.ms).toBeLessThan(fileCeilingMs);
  });

  it('analyses a keystroke as the editor does: only the value it changed is parsed again, and the findings and tokens are those of an analysis afresh', () => {
    // The editor's context is `checked`. The server also indexes the document again on each change; that would
    // change the index the other tests share, so it is left out here.
    const largest = new Map<string, { file: string; size: number }>();
    for (const entry of game.index?.entries() ?? []) {
      if (entry.kind !== 'script') {
        continue;
      }
      const source = entry.source === 'game' ? 'game' : entry.source.startsWith('ego_dlc_') ? 'DLCs' : 'mods';
      const size = statSync(entry.file).size;
      if (size > (largest.get(source)?.size ?? 0)) {
        largest.set(source, { file: entry.file, size });
      }
    }
    const timings: string[] = [];
    for (const [source, { file }] of largest) {
      const name = path.basename(file);
      const text = readFileSync(file, 'utf8');
      const uri = pathToFileURL(file).toString();
      const cache: ParsedValueCache = {};
      const keystroke = (typed: string): DocumentAnalysis => {
        const analysis = analyzeText(typed, { ...checked, expressionCache: cache }, uri);
        semanticTokens(analysis, game);
        return analysis;
      };
      const values = expressionValues(keystroke(text));
      // A space typed at the end of the first expression value after the middle of the script.
      const at = values.find((attribute) => attribute.valueStart > text.length / 2 && attribute.closed)?.valueEnd;
      expect(at, name).toBeDefined();
      const edited = `${text.slice(0, at)} ${text.slice(at)}`;
      const typed = keystroke(edited);
      const afresh = analyzeText(edited, checked, uri);
      expect(typed.diagnostics, name).toEqual(afresh.diagnostics);
      expect(semanticTokens(typed, game), name).toEqual(semanticTokens(afresh, game));
      const earlier = new Set(values.map((attribute) => parsedValue(attribute)));
      const kept = expressionValues(typed).filter((attribute) => earlier.has(parsedValue(attribute))).length;
      expect(kept, name).toBeGreaterThanOrEqual(values.length - 1);
      // Each timed run is a keystroke too: the cache holds the analysis of the other text.
      let round = 0;
      const ms = bestOf(7, () => keystroke(round++ % 2 === 0 ? text : edited));
      timings.push(`${source} ${name} ${ms.toFixed(1)} ms`);
      if (source === 'game') {
        expect(ms, name).toBeLessThan(fileCeilingMs);
      }
    }
    console.log(`a keystroke as the editor analyses it, best of 7: ${timings.join(', ')}; ceiling ${fileCeilingMs} ms`);
    expect(largest.has('game')).toBe(true);
  });
});
