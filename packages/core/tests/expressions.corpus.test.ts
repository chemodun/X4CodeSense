/**
 * Corpus gate for the expression parser against the extracted vanilla game (X4_EXTRACTED, never committed):
 * every expression attribute of every vanilla script must parse without an error, and the whole corpus
 * must parse fast enough to run on each keystroke of a large document.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeText, detectDocument, isExpressionAttribute, loadGameData, parseExpression, scriptFiles, scriptFolders, type GameData } from '../src';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

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

  /**
   * What the check of properties on variables of known type reports, beyond the findings above: each a
   * property the script reads that the type it sets lacks, vanilla's own or one scriptproperties.xml does not
   * describe. A wrong result type guessed for an action shows here: nothing else may appear, in the game, its
   * DLCs or the mods, and an entry that disappears must be removed here.
   */
  const knownTypedFindings = [
    "game boarding.pod.return.xml: expression-unknown-property-guessed: 'dockingbay' has no property 'component' (if $dock is a dockingbay, as guessed from find_dockingbay at line 47)",
    "game lib.find.sectors.inrange.xml: expression-unknown-property: 'controllable' has no property 'destination' ($refobject is a controllable, set by param at line 4)",
    "game mainmenu.xml: expression-unknown-property: 'buildmodule' has no property 'neededsequenceresources' ($BuildModule is a buildmodule, set by set_value at line 92)",
    "game move.generic.xml: expression-unknown-property: 'object' has no property 'islocalhighway' ($destination is an object, declared by its param at line 13)",
    "game move.generic.xml: expression-unknown-property: 'object' has no property 'istempzone' ($destination is an object, declared by its param at line 13)",
  ];
  const typedMessage = /\((if )?\$\w+ is an? \w+, /;

  it('reports properties that variables of known type lack only where known, and types enough of them', () => {
    const found = new Set<string>();
    const others = new Set<string>();
    const typed = { game: 0, dlc: 0, mods: 0 };
    const variables = { game: 0, dlc: 0, mods: 0 };
    for (const { file, source } of scriptFiles(scriptFolders(root, mods ? [mods] : []))) {
      const text = readFileSync(file, 'utf8');
      if (!detectDocument(text).script) {
        continue;
      }
      const kind = source === 'game' ? 'game' : source.startsWith('ego_dlc_') ? 'dlc' : 'mods';
      // The names and the parameters of calls are checked elsewhere; leaving them out keeps the suite's load down.
      const analysis = analyzeText(text, {
        schemas: game.schemas,
        properties: game.properties,
        validateVariables: true,
        validateNames: false,
        validateCallParameters: false,
      });
      for (const diagnostic of analysis.diagnostics) {
        if (String(diagnostic.code).startsWith('expression-unknown-property') && typedMessage.test(diagnostic.message)) {
          found.add(`${kind} ${path.basename(file)}: ${diagnostic.code}: ${diagnostic.message}`);
        } else if (kind === 'game' && String(diagnostic.code).startsWith('expression-')) {
          others.add(`${diagnostic.code}: ${diagnostic.message} (${path.basename(file)})`);
        }
      }
      for (const table of analysis.variables?.tables ?? []) {
        for (const variable of table.variables.values()) {
          variables[kind]++;
          if (variable.type) {
            typed[kind]++;
          }
        }
      }
    }
    console.log(
      `variables with a type: game ${typed.game} of ${variables.game}, DLCs ${typed.dlc} of ${variables.dlc}, mods ${typed.mods} of ${variables.mods}`
    );
    expect([...found].sort()).toEqual(knownTypedFindings);
    // The variables give no other finding than the analysis without them.
    expect([...others].sort()).toEqual(knownVanillaFindings);
    // On 9.00 (of 28,745, 12,710 and 5,461 variables): raise these when the model learns to tell more, never lower them.
    expect(typed.game).toBeGreaterThanOrEqual(6218);
    expect(typed.dlc).toBeGreaterThanOrEqual(5348);
    if (mods) {
      expect(typed.mods).toBeGreaterThanOrEqual(1424);
    }
  }, 120_000);
});
