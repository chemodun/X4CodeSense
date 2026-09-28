/**
 * Corpus gate for the expression parser against the extracted vanilla game (X4_EXTRACTED, never committed):
 * every expression attribute of every vanilla script must parse without an error, and the whole corpus
 * must parse fast enough to run on each keystroke of a large document.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeText, isExpressionAttribute, loadGameData, parseExpression, type GameData } from '../src';

const extracted = process.env.X4_EXTRACTED;

function xmlFilesIn(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.xml'))
    .map((name) => path.join(folder, name));
}

describe.skipIf(!extracted)('expression parser on the vanilla corpus', () => {
  const root = extracted ?? '';
  let game: GameData;

  beforeAll(() => {
    game = loadGameData(root);
  });

  it('parses every expression attribute of every script without errors', () => {
    const failures: string[] = [];
    let expressions = 0;
    let parseTime = 0;
    let slowestFile = { name: '', ms: 0 };
    for (const schema of ['md', 'aiscripts']) {
      for (const file of xmlFilesIn(path.join(root, schema))) {
        const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas: game.schemas, validateExpressions: false });
        const started = performance.now();
        for (const [element, declaration] of analysis.declarations) {
          for (const attribute of element.attributes) {
            if (!isExpressionAttribute(declaration.attributes.get(attribute.name)) || attribute.value.trim() === '') {
              continue;
            }
            expressions++;
            const parsed = parseExpression(attribute.value);
            for (const error of parsed.errors) {
              if (failures.length < 40) {
                failures.push(
                  `${path.basename(file)}: ${element.name}@${attribute.name}="${attribute.value.slice(0, 60)}": ${error.message} at ${error.start}`
                );
              }
            }
          }
        }
        const elapsed = performance.now() - started;
        parseTime += elapsed;
        if (elapsed > slowestFile.ms) {
          slowestFile = { name: path.basename(file), ms: elapsed };
        }
      }
    }
    console.log(`parsed ${expressions} expressions in ${parseTime.toFixed(0)} ms, slowest file ${slowestFile.name} ${slowestFile.ms.toFixed(0)} ms`);
    expect(expressions).toBeGreaterThan(50000);
    expect(failures).toEqual([]);
  }, 60_000);

  /**
   * What the analysis reports on vanilla with the script properties at hand. Each entry is a defect of
   * vanilla itself or a property the game has but scriptproperties.xml does not describe; nothing else
   * may appear, and an entry that disappears must be removed here.
   */
  const knownVanillaFindings = [
    "expression-unknown-property: 'boolean' has no property 'isventuremodule' (x4ep1_mentor_subscription.xml)",
    "expression-unknown-property: 'controllable' has no property 'destination' (order.trade.routine.xml)",
    "expression-unknown-property: 'this' has no property 'id' (move.attack.object.capital.steering.xml)",
  ];

  it('reports only the known findings through the analysis', () => {
    const found = new Set<string>();
    for (const schema of ['md', 'aiscripts']) {
      for (const file of xmlFilesIn(path.join(root, schema))) {
        const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas: game.schemas, properties: game.properties });
        for (const diagnostic of analysis.diagnostics) {
          const code = String(diagnostic.code);
          if (code.startsWith('expression-')) {
            found.add(`${code}: ${diagnostic.message} (${path.basename(file)})`);
          }
        }
      }
    }
    expect([...found].sort()).toEqual(knownVanillaFindings);
  }, 60_000);
});
