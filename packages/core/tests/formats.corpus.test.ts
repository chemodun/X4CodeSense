/**
 * Corpus gate for the arguments of formats over the extracted game with its DLCs (X4_EXTRACTED) and a
 * folder of extensions (X4_MODS), never committed: the game's formats given fewer arguments than they
 * take are exactly the known ones, each explained; those given more are counted.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData, scriptFiles, scriptFolders } from '../src';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

/** The game's debug texts given too few arguments (9.00), by file, line and message. */
const knownMissing = [
  // `%2 … %3` with two arguments: the numbering starts at 2.
  'fight.attack.object.station.xml:108 The format takes 3 arguments but is given 2',
  // `%1 %2 %4 %5` with four arguments: `%3` is skipped.
  'interrupt.attacked.xml:207 The format takes 5 arguments but is given 4',
  // `%1 … %3` with one argument.
  'move.collect.ship.capship.xml:24 The format takes 3 arguments but is given 1',
  // Six `%s` and five arguments.
  'move.gate.xml:469 The format takes 6 arguments but is given 5',
];

describe.skipIf(!extracted)('format arguments on the corpus', { timeout: 120_000 }, () => {
  it('finds the known formats of the game given too few arguments, and counts those given more', () => {
    const game = loadGameData(extracted ?? '', { extensionFolders: mods ? [mods] : [] });
    const counts = { gameUnused: 0, modsMissing: 0, modsUnused: 0, formats: 0 };
    const missing: string[] = [];
    for (const { file } of scriptFiles(scriptFolders(game.folder, mods ? [mods] : []))) {
      const inGame = !path.relative(game.folder, file).startsWith('..');
      const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas: game.schemas, texts: game.texts }, pathToFileURL(file).toString());
      for (const diagnostic of analysis.diagnostics) {
        if (diagnostic.code === 'format-arguments-missing') {
          if (inGame) {
            missing.push(`${path.basename(file)}:${diagnostic.range.start.line + 1} ${diagnostic.message}`);
          } else {
            counts.modsMissing++;
          }
        } else if (diagnostic.code === 'format-arguments-unused') {
          counts[inGame ? 'gameUnused' : 'modsUnused']++;
        }
      }
    }
    console.log(
      `format arguments: game ${missing.length} missing, ${counts.gameUnused} unused; mods ${counts.modsMissing} missing, ${counts.modsUnused} unused`
    );
    expect(missing.sort()).toEqual(knownMissing);
    // Leftovers of debug texts in the game and its DLCs: 29 and 9 in 9.00.
    expect(counts.gameUnused).toBe(38);
    if (mods) {
      // Two logbook entries of the mods folder; extensions change, so these are ceilings.
      expect(counts.modsMissing).toBeLessThanOrEqual(2);
      expect(counts.modsUnused).toBeLessThanOrEqual(12);
    }
  });
});
