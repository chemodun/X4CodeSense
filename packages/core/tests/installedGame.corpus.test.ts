/**
 * Corpus gate on an installed game (X4_GAME, never committed): read in place, it opens quickly and gives the
 * game data the extraction (X4_EXTRACTED) gives: the same schemas, script properties and English texts, and
 * every script the extraction has indexed. The installed game may be a later build and hold more DLCs.
 */
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadGameData, openInstalledGame, type GameData, type InstalledGame } from '../src';

const installed = process.env.X4_GAME;
const extracted = process.env.X4_EXTRACTED;
const english = { languages: new Set(['44']) };

describe.skipIf(!installed)('the installed game read in place', { timeout: 120_000 }, () => {
  const root = installed ?? '';
  let files: InstalledGame;
  let game: GameData;
  let opened = 0;
  let loaded = 0;

  beforeAll(() => {
    let started = performance.now();
    files = openInstalledGame(root);
    opened = performance.now() - started;
    started = performance.now();
    game = loadGameData(root, { ...english, files, index: true });
    loaded = performance.now() - started;
    console.log(
      `opened in ${opened.toFixed(0)} ms (${files.bundledExtensions.length} DLCs); game data with ${game.index?.size} indexed files and ${game.texts.textCount} texts in ${loaded.toFixed(0)} ms`
    );
  });

  it('opens quickly and loads without problems', () => {
    expect(opened).toBeLessThan(2000);
    expect(files.bundledExtensions.length).toBeGreaterThan(0);
    expect(game.problems).toEqual([]);
    expect(Object.keys(game.schemas.schemas).sort()).toEqual(['aiscripts', 'md']);
    expect(game.schemas.diff).toBeDefined();
    expect(game.properties).toBeDefined();
    expect(game.texts.textCount).toBeGreaterThan(0);
  });

  it.skipIf(!extracted)('gives the game data of the extraction', () => {
    const fromExtraction = loadGameData(extracted ?? '', { ...english, index: true });
    const relativeTexts = (data: GameData, folder: string): string[] =>
      Object.values(data.schemas.schemas).flatMap((schema) => schema.files.map((file) => `${path.relative(folder, file.path)} ${file.text.length}`));
    expect(relativeTexts(game, root)).toEqual(relativeTexts(fromExtraction, extracted ?? ''));
    expect(game.properties?.keywords.length).toBe(fromExtraction.properties?.keywords.length);
    expect(game.properties?.datatypes.size).toBe(fromExtraction.properties?.datatypes.size);
    // The DLCs the extraction lacks bring texts of their own.
    const textsMissing: string[] = [];
    for (const page of fromExtraction.texts.pages()) {
      const ids = new Set(game.texts.ids(page.id));
      for (const id of fromExtraction.texts.ids(page.id)) {
        if (!ids.has(id)) {
          textsMissing.push(`{${page.id}, ${id}}`);
        }
      }
    }
    expect(textsMissing).toEqual([]);

    const indexed = (data: GameData, folder: string): Set<string> =>
      new Set([...(data.index?.entries() ?? [])].map((entry) => path.relative(folder, entry.file).toLowerCase()));
    const fromInstall = indexed(game, root);
    const missing = [...indexed(fromExtraction, extracted ?? '')].filter((file) => !fromInstall.has(file));
    console.log(`indexed: ${fromInstall.size} files from the installed game, ${fromExtraction.index?.size} from the extraction`);
    expect(missing).toEqual([]);
  });
});
