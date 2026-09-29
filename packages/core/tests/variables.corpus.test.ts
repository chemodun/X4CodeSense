/**
 * Corpus gate for the variable model against the extracted vanilla game (X4_EXTRACTED, never committed):
 * every script must yield its tables quickly, and the undefined-variable check, which is off by default,
 * must not report more than it does today. What it still reports on vanilla are flows a single document
 * cannot see: variables written into a cue by another script (`md.Script.Cue.$x`, `run_actions` with a
 * `result` in another cue), library actions included from another script, and cues whose instances are
 * filled by the cue that signals them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeText, collectVariables, loadGameData, type GameData, type ScriptSchema } from '../src';

const extracted = process.env.X4_EXTRACTED;

function xmlFilesIn(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.xml'))
    .map((name) => path.join(folder, name));
}

describe.skipIf(!extracted)('variables on the vanilla corpus', () => {
  const root = extracted ?? '';
  let game: GameData;

  beforeAll(() => {
    game = loadGameData(root);
  });

  it('collects the tables of every script quickly and reports no more undefined reads than known', () => {
    let files = 0;
    let tables = 0;
    let variables = 0;
    let occurrences = 0;
    let undefinedReads = 0;
    let collectTime = 0;
    let slowest = { name: '', ms: 0 };
    const byName = new Map<string, number>();
    for (const schema of ['md', 'aiscripts'] as ScriptSchema[]) {
      for (const file of xmlFilesIn(path.join(root, schema))) {
        files++;
        const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas: game.schemas, properties: game.properties, validateVariables: true });
        const started = performance.now();
        const collected = collectVariables(analysis, schema, game.schemas.schemas[schema], game.properties);
        const elapsed = performance.now() - started;
        collectTime += elapsed;
        if (elapsed > slowest.ms) {
          slowest = { name: path.basename(file), ms: elapsed };
        }
        tables += collected.tables.length;
        occurrences += collected.occurrences.length;
        for (const table of collected.tables) {
          variables += table.variables.size;
        }
        for (const diagnostic of analysis.diagnostics) {
          if (diagnostic.code === 'variable-undefined') {
            undefinedReads++;
            const name = /'(\$\w+)'/.exec(diagnostic.message)?.[1] ?? '?';
            byName.set(name, (byName.get(name) ?? 0) + 1);
          }
        }
      }
    }
    const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(
      `${files} files, ${tables} tables, ${variables} variables, ${occurrences} occurrences collected in ${collectTime.toFixed(0)} ms, slowest ${slowest.name} ${slowest.ms.toFixed(0)} ms; ${undefinedReads} undefined reads, most often ${top.map(([name, count]) => `${name} (${count})`).join(', ')}`
    );
    expect(files).toBeGreaterThan(300);
    expect(tables).toBeGreaterThan(3000);
    expect(variables).toBeGreaterThan(20000);
    expect(occurrences).toBeGreaterThan(150000);
    expect(collectTime).toBeLessThan(15000);
    // 1494 on vanilla 9.00 without the script index (1541 before reads inside interrupt libraries were
    // left to the scripts that use them): lower it when the model learns to see more, never raise it.
    expect(undefinedReads).toBeLessThanOrEqual(1494);
  }, 120_000);
});
