/**
 * Corpus gate for the script index against the extracted game with its DLCs (X4_EXTRACTED) and a folder
 * of extensions (X4_MODS), never committed: the index builds quickly, and the checks that use it report
 * exactly the known vanilla mistakes and nothing in the extensions.
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

  it('reports only the known mistakes of the game, and nothing in the extensions', () => {
    const game = loadGameData(root, { extensionFolders: folders, index: true });
    const index = game.index;
    expect(index).toBeDefined();
    const found: string[] = [];
    const inExtensions: string[] = [];
    for (const entry of index?.entries() ?? []) {
      if (entry.kind !== 'script') {
        continue;
      }
      const analysis = analyzeText(readFileSync(entry.file, 'utf8'), { schemas: game.schemas, properties: game.properties, index });
      for (const diagnostic of analysis.diagnostics) {
        const remote = diagnostic.code === 'cue-undefined' && /is known|has no cue/.test(diagnostic.message);
        if (diagnostic.code === 'library-undefined' || remote) {
          const line = `${diagnostic.code}: ${diagnostic.message} (${path.basename(entry.file)})`;
          (entry.source === 'game' || entry.source.startsWith('ego_dlc') ? found : inExtensions).push(line);
        }
      }
    }
    expect(found.sort()).toEqual(knownGameFindings);
    expect(inExtensions).toEqual([]);
  });
});
