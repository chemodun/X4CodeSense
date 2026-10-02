/**
 * A patch document in the context of the file it changes.
 *
 * The target is the file the index names for the patch's folder: the game's file of the same name, or
 * for `extensions/<folder>/...` the named extension's. The target's tree gets the patches of sources the
 * game loads earlier applied first, then this patch; what became of each of its operations is what the
 * diagnostics and the features of a patch document work from. The patched target, written out and
 * analysed as a script, tells what the patch brings where it lands.
 *
 * A patch of a library file (`libraries/wares.xml`) finds the game's file with what the extensions loaded
 * earlier did to it: their patches applied and their merge files merged, a file of another root skipped,
 * as the game does.
 */
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { PatchTarget, ScriptIndex } from '../project/scriptIndex';
import type { XmlElement } from '../xml/xmlStructure';
import { writePatchedTree, type PatchedText } from './patchedDocument';
import { applyPatch, documentTree, mergeFile, type PatchNode, type PatchOperation, type PatchSource } from './patchTree';

export interface PatchAnalysis {
  /** The patch document. */
  source: PatchSource;
  /** The file the patch changes, or why there is none. */
  target: PatchTarget;
  /** The patches applied before this one, and the merge files merged, in load order. */
  earlier: string[];
  /** The merge files among them. */
  merged: string[];
  /** The target's tree with the earlier patches and this one applied; absent without a target file. */
  document?: PatchNode;
  operations: PatchOperation[];
  /** The patched target written out and analysed; present when an operation of the patch brought something in. */
  patched?: { written: PatchedText; analysis: DocumentAnalysis };
}

/**
 * Applies a patch file to its target, after the patches of the same target from sources loaded earlier.
 * Undefined when the file lies in no folder whose patches the index knows a target for.
 */
export function analyzePatch(patch: PatchSource, index: ScriptIndex): PatchAnalysis | undefined {
  const target = index.patchTarget(patch.file);
  if (!target) {
    return undefined;
  }
  const tree = target.file === undefined ? undefined : earlierTree(patch.file, target.file, index);
  if (target.file === undefined || !tree) {
    return {
      source: patch,
      target: target.file === undefined ? target : { name: target.name, missing: `${target.name} cannot be read` },
      earlier: [],
      merged: [],
      operations: [],
    };
  }
  const { document, earlier, merged, uncertain } = tree;
  return { source: patch, target, earlier, merged, document, operations: applyPatch(document, patch, uncertain) };
}

/** " after 2 earlier patches", " after 1 earlier patch and 1 merge file", or nothing, for messages about a patch. */
export function afterEarlier(patch: Pick<PatchAnalysis, 'earlier' | 'merged'>): string {
  const merges = patch.merged.length;
  const patches = patch.earlier.length - merges;
  const counted = [
    ...(patches > 0 ? [`${patches} earlier patch${patches === 1 ? '' : 'es'}`] : []),
    ...(merges > 0 ? [`${merges} ${patches > 0 ? '' : 'earlier '}merge file${merges === 1 ? '' : 's'}`] : []),
  ];
  return counted.length === 0 ? '' : ` after ${counted.join(' and ')}`;
}

/**
 * The target's tree with the patches and merge files of sources loaded before the patch applied; undefined
 * when the target cannot be read.
 */
function earlierTree(
  patch: string,
  target: string,
  index: ScriptIndex
): { document: PatchNode; earlier: string[]; merged: string[]; uncertain: boolean } | undefined {
  const targetSource = index.parsedFile(target);
  if (!targetSource) {
    return undefined;
  }
  const document = documentTree({ file: target, ...targetSource });
  const earlier: string[] = [];
  const merged: string[] = [];
  let uncertain = false;
  for (const before of index.patchesBefore(patch, target)) {
    const source = index.parsedFile(before.file);
    if (!source) {
      uncertain = true;
      continue;
    }
    if (source.structure.roots[0]?.name === 'diff') {
      const operations = applyPatch(document, { file: before.file, ...source }, uncertain);
      uncertain ||= operations.some((operation) => operation.status === 'unknown');
      earlier.push(before.file);
    } else if (mergeFile(document, { file: before.file, ...source })) {
      earlier.push(before.file);
      merged.push(before.file);
    }
  }
  return { document, earlier, merged, uncertain };
}

/** The target's tree as the patch finds it: the earlier patches applied, none of its own operations. Built anew. */
export function treeBeforePatch(patch: PatchAnalysis, index: ScriptIndex): PatchNode | undefined {
  const target = patch.target.file;
  return target === undefined ? undefined : earlierTree(patch.source.file, target, index)?.document;
}

/**
 * Visits each operation of a patch with its target's tree as the operation finds it, in order: a tree
 * built once, the operations applied one after the other. `visit` must not change the tree.
 */
export function eachOperationTree(patch: PatchSource, target: string, index: ScriptIndex, visit: (operation: XmlElement, tree: PatchNode) => void): void {
  const tree = earlierTree(patch.file, target, index);
  if (tree) {
    applyPatch(tree.document, patch, tree.uncertain, undefined, (operation) => visit(operation, tree.document));
  }
}

/**
 * The target's tree as an operation of the patch finds it: the earlier patches applied, then the
 * patch's operations before this one. Built anew, since the patch's tree holds all its changes.
 */
export function treeBefore(patch: PatchAnalysis, operation: XmlElement, index: ScriptIndex): PatchNode | undefined {
  const target = patch.target.file;
  const tree = target === undefined ? undefined : earlierTree(patch.source.file, target, index);
  if (!tree) {
    return undefined;
  }
  applyPatch(tree.document, patch.source, tree.uncertain, operation);
  return tree.document;
}

/** A stretch of the patched text copied from the patch exactly as the patch has it. */
export interface OwnPiece {
  /** Offsets in the patched text. */
  start: number;
  end: number;
  /** Where the stretch starts in the patch. */
  patchStart: number;
  /** When what the patch brings in is written at another column: the indentation of its lines here, and in the patch. */
  indent?: { side: string; patch: string };
}

/** The file a patch changes, written out as the game loads it before the patch and after it. */
export interface PatchComparison {
  /** How the patch names the file: `md/setup.xml`. */
  name: string;
  file: string;
  /** With the earlier patches applied. */
  before: string;
  /** With this patch applied too. */
  after: string;
  /** The stretches of `after` that the patch wrote as they are in it, in text order: a caret or an edit there has its place in the patch. */
  own: OwnPiece[];
}

/**
 * The target of a patch before and after it, both written out the same way, so that only what the patch
 * changes differs between them. Undefined when the patch has no target file.
 */
export function comparePatch(patch: PatchAnalysis, index: ScriptIndex): PatchComparison | undefined {
  const file = patch.target.file;
  const tree = file === undefined || !patch.document ? undefined : earlierTree(patch.source.file, file, index);
  if (file === undefined || !tree || !patch.document) {
    return undefined;
  }
  const after = patch.patched?.written ?? writePatchedTree(patch.document);
  const source = patch.source;
  // A value that had to be escaped is not the patch's text, and the name of an attribute a patch sets is
  // copied from the operation's `sel` or `type`: an edit there does not change what the side shows.
  const startTags = patch.operations.map((operation) => operation.element);
  const own = after.pieces
    .filter(
      (piece) =>
        piece.source === source &&
        piece.end - piece.start === piece.sourceEnd - piece.sourceStart &&
        after.text.startsWith(source.text.slice(piece.sourceStart, piece.sourceEnd), piece.start) &&
        !startTags.some((element) => element.start <= piece.sourceStart && piece.sourceEnd <= element.startTagEnd)
    )
    .map((piece) => ({
      start: piece.start,
      end: piece.end,
      patchStart: piece.sourceStart,
      ...(piece.shift ? { indent: { side: piece.shift.to, patch: piece.shift.from } } : {}),
    }));
  return { name: patch.target.name, file, before: writePatchedTree(tree.document).text, after: after.text, own };
}
