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
    // `not @$localtarget.pilot.command or $localtarget.pilot.command.value …`: `command` alone is no property,
    // only `command.value` and the others; under `@` it is null, so the test is always true.
    "expression-unknown-property: 'entity' has no property 'command', only command.value, command.param and command.param2 (order.move.recon.xml)",
    "expression-unknown-property: 'this' has no property 'id' (move.attack.object.capital.steering.xml)",
  ];

  /** The same for the DLCs' scripts. */
  const knownDlcFindings = [
    // `player.entity` is an entity; scriptproperties.xml gives `dynamicinterior` to `room` only.
    "expression-unknown-property: 'entity' has no property 'dynamicinterior' (story_yaki.xml)",
    // `md.GS_Pirate2.$SilenceOtherPrisoner?`: no `md.<script>.$variable` form exists, written once in all of vanilla.
    "expression-unknown-property: 'md' has no property 'GS_Pirate2' (setup_dlc_pirate.xml)",
  ];

  it('reports only the known findings through the analysis', () => {
    const found = new Set<string>();
    const foundInDlcs = new Set<string>();
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
    let dlcScripts = 0;
    for (const { file, source } of scriptFiles(scriptFolders(root, []))) {
      const text = readFileSync(file, 'utf8');
      if (!source.startsWith('ego_dlc_') || !detectDocument(text).script) {
        continue;
      }
      dlcScripts++;
      for (const diagnostic of analyzeText(text, { schemas: game.schemas, properties: game.properties }).diagnostics) {
        const code = String(diagnostic.code);
        if (code.startsWith('expression-')) {
          foundInDlcs.add(`${code}: ${diagnostic.message} (${path.basename(file)})`);
        }
      }
    }
    expect([...found].sort()).toEqual(knownVanillaFindings);
    expect(dlcScripts).toBeGreaterThan(0);
    expect([...foundInDlcs].sort()).toEqual(knownDlcFindings);
  }, 60_000);

  /**
   * What the check of properties on variables of known type reports, beyond the findings above: each a
   * property the script reads that the type it sets lacks, vanilla's own or one scriptproperties.xml does not
   * describe. A wrong result type guessed for an action shows here: nothing else may appear, in the game, its
   * DLCs or the mods, and an entry that disappears must be removed here.
   */
  const knownTypedFindings = [
    // scriptproperties.xml gives `group` no `operational`; read as `group.{$numeric}`, the operational-th member,
    // until a bare name stopped fitting a placeholder of a datatype. A gap of the file or a slip of the script.
    "dlc story_yaki.xml: expression-unknown-property: 'group' has no property 'operational' ($SecretServiceStationDockingAreas is a group, set by find_dockingbay at line 719)",
    "game boarding.pod.return.xml: expression-unknown-property-guessed: 'dockingbay' has no property 'component' (if $dock is a dockingbay, as guessed from find_dockingbay at line 47)",
    // Vanilla's slip: `$TextTable.objective` for `$TextTable.$objective`, the key the same file sets and reads
    // elsewhere. A table's keys are read with `$` or braces; a bare name was taken for its `{$key}` until it
    // stopped fitting a placeholder that is a whole property name.
    "game gm_escort.xml: expression-unknown-property: 'table' has no property 'objective' ($TextTable is a table, set by param at line 182)",
    "game gm_patrol.xml: expression-unknown-property: 'table' has no property 'objective' ($TextTable is a table, set by param at line 186)",
    "game lib.find.sectors.inrange.xml: expression-unknown-property: 'controllable' has no property 'destination' ($refobject is a controllable, set by param at line 4)",
    // The ones below are read under `@` (reported there too since a property the type lacks is still read):
    // `@$refobject.issuperhighway`, a property of zones, used as a test of the type.
    "game lib.find.sectors.inrange.xml: expression-unknown-property: 'controllable' has no property 'issuperhighway' ($refobject is a controllable, set by param at line 4)",
    "game mainmenu.xml: expression-unknown-property: 'buildmodule' has no property 'neededsequenceresources' ($BuildModule is a buildmodule, set by set_value at line 92)",
    // `@$leaderpilot.escortgroup.indexof.{…}`, three times: scriptproperties.xml gives no datatype `escortgroup`.
    "game order.fight.escort.xml: expression-unknown-property: 'entity' has no property 'escortgroup' ($leaderpilot is an entity, set by set_value at line 352)",
    // `@$TradeOrder.available` and `@$TradeOrder.tradedeal` in debug texts, on an order guessed from create_trade_order.
    "game rml_barterwares.xml: expression-unknown-property-guessed: 'order' has no property 'available' (if $TradeOrder is an order, as guessed from create_trade_order at line 1143)",
    "game rml_barterwares.xml: expression-unknown-property-guessed: 'order' has no property 'tradedeal' (if $TradeOrder is an order, as guessed from create_trade_order at line 1143)",
    // The mod's slip: `$LocModules.macro.{$C}` for `$LocModules.{$C}.macro`, which the same line writes next.
    "mods deadairdynamicuniverse.xml: expression-unknown-property: 'constructionsequence' has no property 'macro' ($LocModules is a constructionsequence, set by set_value at line 9457)",
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
        if (String(diagnostic.code).startsWith('expression-unknown-property') && typedMessage.test(String(diagnostic.message))) {
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
    expect([...found].sort()).toEqual(knownTypedFindings.filter((finding) => mods || !finding.startsWith('mods ')));
    // The variables give no other finding than the analysis without them.
    expect([...others].sort()).toEqual(knownVanillaFindings);
    // On 9.00 (of 28,745, 12,710 and 5,467 variables): raise these when the model learns to tell more, never lower them.
    expect(typed.game).toBeGreaterThanOrEqual(6245);
    expect(typed.dlc).toBeGreaterThanOrEqual(5398);
    if (mods) {
      expect(typed.mods).toBeGreaterThanOrEqual(1466);
    }
  }, 120_000);
});
