/**
 * Corpus gate for labels, cues and interrupt library items against the extracted vanilla game
 * (X4_EXTRACTED) and a folder of extensions (X4_MODS), never committed: with the default settings,
 * vanilla yields exactly the known list and the extensions yield nothing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeText, collectNames, loadGameData, type GameData, type ScriptSchema } from '../src';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;
const codes = ['label-undefined', 'name-duplicate', 'cue-undefined'];

interface ScriptFile {
  path: string;
  schema: ScriptSchema;
}

function scriptsIn(folder: string): ScriptFile[] {
  const files: ScriptFile[] = [];
  for (const schema of ['md', 'aiscripts'] as ScriptSchema[]) {
    const directory = path.join(folder, schema);
    if (existsSync(directory)) {
      for (const name of readdirSync(directory).filter((file) => file.toLowerCase().endsWith('.xml'))) {
        files.push({ path: path.join(directory, name), schema });
      }
    }
  }
  return files;
}

/** Every `<code>: <message> (<file>)` the name checks report on the files with the default settings. */
function findings(game: GameData, files: readonly ScriptFile[]): { found: string[]; scripts: number; occurrences: number; collectTime: number } {
  const found: string[] = [];
  let scripts = 0;
  let occurrences = 0;
  let collectTime = 0;
  for (const file of files) {
    const analysis = analyzeText(readFileSync(file.path, 'utf8'), { schemas: game.schemas, properties: game.properties });
    if (!analysis.detection.script) {
      continue;
    }
    scripts++;
    const started = performance.now();
    occurrences += collectNames(analysis, file.schema, game.schemas.schemas[file.schema], game.properties).occurrences.length;
    collectTime += performance.now() - started;
    for (const diagnostic of analysis.diagnostics) {
      if (codes.includes(String(diagnostic.code))) {
        found.push(`${diagnostic.code}: ${diagnostic.message} (${path.basename(file.path)})`);
      }
    }
  }
  return { found: found.sort(), scripts, occurrences, collectTime };
}

describe.skipIf(!extracted)('named items on the vanilla corpus', () => {
  let game: GameData;

  beforeAll(() => {
    game = loadGameData(extracted ?? '');
  });

  /**
   * What the name checks report on vanilla 9.00: only unknown cue names, each a defect of vanilla
   * itself; undefined labels and duplicate names do not occur. An entry that disappears must be removed
   * here, and a new one needs an explanation before it is added.
   */
  const unknown = (name: string, file: string): string => `cue-undefined: '${name}' is no keyword and no cue of this script (${file})`;
  const knownVanillaFindings = [
    // `md.GM_Ambush.GenerateGenericMission` in a cue whose condition is `false`; the script has no such cue.
    unknown('GenerateGenericMission', 'gm_ambush.xml'),
    // `md.GM_Destroy_Matching_Objects.RemoveTarget`: only gm_ambush.xml and gm_destroy_objects.xml have that cue.
    unknown('RemoveTarget', 'gm_destroy_matching_objects.xml'),
    // `cargo.{$ci}` written for `$cargo.{$ci}` in two debug texts.
    unknown('cargo', 'mc_management.xml'),
    unknown('cargo', 'mc_management.xml'),
    // A cue of story_paranid.xml named without `md.Story_Paranid.`.
    unknown('Esc_3_Deliver_Resources_Ref', 'story_diplomacy_intro.xml'),
    // `tags="[fighter, light]"`: vanilla writes `[tag.fighter, tag.light]` 92 times elsewhere.
    unknown('fighter', 'story_diplomacy_intro.xml'),
    unknown('light', 'story_diplomacy_intro.xml'),
    // Cues that no vanilla script defines.
    unknown('Tutorial_Advanced_Orders', 'scenario_tutorials.xml'),
    unknown('Tutorial_Advanced_Orders', 'scenario_tutorials.xml'),
    unknown('Tutorial_Advanced_Orders', 'scenario_tutorials.xml'),
    unknown('Tutorial_Advanced_Orders', 'scenario_tutorials.xml'),
    unknown('DEBUG_CheatHQModules', 'terraforming.xml'),
    unknown('Tutorial_Asteroids_Collected', 'tutorial_mining.xml'),
    unknown('RML_Assign_BuilderRef', 'upkeep.xml'),
    unknown('RML_Pickup_Person_Ref', 'upkeep.xml'),
    unknown('RML_Pickup_Person_Ref', 'upkeep.xml'),
    unknown('Assign_Salvage_Subordinate_CleanupHolomap', 'upkeep.xml'),
    unknown('RML_Assign_Salvage_Subordinate_Ref', 'upkeep.xml'),
    // Typos of keywords: `thisthis` for `this`, `factin` for `faction`.
    unknown('thisthis', 'factiongoal_invade_space.xml'),
    unknown('factin', 'x4ep1_mentor_subscription.xml'),
  ].sort();

  it('reports only the known findings on vanilla', () => {
    const { found, scripts, occurrences, collectTime } = findings(game, scriptsIn(extracted ?? ''));
    console.log(`${scripts} vanilla scripts, ${occurrences} named occurrences collected in ${collectTime.toFixed(0)} ms`);
    expect(scripts).toBeGreaterThan(300);
    expect(occurrences).toBeGreaterThan(25000);
    expect(collectTime).toBeLessThan(10000);
    expect(found).toEqual(knownVanillaFindings);
  }, 120_000);

  it.skipIf(!mods)(
    'reports nothing on the scripts of the extensions',
    () => {
      const folder = mods ?? '';
      const files = readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => scriptsIn(path.join(folder, entry.name)));
      const { found, scripts } = findings(game, files);
      expect(scripts).toBeGreaterThan(50);
      expect(found).toEqual([]);
    },
    120_000
  );
});
