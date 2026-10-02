/**
 * Corpus gate for AI script names and order ids, over the scripts of the extracted game with its DLCs
 * (X4_EXTRACTED) and of a folder of extensions (X4_MODS), never committed. Every name a call writes
 * literally is indexed at its place and is defined, so the check of unknown names finds nothing; every
 * name a script defines or names hovers and leads to its definitions; a typo planted in a name is
 * reported and fixed back; find references from the definition of the most named order and AI script
 * lists every place, the literals of patches' paths that repeat one too, within the ceiling.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Location, MarkupContent, TextEdit } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  definitionAt,
  escapeMarkdown,
  fixAll,
  hoverAt,
  loadGameData,
  pathMirrors,
  quickFixes,
  referencesAt,
  scriptNameDefinitions,
  scriptNamesIn,
  validateScriptNames,
  type ScriptNameKind,
} from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

describe.skipIf(!extracted)('AI script names and order ids on the corpus', { timeout: 300_000 }, () => {
  const game = loadGameData(extracted ?? '', { extensionFolders: mods ? [mods] : [], index: true });
  const documents = new Map<string, TextDocument>();
  const documentOf = (uri: string): TextDocument => {
    let document = documents.get(uri);
    if (!document) {
      document = TextDocument.create(uri, 'xml', 0, readFileSync(fileURLToPath(uri), 'utf8'));
      documents.set(uri, document);
    }
    return document;
  };
  const textAt = (location: Location): string => documentOf(location.uri).getText(location.range);

  it('indexes every name a call writes literally at its place, each defined, and hovers and defines every name a script writes', () => {
    const index = game.index;
    if (!index) {
      throw new Error('no index');
    }
    const counts = { aiscript: 0, order: 0, written: 0 };
    const problems: string[] = [];
    const notDefined: string[] = [];
    for (const entry of index.entries()) {
      const where = path.basename(entry.file);
      const lines = index.currentText(entry.file)?.split('\n') ?? [];
      for (const reference of entry.references) {
        if (reference.kind !== 'aiscript' && reference.kind !== 'order') {
          continue;
        }
        counts[reference.kind]++;
        const { line, character } = reference.position;
        if (lines[line]?.slice(character, character + reference.name.length) !== reference.name) {
          problems.push(`${where}:${line + 1}: ${reference.kind} ${reference.name} not at its place`);
        }
        if (scriptNameDefinitions(index, reference.kind === 'aiscript' ? 'script' : 'order', reference.name).length === 0) {
          notDefined.push(`${where}: ${reference.kind} ${reference.name}`);
        }
      }
      if (entry.kind !== 'script') {
        continue;
      }
      // The structure alone: what the features read.
      const analysis = analyzeText(lines.join('\n'), {}, pathToFileURL(entry.file).toString());
      for (const diagnostic of validateScriptNames(analysis, index, 'X4CodeSense')) {
        notDefined.push(`${where}:${diagnostic.range.start.line + 1}: ${diagnostic.message}`);
      }
      for (const name of analysis.structure ? scriptNamesIn(analysis.structure, entry.schema) : []) {
        counts.written++;
        const hover = (hoverAt(analysis, name.start + 1, game)?.contents as MarkupContent | undefined)?.value ?? '';
        if (!hover.startsWith(`**${escapeMarkdown(name.name)}**`)) {
          problems.push(`${where}: no hover for ${name.kind} ${name.name}`);
        }
        const definitions = definitionAt(analysis, name.start + 1, game);
        const wrong = definitions.filter((location) => textAt(location) !== name.name);
        if (definitions.length === 0 || wrong.length > 0) {
          problems.push(`${where}: ${name.kind} ${name.name} defined at ${definitions.length} places, ${wrong.length} not at the name`);
        }
      }
    }
    console.log(
      `script names: ${counts.aiscript} AI script and ${counts.order} order names in calls, ${counts.written} names written in scripts; ${notDefined.length} not defined`
    );
    // 2,263 with the mods folder, 2,197 without.
    expect(counts.aiscript + counts.order).toBeGreaterThan(mods ? 2250 : 2150);
    expect(problems.slice(0, 20)).toEqual([]);
    expect(notDefined).toEqual([]);
  });

  it('reports a typo planted in the names calls write, and its preferred fix and fix all write the name back', () => {
    const index = game.index;
    if (!index) {
      throw new Error('no index');
    }
    // What the check and its fix need; the other checks are left out, for time.
    const context = {
      schemas: game.schemas,
      index,
      validateStructure: false,
      validateExpressions: false,
      validateVariables: false,
      validateNames: false,
      validateRemoteCues: false,
      validateCallParameters: false,
    };
    const counts = { planted: 0, fixed: 0, fixedByAll: 0 };
    const problems: string[] = [];
    let seen = 0;
    for (const entry of index.entries()) {
      const text = entry.kind === 'script' ? index.currentText(entry.file) : undefined;
      const structure = text === undefined ? undefined : analyzeText(text).structure;
      if (text === undefined || !structure || entry.kind !== 'script') {
        continue;
      }
      for (const name of scriptNamesIn(structure, entry.schema)) {
        if (name.defines || seen++ % 14 !== 0 || name.name.length < 3) {
          continue;
        }
        // Two neighbouring letters swapped in the middle of every 14th name a call writes.
        const at = Math.floor(name.name.length / 2);
        const swapped = name.name.slice(0, at - 1) + name.name[at] + name.name[at - 1] + name.name.slice(at + 1);
        if (swapped === name.name) {
          continue;
        }
        counts.planted++;
        const where = `${path.basename(entry.file)}: ${swapped}`;
        const analysis = analyzeText(text.slice(0, name.start) + swapped + text.slice(name.end), context, pathToFileURL(entry.file).toString());
        const document = analysis.document;
        const diagnostic = analysis.diagnostics.find((found) => document.offsetAt(found.range.start) === name.start);
        if (diagnostic?.code !== (name.kind === 'script' ? 'aiscript-undefined' : 'order-undefined')) {
          problems.push(`${where} reported as ${diagnostic?.code ?? 'nothing'}`);
          continue;
        }
        const written = (edits: TextEdit[] | undefined): string => TextDocument.applyEdits(document, edits ?? []);
        const preferred = quickFixes(analysis, [diagnostic], game).find((action) => action.isPreferred);
        if (written(preferred?.edit?.changes?.[document.uri]) === text) {
          counts.fixed++;
        } else {
          problems.push(`${where} fixed by ${preferred?.title ?? 'nothing'}`);
        }
        if (written(fixAll(analysis, game)?.edit?.changes?.[document.uri]) === text) {
          counts.fixedByAll++;
        }
      }
    }
    console.log(`script names: ${counts.planted} typos planted, ${counts.fixed} written back by the preferred fix, ${counts.fixedByAll} by fix all`);
    // 160 with the mods folder, 156 without.
    expect(counts.planted).toBeGreaterThan(150);
    expect(problems.slice(0, 20)).toEqual([]);
    // Without the other checks, the planted typo is all fix all has to fix.
    expect(counts.fixedByAll).toBe(counts.planted);
  });

  it('finds every place the most named order and AI script are written, from their definitions, within the ceiling', () => {
    const index = game.index;
    if (!index) {
      throw new Error('no index');
    }
    for (const [kind, name] of [
      ['order', 'Attack'],
      ['script', 'move.generic'],
    ] as [ScriptNameKind, string][]) {
      const definition = scriptNameDefinitions(index, kind, name)[0];
      const text = readFileSync(definition.position.file, 'utf8');
      const analysis = analyzeText(text, {}, pathToFileURL(definition.position.file).toString());
      const document = analysis.document;
      const offset = document.offsetAt(definition.position) + 1;
      const references = referencesAt(analysis, offset, game);
      const definitions = scriptNameDefinitions(index, kind, name).map((found) => found.position);
      const calls = index.scriptNameReferences(kind === 'script' ? 'aiscript' : 'order', name).map((found) => found.position);
      // And the literals of patches' paths that select a call by the name, `create_order[@id="'Attack'"]`.
      const places = [...definitions, ...calls].map((position) => {
        const start = documentOf(pathToFileURL(position.file).toString()).offsetAt(position);
        return { file: position.file, start, end: start + name.length };
      });
      const mirrored = pathMirrors(places, index).length;
      const best = bestOf(5, () => referencesAt(analysis, offset, game));
      console.log(
        `${kind} ${name}: ${references.length} places (${calls.length} named by calls, ${mirrored} in patches' paths) in ${best.toFixed(1)} ms best of 5`
      );
      expect(references.length).toBe(definitions.length + calls.length + mirrored);
      expect(references.filter((location) => textAt(location) !== name).map((location) => location.uri)).toEqual([]);
      expect(best).toBeLessThan(fileCeilingMs);
    }
  });
});
