/**
 * Corpus gate for patch documents: every `<diff>` in `md` and `aiscripts` of the game's DLCs (X4_EXTRACTED,
 * with the DLCs' `content.xml` for their load order) and of a folder of extensions (X4_MODS), never
 * committed, applied to the file it changes after the patches loaded before it, and what it brings in
 * checked in the patched file. Every operation of the DLCs applies and their patches get no diagnostic;
 * in the extensions, what does not apply and what is wrong where it lands is pinned with the reason. The
 * editor features see each operation's target as it found it, and what it brings in where it lands. The
 * target before and after each patch, as the client compares them, differ only where the patch changes it.
 * The files in the `libraries` of both, patches and merge files of the game's library files, are applied
 * and merged in load order the same way, their findings pinned.
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
  diskFiles,
  hoverAt,
  loadGameData,
  newProblems,
  offsetInValue,
  parseXml,
  PatchNode,
  pathMirrors,
  pathNamesOf,
  referencesAt,
  scriptSchemaOf,
  type AnalysisContext,
  type ComparisonSide,
  type DocumentAnalysis,
  type PatchComparison,
  type PathMirror,
  type XPathPredicate,
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
  const analyses: { file: string; source: string; analysis: DocumentAnalysis; ms: number; library?: boolean }[] = [];
  for (const entry of index?.entries() ?? []) {
    if (entry.kind !== 'patch') {
      continue;
    }
    const started = performance.now();
    const analysis = analyzeText(readFileSync(entry.file, 'utf8'), context, pathToFileURL(entry.file).toString());
    analyses.push({ file: entry.file, source: entry.source, analysis, ms: performance.now() - started });
  }
  // The patches of library files go with the others; their merge files are checked on their own.
  const merges: { file: string; source: string; analysis: DocumentAnalysis }[] = [];
  for (const { file, source } of index?.libraryFiles() ?? []) {
    const started = performance.now();
    const analysis = analyzeText(readFileSync(file, 'utf8'), context, pathToFileURL(file).toString());
    if (analysis.detection.isDiff) {
      analyses.push({ file, source, analysis, ms: performance.now() - started, library: true });
    } else {
      merges.push({ file, source, analysis });
    }
  }
  const isDlc = (source: string): boolean => source.startsWith('ego_dlc_');

  it('applies every operation of the DLCs, with no diagnostic', () => {
    const dlc = analyses.filter((patch) => isDlc(patch.source) && !patch.library);
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
    const extensions = analyses.filter((patch) => !isDlc(patch.source) && !patch.library);
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

  /** What the files in the DLCs' `libraries` report. An entry that disappears must be removed here, and a new one needs an explanation. */
  const knownDlcLibraryFindings = [
    // The Split DLC, loaded before, removes the same blueprints from the tutorial's start; Terran's silent copies are for a game without it.
    ...['pier_l', 'stor_container_s', 'conn_base', 'conn_cross', 'conn_vertical'].map(
      (module) =>
        `patch-no-match: No matching node in libraries/gamestarts.xml after 1 earlier patch: 'ware[@ware='module_par_${module}_01']' selects nothing (silent) (ego_dlc_terran/libraries/gamestarts.xml)`
    ),
  ];

  /** The same for the extensions'. */
  const knownModLibraryFindings = [
    // The `_da` baskets come from DeadAir_Scripts, which depends on DeadAir_Eco and so loads after it: these silent adds find nothing.
    ...['argon', 'paranid', 'teladi', 'split', 'boron'].map(
      (race) =>
        `patch-no-match: No matching node in libraries/baskets.xml after 4 earlier patches: 'basket[@id='all_container_${race}_da']' selects nothing (silent) (DeadAir_Eco/libraries/baskets.xml)`
    ),
  ];

  it("applies the patches and merges the merge files in the DLCs' and the extensions' libraries, with the known findings", () => {
    const patches = analyses.filter((patch) => patch.library);
    const operations = patches.flatMap((patch) => patch.analysis.patch?.operations ?? []);
    const afterMerges = patches.filter((patch) => (patch.analysis.patch?.merged.length ?? 0) > 0).length;
    console.log(
      `${patches.length} patches of library files, ${operations.length} operations, ${operations.filter((operation) => operation.status === 'applied').length} applied; ${merges.length} merge files, merged before ${afterMerges} of the patches`
    );
    expect(patches.filter((patch) => isDlc(patch.source)).length).toBeGreaterThan(80);
    expect(merges.filter((merge) => isDlc(merge.source)).length).toBeGreaterThan(100);
    expect(operations.length).toBeGreaterThan(1000);
    expect(afterMerges).toBeGreaterThan(30);
    expect(operations.filter((operation) => operation.status === 'unknown' || operation.status === 'invalid')).toEqual([]);
    const findings = [...patches, ...merges].flatMap((file) =>
      file.analysis.diagnostics.map((diagnostic) => `${String(diagnostic.code)}: ${diagnostic.message} (${file.source}/libraries/${path.basename(file.file)})`)
    );
    expect(findings.sort()).toEqual([...knownDlcLibraryFindings, ...(mods ? knownModLibraryFindings : [])].sort());
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
    for (const { file, analysis, library } of analyses) {
      const where = `${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}`;
      const document = analysis.document;
      const operations = analysis.patch?.operations ?? [];
      // Each hover applies the operations before its own again: of a library patch's, up to a thousand and
      // more, ten spread from the first to the last.
      const every = library ? Math.max(1, Math.ceil((operations.length - 1) / 9)) : 1;
      for (const [number, operation] of operations.entries()) {
        const step = operation.path?.steps[operation.path.steps.length - 1];
        if (operation.status !== 'applied' || !operation.sel || !step || (number % every !== 0 && number !== operations.length - 1)) {
          continue;
        }
        // The tree an operation is evaluated on is the one it was applied to: its path selects one node.
        selections++;
        const hover = hoverAt(analysis, offsetInValue(operation.sel, step.test.start), data);
        const told = hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
        if (!told.includes('Selects 1 node')) {
          wrong.push(`${where} ${operation.path?.text ?? ''}: ${told.split('\n')[2] ?? 'no hover'}`);
        }
        // What it brings in is seen in the patched target, and shown at its place in the patch; a library
        // file has no schema to tell of it.
        for (const element of library ? [] : operation.inserted.flatMap((node) => node.element ?? [])) {
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

  // A literal a path compares a value with repeats the value of each element it selects: from the values of
  // a target that its patches' literals name, every literal found repeats the value's text. What a rename
  // edits in such a value it edits in these literals too.
  it('finds the literals of paths that repeat the values they select by', () => {
    const equalValues = (predicate: XPathPredicate): string[] =>
      predicate.kind === 'compare' && predicate.operator === '='
        ? [predicate.value.value]
        : predicate.kind === 'and' || predicate.kind === 'or'
          ? predicate.operands.flatMap(equalValues)
          : [];
    const byTarget = new Map<string, Set<string>>();
    for (const { analysis, library } of analyses) {
      const patch = analysis.patch;
      if (library || !patch?.target.file) {
        continue;
      }
      const literals = byTarget.get(patch.target.file) ?? new Set<string>();
      for (const operation of patch.operations) {
        for (const step of [...(operation.path?.steps ?? []), ...(operation.condition?.path.steps ?? [])]) {
          step.predicates.flatMap(equalValues).forEach((value) => literals.add(value));
        }
      }
      byTarget.set(patch.target.file, literals);
    }
    let mirrors = 0;
    const wrong: string[] = [];
    let slowest = { ms: 0, run: (): unknown => undefined, where: '' };
    for (const [target, literals] of byTarget) {
      const parsed = index?.parsedFile(target);
      if (!index || !parsed) {
        continue;
      }
      const places = parsed.structure.elements.flatMap((element) =>
        element.attributes
          .filter((attribute) => attribute.quote !== '' && literals.has(attribute.value))
          .map((attribute) => ({ file: target, start: attribute.valueStart, end: attribute.valueEnd }))
      );
      const run = (): PathMirror[] => pathMirrors(places, index);
      const started = performance.now();
      const found = run();
      const ms = performance.now() - started;
      if (ms > slowest.ms) {
        slowest = { ms, run, where: path.basename(target) };
      }
      for (const mirror of found) {
        mirrors++;
        const written = index.parsedFile(mirror.file)?.text.slice(mirror.start, mirror.end);
        if (written !== parsed.text.slice(mirror.of.start, mirror.of.end)) {
          wrong.push(`${path.basename(mirror.file)} at ${mirror.start}: '${written ?? ''}' repeats '${parsed.text.slice(mirror.of.start, mirror.of.end)}'`);
        }
      }
    }
    const best = bestOf(5, slowest.run);
    console.log(
      `${mirrors} literals of paths repeat values of ${byTarget.size} targets; slowest ${slowest.where}: first ${slowest.ms.toFixed(1)} ms, best of 5 ${best.toFixed(1)} ms`
    );
    expect(mirrors).toBeGreaterThan(900);
    expect(wrong).toEqual([]);
    expect(best).toBeLessThan(patchCeilingMs);
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
      // Without earlier patches, the target as an editor has its file: to the line breaks, without the byte order mark.
      if (patch.earlier.length === 0) {
        asFiled++;
        if (comparison.before !== diskFiles.readText(patch.target.file)) {
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
    // Not those of library files: written from nothing, the largest takes a minute (the next test edits them).
    for (const { file, analysis, library } of analyses) {
      const comparison = index && analysis.patch && !library ? comparePatch(analysis.patch, index) : undefined;
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

  // As a user edits the side of a library patch where the game's text is, and saves it: a letter in the last
  // attribute value the patch did not write. What is written gives the edited text, or the writer refuses. Of
  // each library file, the patch loaded last, which finds the most earlier files.
  it('writes an edit of the side of a patch of every library file into the patch', () => {
    const last = new Map<string, (typeof analyses)[number]>();
    for (const patch of analyses) {
      const target = patch.analysis.patch?.target.file;
      const known = target === undefined ? undefined : last.get(target);
      if (patch.library && target !== undefined && (patch.analysis.patch?.earlier.length ?? 0) >= (known?.analysis.patch?.earlier.length ?? -1)) {
        last.set(target, patch);
      }
    }
    const refused: string[] = [];
    let written = 0;
    let slowest = { ms: 0, where: '' };
    for (const { file, analysis } of last.values()) {
      const comparison = index && analysis.patch ? comparePatch(analysis.patch, index) : undefined;
      if (!index || !analysis.patch || !comparison) {
        continue;
      }
      const ownAt = (offset: number): boolean => comparison.own.some((piece) => piece.start <= offset && offset < piece.end);
      let at = comparison.after.lastIndexOf('="');
      while (at > 0 && ownAt(at + 2)) {
        at = comparison.after.lastIndexOf('="', at - 1);
      }
      if (at <= 0) {
        continue;
      }
      const where = `${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}`;
      const started = performance.now();
      const result = writePatch(analysis.patch, `${comparison.after.slice(0, at + 2)}Q${comparison.after.slice(at + 2)}`, index);
      const ms = performance.now() - started;
      if (ms > slowest.ms) {
        slowest = { ms, where };
      }
      if (result.text === undefined) {
        refused.push(`${where}: ${result.refused[0]?.reason ?? 'no patch'}`);
      } else {
        written++;
      }
    }
    console.log(`${written} patches of ${last.size} library files written with an edit of their side; slowest ${slowest.where} ${slowest.ms.toFixed(0)} ms`);
    expect(written).toBeGreaterThan(30);
    expect(refused).toEqual([]);
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
    for (const { file, analysis, library } of analyses) {
      // The side of a library file is no script: there is nothing to check in it.
      const comparison = index && analysis.patch && !library ? comparePatch(analysis.patch, index) : undefined;
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

  // A patch document's analysis includes the file it changes: twice the ceiling of a file. The slowest of the
  // scripts' patches, and of the library files'.
  it('analyses the slowest patches within the ceiling', () => {
    const slowest = [false, true].flatMap((library) =>
      analyses
        .filter((patch) => (patch.library ?? false) === library)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 3)
    );
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
