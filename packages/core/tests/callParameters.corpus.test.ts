/**
 * Corpus gate for the parameters of calls, over the scripts of the extracted game with its DLCs
 * (X4_EXTRACTED) and of a folder of extensions (X4_MODS), never committed. The elements that call with
 * `<param>`s are those of the schemas; every call that names its target literally finds it, every
 * parameter it passes that the target declares leads to that declaration, and signature help lists them
 * all. The calls that do not find their target and the parameters no target declares are pinned, with
 * their reasons; `param-unknown` reports exactly the latter.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  attributeNamed,
  callElements,
  callParameterAt,
  callsNotToScripts,
  callSignatureHelp,
  callTarget,
  callTargetLabel,
  isCall,
  loadGameData,
  rootElementName,
  validateCallParameters,
  type ScriptSchema,
  type XsdElement,
} from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

/**
 * Calls that name a target no script defines: the game's own, calling libraries no file of the game or
 * its DLCs has (removed, the calls left behind).
 */
const knownUnresolved = [
  'gmc_dynamic.xml: run_actions Setup_Landmark_Item',
  'gmc_dynamic.xml: run_actions Setup_Landmark_Item',
  'gmc_dynamic.xml: run_actions Setup_Station_HiddenKeycard',
  'gmc_dynamic.xml: run_actions Setup_Station_RumoursNPC',
  'scenario_hub.xml: run_actions Setup_Character_PlayerNPC_female',
  'scenario_hub.xml: run_actions Setup_Character_PlayerNPC_male',
];

/**
 * Parameters passed that the target does not declare, as `param-unknown` reports them. The game's: calls
 * left behind when the library changed (`ClaimPlot` takes `ObjectiveText`, `PlotSector`, `PlotOffset`
 * now; `Reputation` has no `ObjectiveText`). In the mods folder: `protectsector` passes parameters of
 * another mod's version of the attack orders, which no file of the folder declares.
 */
const knownUndeclared = [
  "gm_claimplot.xml: 'Page' is not a parameter of library 'md.RML_ClaimPlot.ClaimPlot'",
  "gm_claimplot.xml: 'PlotLocation' is not a parameter of library 'md.RML_ClaimPlot.ClaimPlot'",
  "gm_claimplot.xml: 'TextOffset' is not a parameter of library 'md.RML_ClaimPlot.ClaimPlot'",
  "gm_reputation.xml: 'ObjectiveText' is not a parameter of library 'md.RML_Reputation.Reputation'",
];
const knownUndeclaredInMods = [
  "order.fight.protect.sector.xml: 'kAAITParam_isAvoidHighRisk' is not a parameter of order 'Attack' of 'order.fight.attack.object'",
  "order.fight.protect.sector.xml: 'kAAITParam_isAvoidHighRisk' is not a parameter of order 'Attack' of 'order.fight.attack.object'",
  "order.fight.protect.sector.xml: 'kAAITParam_isAvoidHighRisk' is not a parameter of order 'TacticalOrder' of 'order.fight.tactical'",
  "order.fight.protect.sector.xml: 'kAAITParam_isAvoidHighRisk' is not a parameter of script 'order.fight.attack.object'",
  "order.fight.protect.sector.xml: 'kAAITParam_isStepForwardWithdraw' is not a parameter of order 'Attack' of 'order.fight.attack.object'",
  "order.fight.protect.sector.xml: 'kAAITParam_isStepForwardWithdraw' is not a parameter of script 'order.fight.attack.object'",
];

/** Elements whose `param` children take a `value`: those that pass parameters to what they name. */
function callingElements(root: XsdElement | undefined): Set<string> {
  const found = new Set<string>();
  const seen = new Set<XsdElement>();
  const pending = root ? [root] : [];
  while (pending.length > 0) {
    const declaration = pending.pop() as XsdElement;
    if (seen.has(declaration)) {
      continue;
    }
    seen.add(declaration);
    for (const [name, child] of declaration.contentModel.declarations) {
      if (name === 'param' && child.attributes.get('value')?.required) {
        found.add(declaration.name);
      }
      pending.push(child);
    }
  }
  return found;
}

describe.skipIf(!extracted)('call parameters on the corpus', { timeout: 300_000 }, () => {
  const game = loadGameData(extracted ?? '', { extensionFolders: mods ? [mods] : [], index: true });

  it('knows every element of the schemas that calls with parameters', () => {
    for (const schema of ['aiscripts', 'md'] as ScriptSchema[]) {
      const xsd = game.schemas.schemas[schema];
      const calling = [...callingElements(xsd?.root(rootElementName[schema]))].filter((name) => !callsNotToScripts.includes(name)).sort();
      expect(calling).toEqual(callElements(schema).sort());
    }
  });

  it('finds what each call names literally, leads each declared parameter to its declaration, and lists them in signature help', () => {
    const index = game.index;
    if (!index) {
      throw new Error('no index');
    }
    const counts = { calls: 0, resolved: 0, passed: 0, declared: 0 };
    const unresolved: string[] = [];
    const undeclared: string[] = [];
    const problems: string[] = [];
    const documents = new Map<string, TextDocument>();
    const textAt = (uri: string, range: Parameters<TextDocument['getText']>[0]): string => {
      let document = documents.get(uri);
      if (!document) {
        document = TextDocument.create(uri, 'xml', 0, readFileSync(fileURLToPath(uri), 'utf8'));
        documents.set(uri, document);
      }
      return document.getText(range);
    };
    let slowest = { ms: -1, run: (): unknown => undefined };
    for (const entry of index.entries()) {
      if (entry.kind !== 'script') {
        continue;
      }
      const where = path.basename(entry.file);
      // The structure alone: what the features read.
      const analysis = analyzeText(readFileSync(entry.file, 'utf8'), {}, pathToFileURL(entry.file).toString());
      const calls = new Set(callElements(entry.schema));
      for (const call of analysis.structure?.elements ?? []) {
        const written = calls.has(call.name)
          ? attributeNamed(call, call.name === 'cue' || call.name === 'run_actions' ? 'ref' : call.name === 'create_order' ? 'id' : 'name')?.value.trim()
          : undefined;
        if (!written) {
          continue;
        }
        counts.calls++;
        const literal = /^'[^'$%{}[\]]+'$/.test(written) || /^(?:md\.\w+\.)?\w+$/.test(written);
        const started = performance.now();
        const target = callTarget(analysis, call, index);
        const ms = performance.now() - started;
        if (ms > slowest.ms) {
          slowest = { ms, run: () => callSignatureHelp(analysis, call.start + 1, game) };
        }
        if (!target) {
          if (literal) {
            unresolved.push(`${where}: ${call.name} ${written}`);
          }
          continue;
        }
        counts.resolved++;
        const label = callSignatureHelp(analysis, call.start + 1, game)?.signatures[0];
        if (!label || label.parameters?.length !== target.parameters.length) {
          problems.push(`${where}: signature of ${target.name} lists ${label?.parameters?.length} of ${target.parameters.length}`);
        }
        for (const param of call.children.filter((child) => child.name === 'param')) {
          const name = attributeNamed(param, 'name');
          if (!name || name.value.trim() === '') {
            continue;
          }
          counts.passed++;
          const found = callParameterAt(analysis, name.valueStart + 1, game);
          if (!found?.declared) {
            undeclared.push(`${where}: '${name.value.trim()}' is not a parameter of ${callTargetLabel(target)}`);
            continue;
          }
          counts.declared++;
          const text = textAt(found.declared.location.uri, found.declared.location.range);
          if (text !== found.name) {
            problems.push(`${where}: ${found.name} declared as '${text}'`);
          }
        }
      }
    }
    const best = bestOf(5, slowest.run);
    console.log(
      `call parameters: ${counts.calls} calls, ${counts.resolved} found, ${counts.passed} parameters passed, ${counts.declared} declared; ${unresolved.length} not found, ${undeclared.length} not declared; slowest call ${best.toFixed(1)} ms best of 5`
    );
    expect(counts.resolved).toBeGreaterThan(mods ? 6000 : 4000);
    expect(problems.slice(0, 20)).toEqual([]);
    expect(unresolved.sort()).toEqual(knownUnresolved);
    expect(undeclared.sort()).toEqual([...knownUndeclared, ...(mods ? knownUndeclaredInMods : [])].sort());
    expect(best).toBeLessThan(fileCeilingMs);
  });

  it('reports with param-unknown exactly the parameters no target declares, within the ceiling', () => {
    const index = game.index;
    if (!index) {
      throw new Error('no index');
    }
    const reported: string[] = [];
    let most = { calls: -1, run: (): unknown => undefined, file: '' };
    for (const entry of index.entries()) {
      if (entry.kind !== 'script') {
        continue;
      }
      const analysis = analyzeText(readFileSync(entry.file, 'utf8'), {}, pathToFileURL(entry.file).toString());
      for (const diagnostic of validateCallParameters(analysis, index, 'x')) {
        expect(diagnostic.code).toBe('param-unknown');
        reported.push(`${path.basename(entry.file)}: ${diagnostic.message}`);
      }
      const calls = analysis.structure?.elements.filter((element) => isCall(element, entry.schema)).length ?? 0;
      if (calls > most.calls) {
        most = { calls, run: () => validateCallParameters(analysis, index, 'x'), file: entry.file };
      }
    }
    const best = bestOf(5, most.run);
    console.log(`param-unknown: ${reported.length} findings; ${path.basename(most.file)} (${most.calls} calls) checked in ${best.toFixed(1)} ms best of 5`);
    expect(reported.sort()).toEqual([...knownUndeclared, ...(mods ? knownUndeclaredInMods : [])].sort());
    expect(best).toBeLessThan(fileCeilingMs);
  });
});
