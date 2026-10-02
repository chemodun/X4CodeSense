/**
 * Corpus gate for the script index against the extracted game with its DLCs (X4_EXTRACTED) and a folder
 * of extensions (X4_MODS), never committed: the index builds quickly, and the checks that use it report
 * exactly the known vanilla mistakes and nothing in the extensions; unset variable reads stay under
 * their ceilings.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData, loadScriptIndex } from '../src';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

describe.skipIf(!extracted)('script index on the corpus', { timeout: 300_000 }, () => {
  const root = extracted ?? '';
  const folders = mods ? [mods] : [];

  it('indexes the game, its DLCs and the extensions quickly', () => {
    const started = performance.now();
    const index = loadScriptIndex(root, folders);
    const elapsed = performance.now() - started;
    console.log(
      `indexed ${index.size} files, ${index.scriptNames('md').length} md and ${index.scriptNames('aiscripts').length} AI scripts in ${elapsed.toFixed(0)} ms`
    );
    expect(index.scriptNames('md').length).toBeGreaterThan(300);
    // Cues that DLC patches add to game scripts are found.
    expect(index.cues('Setup_Gamestarts', 'X4ep1_Gamestart_Boron_Shared')).not.toHaveLength(0);
    expect(elapsed).toBeLessThan(10_000);
  });

  /**
   * What the index checks report on the game and its DLCs. Each entry is a mistake of the game itself;
   * references to the document's own script are pinned in the names gate. An entry that disappears must
   * be removed here, and a new one needs an explanation.
   */
  const knownGameFindings = [
    // The cue does not exist in LIB_Reward_Balancing.
    "cue-undefined: Script 'LIB_Reward_Balancing' has no cue 'GetValue' (lib_create_enemies.xml)",
    // The cue does not exist in Setup.
    "cue-undefined: Script 'Setup' has no cue 'RemovePlayerWeapons' (showcases.xml)",
    // `md.BoronGateDND.count` for the list `md.$BoronGateDND`.
    "cue-undefined: No Mission Director script 'BoronGateDND' is known (setup_dlc_boron.xml)",
  ].sort();

  /**
   * Variables AI scripts of the game read and never set, with what interrupt library items of other
   * files set counted. Each is a mistake of the game itself.
   */
  const knownGameUnsetReads = [
    // The parameter is `$disablehullpercentagethreshold`.
    "Variable '$disablehullpercentage' is never set in this script (fight.attack.object.bigtarget.xml)",
    // The variable is `$TimeOut`.
    "Variable '$Timeout' is never set in this script (move.random.xml)",
    // Left in a debug text.
    "Variable '$myindex' is never set in this script (order.fight.protect.ship.xml)",
    // The order declares no such parameter.
    "Variable '$internalorder' is never set in this script (order.mining.player.xml)",
  ].sort();

  it('reports only the known mistakes of the game, and nothing in the extensions', () => {
    const game = loadGameData(root, { extensionFolders: folders, index: true });
    const index = game.index;
    expect(index).toBeDefined();
    const found: string[] = [];
    const inExtensions: string[] = [];
    const unsetInGameAiScripts: string[] = [];
    // Unset variable reads, which the index turns on: in AI scripts and Mission Director scripts, of the game and of the extensions.
    const unset = { aiscripts: { game: 0, extensions: 0 }, md: { game: 0, extensions: 0 } };
    for (const entry of index?.entries() ?? []) {
      if (entry.kind !== 'script') {
        continue;
      }
      const fromGame = entry.source === 'game' || entry.source.startsWith('ego_dlc');
      const analysis = analyzeText(readFileSync(entry.file, 'utf8'), { schemas: game.schemas, properties: game.properties, index });
      for (const diagnostic of analysis.diagnostics) {
        const remote = diagnostic.code === 'cue-undefined' && /is known|has no cue/.test(diagnostic.message);
        if (diagnostic.code === 'library-undefined' || remote) {
          const line = `${diagnostic.code}: ${diagnostic.message} (${path.basename(entry.file)})`;
          (fromGame ? found : inExtensions).push(line);
        } else if (diagnostic.code === 'variable-undefined') {
          unset[entry.schema][fromGame ? 'game' : 'extensions']++;
          if (fromGame && entry.schema === 'aiscripts') {
            unsetInGameAiScripts.push(`${diagnostic.message} (${path.basename(entry.file)})`);
          }
        }
      }
    }
    console.log(`unset variable reads with the index: AI scripts ${JSON.stringify(unset.aiscripts)}, Mission Director scripts ${JSON.stringify(unset.md)}`);
    expect(found.sort()).toEqual(knownGameFindings);
    expect(inExtensions).toEqual([]);
    expect(unsetInGameAiScripts.sort()).toEqual(knownGameUnsetReads);
    // On vanilla 9.00 with its DLCs and on the mods; lower, never raise. What is left in Mission Director
    // scripts of the game is mostly real: reads of variables only a commented-out block sets, a case typo
    // (`$feedbackvalue`), a `do_all` without its `counter`, the include of a library that does not exist.
    // The extensions: parameters passed to an AI script that it never declares, and some typos. 206 before
    // reads after the include of a library chosen at run time were left alone.
    expect(unset.md.game).toBeLessThanOrEqual(198);
    expect(unset.aiscripts.extensions).toBeLessThanOrEqual(27);
    expect(unset.md.extensions).toBeLessThanOrEqual(9);
  });

  it('indexes what interrupt library items set', () => {
    const game = loadGameData(root, { extensionFolders: folders, index: true });
    const items = [...(game.index?.entries() ?? [])].flatMap((entry) => entry.libraryItems);
    expect(items.filter((item) => item.variables.length > 0).length).toBeGreaterThan(100);
  });
});
