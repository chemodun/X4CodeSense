/**
 * Corpus gate for patch documents: every `<diff>` in `md` and `aiscripts` of the game's DLCs (X4_EXTRACTED,
 * with the DLCs' `content.xml` for their load order) and of a folder of extensions (X4_MODS), never
 * committed, applied to the file it changes after the patches loaded before it, and what it brings in
 * checked in the patched file. Every operation of the DLCs applies and their patches get no diagnostic;
 * in the extensions, what does not apply and what is wrong where it lands is pinned with the reason.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData, type AnalysisContext, type DocumentAnalysis } from '../src';
import { bestOf, patchCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

describe.skipIf(!extracted)('patches on the corpus', { timeout: 300_000 }, () => {
  const root = extracted ?? '';
  const game = loadGameData(root, { extensionFolders: mods ? [mods] : [], index: true });
  const index = game.index;
  const context: AnalysisContext = { schemas: game.schemas, properties: game.properties, texts: game.texts };
  if (index) {
    context.index = index;
  }
  const analyses: { file: string; source: string; analysis: DocumentAnalysis; ms: number }[] = [];
  for (const entry of index?.entries() ?? []) {
    if (entry.kind !== 'patch') {
      continue;
    }
    const started = performance.now();
    const analysis = analyzeText(readFileSync(entry.file, 'utf8'), context, pathToFileURL(entry.file).toString());
    analyses.push({ file: entry.file, source: entry.source, analysis, ms: performance.now() - started });
  }
  const isDlc = (source: string): boolean => source.startsWith('ego_dlc_');

  it('applies every operation of the DLCs, with no diagnostic', () => {
    const dlc = analyses.filter((patch) => isDlc(patch.source));
    const operations = dlc.flatMap((patch) => patch.analysis.patch?.operations ?? []);
    console.log(
      `${dlc.length} DLC patch files, ${operations.length} operations, ${operations.filter((operation) => operation.status === 'applied').length} applied`
    );
    expect(dlc.length).toBeGreaterThan(50);
    expect(operations.length).toBeGreaterThan(300);
    expect(operations.filter((operation) => operation.status !== 'applied')).toEqual([]);
    expect(dlc.flatMap((patch) => patch.analysis.diagnostics.map((diagnostic) => `${path.basename(patch.file)}: ${diagnostic.message}`))).toEqual([]);
  });

  /**
   * What patches of the extensions report. An entry that disappears must be removed here, and a new one
   * needs an explanation.
   */
  const knownModFindings = [
    // Inserted conditions: the NPC template entries of `availablepeople.{$x}` have a `role`, no `controlpost`
    // (entities have), so with the `@` the comparison with null always holds.
    "expression-unknown-property: 'npctemplateentry' has no property 'controlpost' (lsrpcr/aiscripts/order.move.wait.object.xml)",
    "expression-unknown-property: 'npctemplateentry' has no property 'controlpost' (lsrpcr/md/conversations.xml)",
    // Written for an older version of the game's script: its attention actions have no such `do_if` in 9.00.
    "patch-no-match: No matching node in aiscripts/order.move.recon.xml: 'do_if[@value='@$localtarget']' selects nothing (deadair_scripts/aiscripts/order.move.recon.xml)",
    // The same fix is at extensions/sn_mod_support_apis/md/, which applies; this copy patches nothing.
    "patch-target-missing: Nothing to patch: the game has no md/interact_menu_api.xml; a patch of sn_mod_support_apis's file goes to extensions/sn_mod_support_apis/md/interact_menu_api.xml (sn_mod_support_apis_temporary_fix/md/interact_menu_api.xml)",
    "patch-target-missing: Nothing to patch: the game has no md/simple_menu_api.xml; a patch of sn_mod_support_apis's file goes to extensions/sn_mod_support_apis/md/simple_menu_api.xml (sn_mod_support_apis_temporary_fix/md/simple_menu_api.xml)",
  ].sort();

  it.skipIf(!mods)('reports exactly the known findings in the extensions', () => {
    const extensions = analyses.filter((patch) => !isDlc(patch.source));
    const operations = extensions.flatMap((patch) => patch.analysis.patch?.operations ?? []);
    console.log(
      `${extensions.length} extension patch files, ${operations.length} operations, ${operations.filter((operation) => operation.status === 'applied').length} applied`
    );
    const findings = extensions.flatMap((patch) =>
      patch.analysis.diagnostics.map(
        (diagnostic) => `${String(diagnostic.code)}: ${diagnostic.message} (${path.relative(mods ?? '', patch.file).replace(/\\/g, '/')})`
      )
    );
    expect(findings.sort()).toEqual(knownModFindings);
  });

  // A patch document's analysis includes the file it changes: twice the ceiling of a file.
  it('analyses the slowest patches within the ceiling', () => {
    const slowest = [...analyses].sort((a, b) => b.ms - a.ms).slice(0, 3);
    for (const patch of slowest) {
      const text = readFileSync(patch.file, 'utf8');
      const target = patch.analysis.patch?.target.file ?? '';
      const targetText = readFileSync(target, 'utf8');
      const best = bestOf(5, () => analyzeText(text, context, pathToFileURL(patch.file).toString()));
      const bestTarget = bestOf(5, () => analyzeText(targetText, context, pathToFileURL(target).toString()));
      console.log(
        `${path.basename(path.dirname(path.dirname(patch.file)))}/${path.basename(patch.file)}: first ${patch.ms.toFixed(0)} ms, best of 5 ${best.toFixed(1)} ms (its target alone ${bestTarget.toFixed(1)} ms), ceiling ${patchCeilingMs} ms`
      );
      expect(best).toBeLessThan(patchCeilingMs);
    }
  });
});
