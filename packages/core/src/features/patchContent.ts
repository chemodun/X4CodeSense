/**
 * Editor features in what a patch document brings in.
 *
 * The content of an `add` or `replace`, and the text of one that sets an attribute, is seen where it
 * lands: a caret in it is looked up in the patched target (`PatchAnalysis.patched`), the text the game
 * loads, and what is found there is taken back to the file each piece of that text was written in: the
 * patch document, the target, or a patch applied before. A caret right after a bare `<` has no place in
 * that text; the element names for it come from the element the content lands in.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Location, Range, type CompletionItem, type Hover } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { sourceOffsetAt, sourceRange, writtenOffset, type PatchedText } from '../patches/patchedDocument';
import type { PatchNode, PatchSource } from '../patches/patchTree';
import { attributeNamed, elementAt, elementWithStartTagAt, type XmlElement } from '../xml/xmlStructure';
import type { XsdElement } from '../xsd/schema';

/** A patch document with its patched target. */
export interface PatchedView {
  /** The patch document. */
  patch: DocumentAnalysis;
  /** The patched target. */
  analysis: DocumentAnalysis;
  written: PatchedText;
  /** The patch document as the patched text knows it. */
  source: PatchSource;
}

/** The patched target of a patch document, when the patch brought something in. */
export function patchedViewOf(analysis: DocumentAnalysis): PatchedView | undefined {
  const patch = analysis.patch;
  const patched = patch?.patched;
  return patch && patched ? { patch: analysis, analysis: patched.analysis, written: patched.written, source: patch.source } : undefined;
}

const operationNames: ReadonlySet<string> = new Set(['add', 'replace', 'remove']);

/** True for an operation of a patch document: `add`, `replace` or `remove` right under `<diff>`. */
export function isOperation(analysis: DocumentAnalysis, element: XmlElement | undefined): boolean {
  const root = analysis.structure?.roots[0];
  return element !== undefined && root?.name === 'diff' && element.parent === root && operationNames.has(element.name);
}

/**
 * The patched target at a caret in what the patch brings in, with the caret in its text; undefined
 * elsewhere, also in an operation's own start tag.
 */
export function patchedViewAt(analysis: DocumentAnalysis, offset: number): (PatchedView & { offset: number }) | undefined {
  const view = patchedViewOf(analysis);
  const structure = analysis.structure;
  if (!view || !structure || isOperation(analysis, elementWithStartTagAt(structure, offset))) {
    return undefined;
  }
  const mapped = writtenOffset(view.written, view.source, offset);
  return mapped === undefined ? undefined : { ...view, offset: mapped };
}

/** The range in the patch document of a range of the patched text, when it starts in a piece of the patch. */
export function rangeInPatch(view: PatchedView, range: Range): Range | undefined {
  const document = view.analysis.document;
  const region = sourceRange(view.written, view.source, document.offsetAt(range.start), document.offsetAt(range.end));
  return region && Range.create(view.patch.document.positionAt(region.start), view.patch.document.positionAt(region.end));
}

const sourceDocuments = new WeakMap<PatchSource, TextDocument>();

/** A document of a file a patched tree or text comes from, for its positions. */
export function documentOf(source: PatchSource): TextDocument {
  let document = sourceDocuments.get(source);
  if (!document) {
    document = TextDocument.create(pathToFileURL(source.file).toString(), 'xml', 0, source.text);
    sourceDocuments.set(source, document);
  }
  return document;
}

/** The file a range of the patched text was written in, with the range there; undefined for added text. */
export function placeOf(view: PatchedView, start: number, end: number): { document: TextDocument; start: number; end: number } | undefined {
  const at = sourceOffsetAt(view.written, start);
  const region = at && sourceRange(view.written, at.source, start, end);
  if (!at || !region) {
    return undefined;
  }
  return { document: at.source === view.source ? view.patch.document : documentOf(at.source), ...region };
}

/** A key for a place in a file, the same for any spelling of the file's uri. */
export function placeKey(uri: string, line: number, character: number): string {
  let file = uri;
  try {
    file = uri.startsWith('file:') ? path.resolve(fileURLToPath(uri)).toLowerCase() : uri;
  } catch {
    // Not a path: the uri itself.
  }
  return `${file}|${line}|${character}`;
}

/** Locations found in the patched target, taken to the files: those in its text to where they were written, the others as they are. */
export function locationsInFiles(view: PatchedView, locations: readonly Location[]): Location[] {
  const uri = view.analysis.document.uri;
  const result: Location[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    let found: Location | undefined = location;
    if (location.uri === uri) {
      const document = view.analysis.document;
      const place = placeOf(view, document.offsetAt(location.range.start), document.offsetAt(location.range.end));
      found = place && Location.create(place.document.uri, Range.create(place.document.positionAt(place.start), place.document.positionAt(place.end)));
    }
    const key = found && placeKey(found.uri, found.range.start.line, found.range.start.character);
    if (found && key && !seen.has(key)) {
      seen.add(key);
      result.push(found);
    }
  }
  return result;
}

/** A hover found in the patched target, placed in the patch document. */
export function hoverInPatch(view: PatchedView, hover: Hover): Hover {
  const range = hover.range && rangeInPatch(view, hover.range);
  return range ? { ...hover, range } : { contents: hover.contents };
}

/** Completion items found in the patched target, their edits placed in the patch document; items whose edit has no place there are left out. */
export function completionsInPatch(view: PatchedView, items: readonly CompletionItem[]): CompletionItem[] {
  const result: CompletionItem[] = [];
  for (const item of items) {
    const edit = item.textEdit;
    if (!edit || !('range' in edit)) {
      result.push(item);
      continue;
    }
    const range = rangeInPatch(view, edit.range);
    if (range) {
      result.push({ ...item, textEdit: { range, newText: edit.newText } });
    }
  }
  return result;
}

/** The declaration of the element of the patched text whose start tag begins at the offset. */
function declarationAt(patched: DocumentAnalysis, start: number | undefined): XsdElement | undefined {
  const element = start === undefined || !patched.structure ? undefined : elementAt(patched.structure, start);
  return element?.start === start && element ? patched.declarations.get(element) : undefined;
}

/**
 * For a caret right after a bare `<` in what a patch brings in, where no element was written yet: the
 * declaration of the element the new one lands in, and the names of the elements before it there.
 * Undefined when the content lands nowhere.
 */
export function insertionPointAt(
  analysis: DocumentAnalysis,
  parent: XmlElement | undefined,
  offset: number
): { declaration: XsdElement; previous: string[] } | undefined {
  const patch = analysis.patch;
  const patched = patch?.patched;
  if (!patch || !patched || !parent) {
    return undefined;
  }
  if (!isOperation(analysis, parent)) {
    // Inside an element the patch brings in: that element as it was written into the target.
    const declaration = declarationAt(patched.analysis, writtenOffset(patched.written, patch.source, parent.start));
    return declaration && { declaration, previous: parent.children.filter((child) => child.start < offset).map((child) => child.name) };
  }
  const operation = patch.operations.find((candidate) => candidate.element === parent);
  const into = operation?.status === 'applied' ? operation.parent : undefined;
  const declaration = into && declarationAt(patched.analysis, patched.written.starts.get(into));
  if (!operation || !into || !declaration) {
    return undefined;
  }
  // Where the new element goes among the children: after the content the operation brought before the caret.
  const inserted = operation.inserted;
  const endOf = (node: PatchNode): number => (node.element ?? node.comment)?.end ?? Number.POSITIVE_INFINITY;
  const before = inserted.filter((node) => endOf(node) <= offset);
  let count: number;
  if (before.length > 0) {
    count = into.children.indexOf(before[before.length - 1]) + 1;
  } else if (inserted.length > 0) {
    count = into.children.indexOf(inserted[0]);
  } else {
    const selected = operation.selection?.kind === 'node' ? operation.selection.node : undefined;
    const pos = attributeNamed(parent, 'pos')?.value;
    count =
      pos === 'prepend'
        ? 0
        : selected && pos === 'before'
          ? into.children.indexOf(selected)
          : selected && pos === 'after'
            ? into.children.indexOf(selected) + 1
            : into.children.length;
  }
  const previous = into.children
    .slice(0, Math.max(0, count))
    .filter((node) => node.kind === 'element')
    .map((node) => node.name);
  return { declaration, previous };
}
