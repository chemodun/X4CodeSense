/**
 * Editor features in the paths of a patch document (`sel` and `if`), and in the attribute name of
 * `add type="@name"`.
 *
 * A path is evaluated on the target as the operation finds it (`treeBefore`): the patches loaded before
 * applied, and the patch's own operations before it. A hover on a step tells what the path selects up to
 * there, each node with its file and line, and the patch that added it; go to definition goes there.
 * Completion offers the element names after `/` and `//`, the attribute names after `@`, and inside
 * `[@name='` the values that attribute has on the nodes the step reaches, such as the names of cues.
 * The name in `type` is an attribute of the element the operation selects: hover and definition show its
 * declaration, completion the attributes the element does not have yet.
 */
import * as path from 'node:path';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, Location, Range, type CompletionItem, type Hover } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { schemaOf, scriptSchemaOf } from '../analysis/positionContext';
import type { GameData } from '../gameData';
import { treeBefore } from '../patches/patchAnalysis';
import { pathNamesOf, type PathName } from '../patches/pathNames';
import type { PatchNode } from '../patches/patchTree';
import {
  attributeWithValueAt,
  elementAt,
  elementWithStartTagAt,
  indexInValue,
  offsetInValue,
  rangeInValue,
  type XmlAttribute,
  type XmlElement,
} from '../xml/xmlStructure';
import { evaluateXPath, parseXPath, parseXPathCondition, type XPath, type XPathSelection } from '../xml/xpath';
import type { XsdElement } from '../xsd/schema';
import { describeAttribute, escapeMarkdown, inlineCode } from './markdown';
import { documentOf, isOperation } from './patchContent';

/** A caret in the `sel` or `if` of an operation. */
interface PathCaret {
  operation: XmlElement;
  attribute: XmlAttribute;
  path: XPath;
  /** The caret's index in the decoded value. */
  index: number;
}

function pathAt(analysis: DocumentAnalysis, offset: number): PathCaret | undefined {
  const structure = analysis.structure;
  const operation = structure && elementWithStartTagAt(structure, offset);
  if (!operation || !isOperation(analysis, operation)) {
    return undefined;
  }
  const attribute = attributeWithValueAt(operation, offset);
  if (!attribute || (attribute.name !== 'sel' && attribute.name !== 'if')) {
    return undefined;
  }
  const path = attribute.name === 'sel' ? parseXPath(attribute.value) : parseXPathCondition(attribute.value).path;
  return { operation, attribute, path, index: indexInValue(attribute, offset) };
}

/** The target's tree as the operation finds it; undefined without the index or a target. */
function treeAt(analysis: DocumentAnalysis, caret: PathCaret, game: GameData): PatchNode | undefined {
  const patch = analysis.patch;
  return patch && game.index ? treeBefore(patch, caret.operation, game.index) : undefined;
}

/** What the first steps of a path select, a problem after them left aside. */
function selectedBy(xpath: XPath, steps: number, tree: PatchNode): XPathSelection<PatchNode>[] {
  return evaluateXPath({ text: xpath.text, absolute: xpath.absolute, steps: xpath.steps.slice(0, steps) }, tree);
}

/** The step of a complete path the caret is on, with what the path selects up to it. */
function stepAt(
  analysis: DocumentAnalysis,
  offset: number,
  game: GameData
): { caret: PathCaret; step: number; selections: XPathSelection<PatchNode>[] } | undefined {
  const caret = pathAt(analysis, offset);
  if (!caret) {
    return undefined;
  }
  const { path: xpath, index } = caret;
  const step = xpath.steps.findIndex((candidate) => index >= candidate.start && index <= candidate.end);
  const found = xpath.steps[step];
  // A step the parser stopped in may lack a predicate, and would select too much.
  const tree = found && !(xpath.problem && xpath.problem.start < found.end) ? treeAt(analysis, caret, game) : undefined;
  return tree && { caret, step, selections: selectedBy(xpath, step + 1, tree) };
}

function nodeText(node: PatchNode): string {
  if (node.kind === 'comment') {
    const text = node.stringValue();
    return `<!--${text.length > 40 ? `${text.slice(0, 37)}...` : text}-->`;
  }
  const name = node.attribute('name');
  return name === undefined ? `<${node.name}>` : `<${node.name} name="${name}">`;
}

function selectionText(selection: XPathSelection<PatchNode>): string {
  switch (selection.kind) {
    case 'node':
      return inlineCode(nodeText(selection.node));
    case 'attribute':
      return `${inlineCode(`${selection.name}="${selection.owner.attribute(selection.name) ?? ''}"`)} of ${inlineCode(nodeText(selection.owner))}`;
    case 'text':
      return `the text of ${inlineCode(nodeText(selection.owner))}`;
  }
}

/** Where a node was written: the document, the range of its name (a comment's whole text), and the file named for a hover. */
function placeOfNode(
  node: PatchNode,
  analysis: DocumentAnalysis,
  game: GameData
): { document: TextDocument; start: number; end: number; label: string } | undefined {
  const region = node.element ? { start: node.element.nameStart, end: node.element.nameEnd } : node.comment;
  const patch = analysis.patch;
  if (!region || !patch) {
    return undefined;
  }
  const source = node.source;
  const file = source.file;
  if (source === patch.source) {
    return { document: analysis.document, ...region, label: 'added by this patch' };
  }
  const label = file === patch.target.file ? path.basename(file) : `added by the patch of ${inlineCode(game.index?.sourceOf(file) ?? path.basename(file))}`;
  return { document: documentOf(source), ...region, label };
}

function ownerOf(selection: XPathSelection<PatchNode>): PatchNode {
  return selection.kind === 'node' ? selection.node : selection.owner;
}

const shownSelections = 5;

/** A caret in `type="@name"` of an `add`: the element the operation selects, with its declaration, and the typed name. */
function addedAttributeAt(
  analysis: DocumentAnalysis,
  offset: number,
  game: GameData
): { owner: PatchNode; declaration?: XsdElement; type: XmlAttribute; from: number; to: number; index: number } | undefined {
  const structure = analysis.structure;
  const operation = structure && elementWithStartTagAt(structure, offset);
  const type = operation && operation.name === 'add' && isOperation(analysis, operation) ? attributeWithValueAt(operation, offset) : undefined;
  const at = type?.name === 'type' ? type.value.indexOf('@') : -1;
  const index = type ? indexInValue(type, offset) : -1;
  const selection = analysis.patch?.operations.find((candidate) => candidate.element === operation)?.selection;
  if (!type || at < 0 || index <= at || !selection) {
    return undefined;
  }
  const owner = ownerOf(selection);
  // As the patched target has it, else by name.
  const patched = analysis.patch?.patched;
  const start = patched?.written.starts.get(owner);
  const element = start === undefined ? undefined : patched?.analysis.structure && elementAt(patched.analysis.structure, start);
  const declaration =
    (element?.start === start && element ? patched?.analysis.declarations.get(element) : undefined) ?? schemaOf(game, analysis)?.anyDeclaration(owner.name);
  const from = at + 1;
  return { owner, ...(declaration ? { declaration } : {}), type, from, to: from + (nameCharacters.exec(type.value.slice(from))?.[0].length ?? 0), index };
}

/** Hover on a step of a path: what the path selects up to there; on the name `type` adds: that attribute. */
export function pathHoverAt(analysis: DocumentAnalysis, offset: number, game: GameData): Hover | undefined {
  const added = addedAttributeAt(analysis, offset, game);
  if (added) {
    const declared = added.declaration?.attributes.get(added.type.value.slice(added.from, added.to));
    const range = rangeInValue(added.type, added.from, added.to);
    return declared
      ? {
          contents: { kind: 'markdown', value: describeAttribute(declared, added.owner.name) },
          range: Range.create(analysis.document.positionAt(range.start), analysis.document.positionAt(range.end)),
        }
      : undefined;
  }
  const found = stepAt(analysis, offset, game);
  if (!found) {
    return undefined;
  }
  const { caret, step, selections } = found;
  const xpath = caret.path;
  const at = xpath.steps[step];
  const last = step === xpath.steps.length - 1;
  const lines = [`**${escapeMarkdown(xpath.text.slice(at.start, at.end).replace(/^\/+/, ''))}**`, ''];
  if (selections.length === 0) {
    lines.push(`Selects nothing${last ? '' : ' up to here'}`);
  } else {
    lines.push(`Selects ${selections.length} node${selections.length === 1 ? '' : 's'}${last ? '' : ' up to here'}:`, '');
    for (const selection of selections.slice(0, shownSelections)) {
      const place = placeOfNode(ownerOf(selection), analysis, game);
      lines.push(`- ${selectionText(selection)}${place ? ` · ${place.label}, line ${place.document.positionAt(place.start).line + 1}` : ''}`);
    }
    if (selections.length > shownSelections) {
      lines.push(`- and ${selections.length - shownSelections} more`);
    }
  }
  const range = rangeInValue(caret.attribute, at.start, at.end);
  return {
    contents: { kind: 'markdown', value: lines.join('\n') },
    range: Range.create(analysis.document.positionAt(range.start), analysis.document.positionAt(range.end)),
  };
}

/**
 * Go to definition on a step of a path: the nodes it selects up to there; on the name `type` adds: its
 * declaration. Undefined when the caret is on neither.
 */
export function pathDefinitionsAt(analysis: DocumentAnalysis, offset: number, game: GameData): Location[] | undefined {
  const added = addedAttributeAt(analysis, offset, game);
  if (added) {
    const location = added.declaration?.attributes.get(added.type.value.slice(added.from, added.to))?.location;
    const found = location && game.locationOf(location);
    return found ? [found] : [];
  }
  if (!pathAt(analysis, offset)) {
    return undefined;
  }
  const found = stepAt(analysis, offset, game);
  const locations: Location[] = [];
  for (const selection of found?.selections ?? []) {
    const place = placeOfNode(ownerOf(selection), analysis, game);
    if (place) {
      locations.push(Location.create(place.document.uri, Range.create(place.document.positionAt(place.start), place.document.positionAt(place.end))));
    }
  }
  return locations;
}

/** Where the caret is in the text of a path before it: in a predicate (where its `[` is), and in a string there. */
function caretState(before: string): { predicate?: number; string?: { start: number; quote: string } } {
  const open: number[] = [];
  for (let at = 0; at < before.length; at++) {
    const character = before[at];
    if (character === "'" || character === '"') {
      const close = before.indexOf(character, at + 1);
      if (close < 0) {
        return { predicate: open[open.length - 1], string: { start: at, quote: character } };
      }
      at = close;
    } else if (character === '[') {
      open.push(at);
    } else if (character === ']') {
      open.pop();
    }
  }
  return { predicate: open[open.length - 1] };
}

/** What a path written so far selects; the document for an empty one, nothing for one that does not parse. */
function contextOf(text: string, tree: PatchNode): XPathSelection<PatchNode>[] {
  if (text.trim() === '') {
    return [{ kind: 'node', node: tree }];
  }
  const xpath = parseXPath(text);
  return xpath.problem ? [] : evaluateXPath(xpath, tree);
}

function forDescendants(node: PatchNode, visit: (node: PatchNode) => void): void {
  for (const child of node.children) {
    visit(child);
    forDescendants(child, visit);
  }
}

/** Counts of names, in the order first seen. */
class Names {
  readonly counts = new Map<string, number>();

  add(name: string): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
}

const nameCharacters = /^[\w.:-]*/;

/**
 * Completion in a path: element names after `/` and `//`, attribute names after `@`, and values of an
 * attribute in a string compared with it. Undefined when the caret is in no path.
 */
export function pathCompletionsAt(analysis: DocumentAnalysis, offset: number, game: GameData): CompletionItem[] | undefined {
  const added = addedAttributeAt(analysis, offset, game);
  if (added) {
    // The attributes the element may have that it does not have yet, besides the one being named.
    const typed = added.type.value.slice(added.from, added.to);
    const present = new Set(added.owner.attributes.map((attribute) => attribute.name).filter((name) => name !== typed));
    const range = rangeInValue(added.type, added.from, added.to);
    const replaced = Range.create(analysis.document.positionAt(range.start), analysis.document.positionAt(range.end));
    return [...(added.declaration?.attributes ?? [])]
      .filter(([name]) => !present.has(name))
      .map(([name, declared]) => ({
        label: name,
        kind: CompletionItemKind.Property,
        documentation: { kind: 'markdown', value: describeAttribute(declared, added.owner.name) },
        textEdit: { range: replaced, newText: name },
      }));
  }
  const caret = pathAt(analysis, offset);
  if (!caret) {
    return undefined;
  }
  const tree = treeAt(analysis, caret, game);
  if (!tree) {
    return [];
  }
  const { attribute, index } = caret;
  const value = attribute.value;
  const before = value.slice(0, index);
  const document = analysis.document;
  const range = (from: number, to: number): Range =>
    Range.create(document.positionAt(offsetInValue(attribute, from)), document.positionAt(offsetInValue(attribute, to)));
  const wordEnd = index + (nameCharacters.exec(value.slice(index))?.[0].length ?? 0);
  const items = (names: Names, kind: CompletionItemKind, from: number, to: number, noun: string, text = (name: string): string => name): CompletionItem[] =>
    [...names.counts].map(([name, count]) => ({
      label: name,
      kind,
      detail: `${count} ${noun}${count === 1 ? '' : 's'} here`,
      textEdit: { range: range(from, to), newText: text(name) },
    }));
  const state = caretState(before);
  if (state.predicate !== undefined) {
    // The nodes the step selects before this predicate.
    const candidates = contextOf(before.slice(0, state.predicate), tree);
    if (state.string) {
      const subject = /(?:@([\w.:-]+)|(\.))\s*!?=\s*$/.exec(before.slice(state.predicate + 1, state.string.start));
      if (!subject) {
        return [];
      }
      const values = new Names();
      for (const candidate of candidates) {
        const found =
          subject[1] !== undefined
            ? ownerOf(candidate).attribute(subject[1])
            : candidate.kind === 'attribute'
              ? candidate.owner.attribute(candidate.name)
              : ownerOf(candidate).stringValue();
        if (found !== undefined && found !== '' && !found.includes(state.string.quote)) {
          values.add(found);
        }
      }
      const close = value.indexOf(state.string.quote, index);
      return items(values, CompletionItemKind.Value, state.string.start + 1, close < 0 ? index : close, 'node', (found) => escapeValue(found, attribute.quote));
    }
    const typed = /@([\w.:-]*)$/.exec(before);
    if (!typed) {
      return [];
    }
    const names = new Names();
    for (const candidate of candidates) {
      ownerOf(candidate).attributes.forEach((present) => names.add(present.name));
    }
    return items(names, CompletionItemKind.Property, index - typed[1].length, wordEnd, 'node');
  }
  const typedAttribute = /\/@([\w.:-]*)$/.exec(before);
  if (typedAttribute) {
    const names = new Names();
    for (const candidate of contextOf(before.slice(0, typedAttribute.index), tree)) {
      ownerOf(candidate).attributes.forEach((present) => names.add(present.name));
    }
    return items(names, CompletionItemKind.Property, index - typedAttribute[1].length, wordEnd, 'node');
  }
  const typedStep = /(\/\/?)([\w.:-]*)$/.exec(before);
  if (!typedStep) {
    return [];
  }
  const names = new Names();
  let comments = 0;
  const visit = (node: PatchNode): void => {
    if (node.kind === 'element') {
      names.add(node.name);
    } else if (node.kind === 'comment') {
      comments++;
    }
  };
  for (const candidate of contextOf(before.slice(0, typedStep.index), tree)) {
    if (candidate.kind !== 'node') {
      continue;
    }
    if (typedStep[1] === '//') {
      forDescendants(candidate.node, visit);
    } else {
      candidate.node.children.forEach(visit);
    }
  }
  const from = index - typedStep[2].length;
  const result = items(names, CompletionItemKind.Class, from, wordEnd, 'element');
  if (comments > 0 && 'comment()'.startsWith(typedStep[2])) {
    result.push({
      label: 'comment()',
      kind: CompletionItemKind.Keyword,
      detail: `${comments} comment${comments === 1 ? '' : 's'} here`,
      textEdit: { range: range(from, wordEnd), newText: 'comment()' },
    });
  }
  return result;
}

/** A value as the text of an attribute in the quote given. */
function escapeValue(text: string, quote: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return quote === "'" ? escaped.replace(/'/g, '&apos;') : escaped.replace(/"/g, '&quot;');
}

/** The name of a cue or interrupt library item a path of a patch document selects by, under the caret. */
export function pathNameAt(analysis: DocumentAnalysis, offset: number): PathName | undefined {
  const schema = scriptSchemaOf(analysis);
  const structure = analysis.structure;
  if (!schema || !structure || !analysis.detection.isDiff) {
    return undefined;
  }
  return pathNamesOf(structure, schema).find((name) => offset >= name.start && offset <= name.end);
}
