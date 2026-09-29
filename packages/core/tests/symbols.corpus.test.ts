/**
 * Corpus gate for the outline, over every script and patch of the extracted game with its DLCs
 * (X4_EXTRACTED) and of a folder of extensions (X4_MODS), never committed: every cue, library, label,
 * interrupt library item and patch operation is in the outline once, every variable a script sets is
 * listed once unless it is a parameter, every symbol has a name, its name inside its range and its range
 * inside its parent's.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DocumentSymbol, Range } from 'vscode-languageserver-types';
import { SymbolKind } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import { analyzeText, attributeNamed, documentSymbols, loadGameData, scriptSchemaOf, type AnalysisContext, type ScriptSchema, type XmlElement } from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

const before = (a: Range['start'], b: Range['start']): boolean => a.line < b.line || (a.line === b.line && a.character <= b.character);
const inside = (inner: Range, outer: Range): boolean => before(outer.start, inner.start) && before(inner.end, outer.end);

/** What the outline must list of an element of a document of the kind, as `<kind> <name>`, or undefined. */
function expected(element: XmlElement, schema: ScriptSchema | undefined): string | undefined {
  const name = attributeNamed(element, 'name')?.value.trim();
  if (element.name === 'cue' || (element.name === 'library' && schema === 'md')) {
    return `cue ${name}`;
  }
  if (element.name === 'label') {
    return `label ${name}`;
  }
  if ((element.name === 'actions' || element.name === 'handler' || element.name === 'conditions') && name !== undefined) {
    return `item ${name}`;
  }
  if ((element.name === 'add' || element.name === 'replace' || element.name === 'remove') && element.parent?.name === 'diff') {
    return `operation ${attributeNamed(element, 'sel')?.value.trim().replace(/\s+/g, ' ')}`;
  }
  return undefined;
}

/** The same for a symbol. */
function listed(symbol: DocumentSymbol): string | undefined {
  switch (symbol.kind) {
    case SymbolKind.Event:
      return symbol.detail === 'handler'
        ? `item ${symbol.name}`
        : symbol.detail === 'handler ref' || symbol.name === 'handler' || symbol.name === 'on_abort'
          ? undefined
          : `cue ${symbol.name}`;
    case SymbolKind.Function:
      return symbol.detail?.startsWith('library') ? `cue ${symbol.name}` : `item ${symbol.name}`;
    case SymbolKind.Key:
      return `label ${symbol.name}`;
    case SymbolKind.Operator:
      return `operation ${symbol.name}`;
  }
  return undefined;
}

describe.skipIf(!extracted)('the outline on the corpus', { timeout: 300_000 }, () => {
  const game = loadGameData(extracted ?? '', { extensionFolders: mods ? [mods] : [], index: true });
  const context: AnalysisContext = { schemas: game.schemas, properties: game.properties, texts: game.texts };
  if (game.index) {
    context.index = game.index;
  }

  it('lists every named item, operation and variable once, in a sound tree', () => {
    const problems: string[] = [];
    const counts = { files: 0, symbols: 0, items: 0, variables: 0 };
    let slowest = { ms: 0, file: '', text: '' };
    for (const entry of game.index?.entries() ?? []) {
      const text = readFileSync(entry.file, 'utf8');
      // A patch is outlined from its own text: its target's analysis adds nothing to the outline.
      const analysis = analyzeText(text, entry.kind === 'patch' ? { schemas: game.schemas } : context, pathToFileURL(entry.file).toString());
      const started = performance.now();
      const symbols = documentSymbols(analysis);
      const ms = performance.now() - started;
      if (ms > slowest.ms) {
        slowest = { ms, file: entry.file, text };
      }
      counts.files++;
      const where = path.basename(entry.file);
      const schema = scriptSchemaOf(analysis);
      const wanted = (analysis.structure?.elements ?? []).map((element) => expected(element, schema)).filter((item): item is string => item !== undefined);
      const found: string[] = [];
      const variables: string[] = [];
      const visit = (list: DocumentSymbol[], parent?: DocumentSymbol): void => {
        for (const symbol of list) {
          counts.symbols++;
          if (symbol.name === '' || !inside(symbol.selectionRange, symbol.range) || (parent && !inside(symbol.range, parent.range))) {
            problems.push(`${where}: ${symbol.name} at line ${symbol.selectionRange.start.line + 1}`);
          }
          const item = listed(symbol);
          if (item) {
            found.push(item);
          }
          if (symbol.kind === SymbolKind.Variable) {
            variables.push(`${symbol.name} ${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`);
          }
          visit(symbol.children ?? [], symbol);
        }
      };
      visit(symbols);
      counts.items += found.length;
      const missing = wanted.filter((item) => !found.includes(item));
      const extra = found.filter((item) => !wanted.includes(item));
      if (found.length !== wanted.length || missing.length > 0 || extra.length > 0) {
        problems.push(`${where}: ${wanted.length} items, ${found.length} listed; missing ${missing.join(', ')}; not expected ${extra.join(', ')}`);
      }
      // Each variable that has a definition here, is not a parameter, and is in a table of this document.
      let expectedVariables = 0;
      for (const table of analysis.variables?.tables ?? []) {
        if (!table.owner) {
          continue;
        }
        for (const variable of table.variables.values()) {
          const parameter = variable.definitions.some(
            (definition) => definition.element.name === 'param' && (definition.element.parent?.name === 'params' || definition.element.parent?.name === 'cue')
          );
          if (variable.definitions.length > 0 && !parameter) {
            expectedVariables++;
          }
        }
      }
      counts.variables += variables.length;
      if (variables.length !== expectedVariables || new Set(variables).size !== variables.length) {
        problems.push(`${where}: ${expectedVariables} variables, ${variables.length} listed`);
      }
    }
    const document = { uri: pathToFileURL(slowest.file).toString(), text: slowest.text };
    const analysis = analyzeText(document.text, context, document.uri);
    const best = bestOf(5, () => documentSymbols(analysis));
    console.log(
      `outline: ${counts.files} files, ${counts.symbols} symbols, ${counts.items} named items and operations, ${counts.variables} variables; slowest ${path.basename(slowest.file)} ${best.toFixed(1)} ms best of 5`
    );
    expect(counts.files).toBeGreaterThan(600);
    expect(problems).toEqual([]);
    expect(best).toBeLessThan(fileCeilingMs);
  });
});
