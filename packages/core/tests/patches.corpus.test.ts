/**
 * Corpus gate for patch documents: every `<diff>` in `md` and `aiscripts` of the game's DLCs (X4_EXTRACTED,
 * with the DLCs' `content.xml` for their load order) and of a folder of extensions (X4_MODS), never
 * committed, applied to the file it changes after the patches loaded before it, and what it brings in
 * checked in the patched file. Every operation of the DLCs applies and their patches get no diagnostic;
 * in the extensions, what does not apply and what is wrong where it lands is pinned with the reason. The
 * editor features see each operation's target as it found it, and what it brings in where it lands. The
 * target before and after each patch, as the client compares them, differ only where the patch changes it.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it, vi } from 'vitest';
import {
  analyzeComparisonSide,
  analyzeText,
  attributeNamed,
  comparePatch,
  hoverAt,
  loadGameData,
  newProblems,
  offsetInValue,
  parseXml,
  PatchNode,
  pathNamesOf,
  referencesAt,
  scriptSchemaOf,
  type AnalysisContext,
  type ComparisonSide,
  type DocumentAnalysis,
  type PatchComparison,
} from '../src';
import { writePatch } from '../src/patches/patchWriter';
import { bestOf, fileCeilingMs, patchCeilingMs } from './timing';

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

  // The index of a node's children is dropped where a patch changes the tree; any answer it gives that a look at
  // every child would not give, at any moment of applying the earlier patches and each patch, is a wrong one.
  it("finds through the patch trees' index what a look at every child finds", () => {
    const childrenWith = PatchNode.prototype.childrenWith;
    let lookups = 0;
    const wrong: string[] = [];
    const spy = vi.spyOn(PatchNode.prototype, 'childrenWith').mockImplementation(function (this: PatchNode, name, attribute, value) {
      const found = childrenWith.call(this, name, attribute, value);
      const all = this.children.filter((child) => child.kind === 'element' && child.name === name && child.attribute(attribute) === value);
      lookups++;
      if (found.length !== all.length || found.some((node, at) => node !== all[at])) {
        wrong.push(`${path.basename(this.source.file)}: ${name}[@${attribute}='${value}'] gives ${found.length}, every child ${all.length}`);
      }
      return found;
    });
    try {
      for (const { file } of analyses) {
        analyzeText(readFileSync(file, 'utf8'), context, pathToFileURL(file).toString());
      }
    } finally {
      spy.mockRestore();
    }
    console.log(`${analyses.length} patches analysed again, ${lookups} lookups in the index checked`);
    expect(lookups).toBeGreaterThan(1000);
    expect(wrong).toEqual([]);
  });

  it('answers the editor features in every patch as its operations find the target', () => {
    const data = { ...game, ...(index ? { index } : {}) };
    let selections = 0;
    let inserted = 0;
    let names = 0;
    const wrong: string[] = [];
    for (const { file, analysis } of analyses) {
      const where = `${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}`;
      const document = analysis.document;
      for (const operation of analysis.patch?.operations ?? []) {
        const step = operation.path?.steps[operation.path.steps.length - 1];
        if (operation.status !== 'applied' || !operation.sel || !step) {
          continue;
        }
        // The tree an operation is evaluated on is the one it was applied to: its path selects one node.
        selections++;
        const hover = hoverAt(analysis, offsetInValue(operation.sel, step.test.start), data);
        const told = hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
        if (!told.includes('Selects 1 node')) {
          wrong.push(`${where} ${operation.path?.text ?? ''}: ${told.split('\n')[2] ?? 'no hover'}`);
        }
        // What it brings in is seen in the patched target, and shown at its place in the patch.
        for (const element of operation.inserted.flatMap((node) => node.element ?? [])) {
          inserted++;
          const range = hoverAt(analysis, element.nameStart + 1, data)?.range;
          if (!range || document.offsetAt(range.start) !== element.nameStart) {
            wrong.push(`${where} <${element.name}> at ${element.nameStart}: hover ${range ? document.offsetAt(range.start) : 'none'}`);
          }
        }
      }
      // A name a path selects by is found with its other places; a patch without a target names nothing.
      const schema = scriptSchemaOf(analysis);
      for (const name of schema && analysis.structure && analysis.patch?.target.file ? pathNamesOf(analysis.structure, schema) : []) {
        names++;
        const found = referencesAt(analysis, name.start, data);
        if (found.length < 2 || !found.some((location) => location.uri === document.uri && document.offsetAt(location.range.start) === name.start)) {
          wrong.push(`${where} ${name.kind} ${name.name}: ${found.length} places`);
        }
      }
    }
    console.log(`${selections} paths of applied operations, ${inserted} elements brought in, ${names} names in paths`);
    expect(selections).toBeGreaterThan(500);
    expect(inserted).toBeGreaterThan(600);
    expect(names).toBeGreaterThan(400);
    expect(wrong).toEqual([]);
  });

  it('compares every patch with its target, where only what it changes differs', () => {
    const wrong: string[] = [];
    let compared = 0;
    let asFiled = 0;
    let addOnly = 0;
    let slowest = { ms: 0, run: (): void => undefined, where: '' };
    for (const { file, analysis } of analyses) {
      const patch = analysis.patch;
      if (!index || !patch?.target.file) {
        continue;
      }
      const where = `${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}`;
      const run = (): PatchComparison | undefined => comparePatch(patch, index);
      const started = performance.now();
      const comparison = run();
      const ms = performance.now() - started;
      if (ms > slowest.ms) {
        slowest = { ms, run, where };
      }
      if (!comparison) {
        wrong.push(`${where}: nothing to compare`);
        continue;
      }
      compared++;
      // Without earlier patches, the target as its file has it, to the byte order mark and the line breaks.
      if (patch.earlier.length === 0) {
        asFiled++;
        if (comparison.before !== readFileSync(patch.target.file, 'utf8')) {
          wrong.push(`${where}: before is not the file`);
        }
      }
      if (parseXml(comparison.after).problems.length > 0) {
        wrong.push(`${where}: after is not well-formed`);
      }
      // A patch that only adds elements keeps every line of the target in order; a self-closing element that
      // gets children loses its slash.
      const operations = analysis.structure?.roots[0]?.children ?? [];
      if (operations.every((operation) => operation.name === 'add' && !attributeNamed(operation, 'type'))) {
        addOnly++;
        const after = comparison.after.split('\n');
        let at = 0;
        for (const line of comparison.before.split('\n')) {
          const opened = line.replace(/\s*\/>(\r?)$/, '>$1');
          while (at < after.length && after[at] !== line && after[at].replace(/\s*>(\r?)$/, '>$1') !== opened) {
            at++;
          }
          if (at === after.length) {
            wrong.push(`${where}: lost the line ${line.trim()}`);
            break;
          }
          at++;
        }
      }
    }
    const best = bestOf(5, slowest.run);
    console.log(
      `${compared} patches compared with their targets, ${asFiled} of them without earlier patches, ${addOnly} adding elements only; slowest ${slowest.where}: first ${slowest.ms.toFixed(1)} ms, best of 5 ${best.toFixed(1)} ms`
    );
    expect(compared).toBeGreaterThan(100);
    expect(asFiled).toBeGreaterThan(50);
    expect(addOnly).toBeGreaterThan(70);
    expect(wrong).toEqual([]);
    expect(best).toBeLessThan(fileCeilingMs);
  });

  it("finds the patch's own text in the target after it, where typing is typing in the patch", () => {
    const wrong: string[] = [];
    let pieces = 0;
    let characters = 0;
    let typed = 0;
    for (const { file, analysis } of analyses) {
      const patch = analysis.patch;
      const comparison = index && patch?.target.file ? comparePatch(patch, index) : undefined;
      if (!index || !patch || !comparison) {
        continue;
      }
      const where = `${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}`;
      const text = patch.source.text;
      for (const piece of comparison.own) {
        pieces++;
        characters += piece.end - piece.start;
        if (comparison.after.slice(piece.start, piece.end) !== text.slice(piece.patchStart, piece.patchStart + piece.end - piece.start)) {
          wrong.push(`${where}: the piece at ${piece.start} is not the patch's text`);
        }
      }
      // A letter typed at the start of the first attribute value of the patch's own text.
      const piece = comparison.own.find((candidate) => comparison.after.slice(candidate.start, candidate.end).includes('="'));
      if (!piece) {
        continue;
      }
      typed++;
      const at = comparison.after.indexOf('="', piece.start) + 2 - piece.start;
      const edited = analyzeText(text.slice(0, piece.patchStart + at) + 'Q' + text.slice(piece.patchStart + at), context, pathToFileURL(file).toString());
      const after = edited.patch && comparePatch(edited.patch, index)?.after;
      if (after !== comparison.after.slice(0, piece.start + at) + 'Q' + comparison.after.slice(piece.start + at)) {
        wrong.push(`${where}: a letter typed at ${piece.start + at} is not the one change`);
      }
    }
    console.log(`${pieces} pieces of the patches' own text in their targets, ${characters} characters; a letter typed in ${typed} of them`);
    expect(pieces).toBeGreaterThan(500);
    expect(typed).toBeGreaterThan(80);
    expect(wrong).toEqual([]);
  });

  it('writes every patch anew from the text it gives, as an edited side is written into a patch', () => {
    const empty = '<?xml version="1.0" encoding="utf-8"?>\n<diff>\n</diff>\n';
    const refused: string[] = [];
    let written = 0;
    let operations = 0;
    let largest = { size: 0, file: '', after: '' };
    for (const { file, analysis } of analyses) {
      const comparison = index && analysis.patch ? comparePatch(analysis.patch, index) : undefined;
      if (!index || !comparison) {
        continue;
      }
      if (comparison.after.length > largest.size) {
        largest = { size: comparison.after.length, file, after: comparison.after };
      }
      // From an empty patch in its place, the edited side being what the patch gives.
      const blank = analyzeText(empty, context, pathToFileURL(file).toString()).patch;
      const result = blank && writePatch(blank, comparison.after, index);
      if (!result?.text) {
        refused.push(`${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}: ${result?.refused[0]?.reason ?? 'no patch'}`);
        continue;
      }
      written++;
      operations += result.changes.length;
    }
    // One change of the largest target, as a user saves it: the root's name.
    const blank = analyzeText(empty, context, pathToFileURL(largest.file).toString()).patch;
    const edited = largest.after.replace(/(<mdscript[^>]*?name=")/, '$1X');
    const best = bestOf(5, () => blank && index && writePatch(blank, edited, index));
    console.log(
      `${written} patches written anew with ${operations} operations; one change of the largest target (${path.basename(largest.file)}, ${largest.size} characters) best of 5 ${best.toFixed(1)} ms, ceiling ${patchCeilingMs} ms`
    );
    expect(written).toBeGreaterThan(100);
    expect(refused).toEqual([]);
    expect(best).toBeLessThan(patchCeilingMs);
  });

  /**
   * The problems the side with a patch shows: those of the extensions' patches where they land, as the
   * patch documents report them (`knownModFindings`). The targets' own are in the side before the patch too.
   */
  const knownSideProblems = [
    "expression-unknown-property: 'npctemplateentry' has no property 'controlpost' (lsrpcr/conversations.xml:879)",
    "expression-unknown-property: 'npctemplateentry' has no property 'controlpost' (lsrpcr/order.move.wait.object.xml:118)",
  ].sort();

  it('shows in the side with each patch only the problems the file before it does not have', () => {
    const kept: string[] = [];
    let compared = 0;
    let leftOut = 0;
    let largest = { run: (): unknown => undefined, where: '', size: 0, target: '' };
    for (const { file, analysis } of analyses) {
      const comparison = index && analysis.patch ? comparePatch(analysis.patch, index) : undefined;
      if (!comparison) {
        continue;
      }
      compared++;
      const where = `${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}`;
      // Each side as the server analyses it, as the file the patch changes.
      const side = (name: ComparisonSide, text: string): DocumentAnalysis =>
        analyzeComparisonSide(TextDocument.create(`x4codesense-patched:/${comparison.name}`, 'xml', 1, text), name, comparison.file, context);
      const before = side('before', comparison.before);
      const run = (): DocumentAnalysis => side('after', comparison.after);
      const after = run();
      if (comparison.after.length > largest.size) {
        largest = { run, where, size: comparison.after.length, target: comparison.file };
      }
      const problems = newProblems(after, before);
      leftOut += after.diagnostics.length - problems.length;
      kept.push(...problems.map((problem) => `${String(problem.code)}: ${String(problem.message)} (${where}:${problem.range.start.line + 1})`));
    }
    const best = bestOf(5, largest.run);
    const targetText = readFileSync(largest.target, 'utf8');
    const bestTarget = bestOf(5, () => analyzeText(targetText, context, pathToFileURL(largest.target).toString()));
    console.log(
      `${compared} patches with both sides analysed: ${kept.length} problems in the sides with the patch, ${leftOut} of the targets left out; the largest side ${largest.where} (${largest.size} characters) best of 5 ${best.toFixed(1)} ms, its target alone (${targetText.length} characters) ${bestTarget.toFixed(1)} ms`
    );
    expect(compared).toBeGreaterThan(100);
    expect(leftOut).toBeGreaterThan(0);
    expect(kept.sort()).toEqual(mods ? knownSideProblems : []);
    // A side is a whole script: it costs what its target costs when it is opened itself, with all the
    // server knows (the index, texts and variables, which the file ceiling's analysis leaves out).
    expect(best).toBeLessThan(1.5 * bestTarget);
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
