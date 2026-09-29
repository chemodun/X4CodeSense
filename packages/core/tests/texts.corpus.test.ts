/**
 * Corpus gate for texts against the extracted vanilla game (X4_EXTRACTED) and a folder of extensions
 * (X4_MODS), never committed: the texts load quickly, every text reference of the vanilla scripts and
 * game data resolves but for the known ones, and the extensions' scripts resolve against their own texts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData, loadTexts, parseXml, textReferencesIn, type TextDatabase } from '../src';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

function xmlFilesIn(folder: string): string[] {
  return existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => name.toLowerCase().endsWith('.xml'))
        .map((name) => path.join(folder, name))
    : [];
}

/** `{page, id}` references of a file outside XML comments that the texts lack, as `{page,id} (file)`. */
function unresolvedIn(file: string, texts: TextDatabase): string[] {
  const text = readFileSync(file, 'utf8');
  const comments = parseXml(text).comments;
  return textReferencesIn(text)
    .filter((reference) => !comments.some((comment) => reference.start >= comment.start && reference.start < comment.end))
    .filter((reference) => !texts.has(reference.page, reference.id))
    .map((reference) => `{${reference.page},${reference.id}} (${path.basename(file)})`);
}

describe.skipIf(!extracted)('texts on the vanilla corpus', () => {
  const root = extracted ?? '';

  it('loads the vanilla texts quickly', () => {
    const started = performance.now();
    const texts = loadTexts(root);
    const elapsed = performance.now() - started;
    console.log(`loaded ${texts.textCount} texts on ${texts.pages().length} pages from ${texts.fileCount} file(s) in ${elapsed.toFixed(0)} ms`);
    expect(texts.textCount).toBeGreaterThan(70000);
    expect(texts.languageNames.get('44')).toBe('English');
    expect(elapsed).toBeLessThan(2000);
  });

  it('resolves every text reference of the vanilla scripts', () => {
    const game = loadGameData(root);
    const found: string[] = [];
    for (const folder of ['md', 'aiscripts']) {
      for (const file of xmlFilesIn(path.join(root, folder))) {
        const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas: game.schemas, properties: game.properties, texts: game.texts });
        for (const diagnostic of analysis.diagnostics) {
          if (diagnostic.code === 'text-undefined') {
            found.push(`${diagnostic.message} (${path.basename(file)})`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  it('resolves every text reference of the game data but the known one', () => {
    const texts = loadTexts(root);
    const found = xmlFilesIn(path.join(root, 'libraries')).flatMap((file) => unresolvedIn(file, texts));
    // An example in the documentation of a property, not a reference.
    expect(found).toEqual(['{123,456} (scriptproperties.xml)']);
  }, 120_000);

  it.skipIf(!mods)(
    'resolves the text references of the extensions against the game and their own texts',
    () => {
      const folder = mods ?? '';
      const game = loadGameData(root, { extensionFolders: [folder] });
      const found: string[] = [];
      let scripts = 0;
      for (const extension of readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
        for (const scriptFolder of ['md', 'aiscripts']) {
          for (const file of xmlFilesIn(path.join(folder, extension.name, scriptFolder))) {
            const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas: game.schemas, properties: game.properties, texts: game.texts });
            if (!analysis.detection.script) {
              continue;
            }
            scripts++;
            for (const diagnostic of analysis.diagnostics) {
              if (diagnostic.code === 'text-undefined') {
                found.push(`${diagnostic.message} (${extension.name}/${path.basename(file)})`);
              }
            }
          }
        }
      }
      expect(scripts).toBeGreaterThan(50);
      expect(found).toEqual([]);
    },
    120_000
  );
});
