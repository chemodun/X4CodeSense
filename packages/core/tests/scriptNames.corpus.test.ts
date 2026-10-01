/**
 * Corpus gate for AI script names and order ids, over the scripts of the extracted game with its DLCs
 * (X4_EXTRACTED) and of a folder of extensions (X4_MODS), never committed. Every name a call writes
 * literally is indexed at its place and is defined; every name a script defines or names hovers and leads
 * to its definitions; find references from the definition of the most named order and AI script lists
 * every place, within the ceiling.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Location, MarkupContent } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  definitionAt,
  escapeMarkdown,
  hoverAt,
  loadGameData,
  referencesAt,
  scriptNameDefinitions,
  scriptNamesIn,
  type ScriptNameKind,
} from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

describe.skipIf(!extracted)('AI script names and order ids on the corpus', { timeout: 300_000 }, () => {
  const game = loadGameData(extracted ?? '', { extensionFolders: mods ? [mods] : [], index: true });
  const documents = new Map<string, TextDocument>();
  const textAt = (location: Location): string => {
    let document = documents.get(location.uri);
    if (!document) {
      document = TextDocument.create(location.uri, 'xml', 0, readFileSync(fileURLToPath(location.uri), 'utf8'));
      documents.set(location.uri, document);
    }
    return document.getText(location.range);
  };

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
      const named = index.scriptNameReferences(kind === 'script' ? 'aiscript' : 'order', name).length;
      const best = bestOf(5, () => referencesAt(analysis, offset, game));
      console.log(`${kind} ${name}: ${references.length} places (${named} named by calls) in ${best.toFixed(1)} ms best of 5`);
      expect(references.length).toBe(scriptNameDefinitions(index, kind, name).length + named);
      expect(references.filter((location) => textAt(location) !== name).map((location) => location.uri)).toEqual([]);
      expect(best).toBeLessThan(fileCeilingMs);
    }
  });
});
