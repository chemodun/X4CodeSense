/**
 * A patch document in the context of the file it changes.
 *
 * The target is the file the index names for the patch's folder: the game's file of the same name, or
 * for `extensions/<folder>/...` the named extension's. The target's tree gets the patches of sources the
 * game loads earlier applied first, then this patch; what became of each of its operations is what the
 * diagnostics and the features of a patch document work from. The patched target, written out and
 * analysed as a script, tells what the patch brings where it lands.
 */
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { PatchTarget, ScriptIndex } from '../project/scriptIndex';
import type { PatchedText } from './patchedDocument';
import { applyPatch, documentTree, type PatchNode, type PatchOperation, type PatchSource } from './patchTree';

export interface PatchAnalysis {
  /** The patch document. */
  source: PatchSource;
  /** The file the patch changes, or why there is none. */
  target: PatchTarget;
  /** The patches applied before this one, in load order. */
  earlier: string[];
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
  const targetSource = target.file === undefined ? undefined : index.parsedFile(target.file);
  if (target.file === undefined || !targetSource) {
    return {
      source: patch,
      target: target.file === undefined ? target : { name: target.name, missing: `${target.name} cannot be read` },
      earlier: [],
      operations: [],
    };
  }
  const document = documentTree({ file: target.file, ...targetSource });
  const earlier: string[] = [];
  let uncertain = false;
  for (const before of index.patchesBefore(patch.file, target.file)) {
    const source = index.parsedFile(before.file);
    if (!source) {
      uncertain = true;
      continue;
    }
    const operations = applyPatch(document, { file: before.file, ...source }, uncertain);
    uncertain ||= operations.some((operation) => operation.status === 'unknown');
    earlier.push(before.file);
  }
  return { source: patch, target, earlier, document, operations: applyPatch(document, patch, uncertain) };
}
