/**
 * The patch that gives an edited text of the file it changes.
 *
 * The right side of a patch comparison shows the file a patch changes with the patch applied. When it is
 * edited there, this works out what the patch must become for the game to load the edited text:
 * - what the patch brings in itself (the elements of its `add` and `replace`, the values it sets) is
 *   edited where the patch has it;
 * - what comes from the game's file or from an earlier patch gets new operations with paths from the
 *   root, each placed among the patch's operations by the place it changes, after the operation that
 *   changes the nearest place before it.
 *
 * The trees of both texts are compared, not the texts: elements and comments, their names, attributes
 * and order. Whitespace between them and the order of attributes do not count. Text inside elements,
 * which the game's scripts do not have, is not written: when the edited text has other text inside its
 * elements than the side shows, nothing is written, and that is told. Children are paired by what they
 * are whole, then by name and their first identifying attribute, then by name. Nothing is written unless
 * the patch, applied again, gives the edited tree with its text inside elements and each of its
 * operations selects what it did before; otherwise the changes that cannot be written are told, with the
 * reason.
 *
 * A path names every element from the root. Every element below the root that has `name`, `value`,
 * `ref` or `id` gets the first of them, then more of its attributes while siblings of its name share the
 * values so far, then its position among those that still do; an element with none of the four gets a
 * predicate only when siblings share its name.
 */
import type { ScriptIndex } from '../project/scriptIndex';
import { attributeNamed, parseXml, textRunsOf, type XmlElement, type XmlRegion, type XmlStructure } from '../xml/xmlStructure';
import { evaluateXPath, parseXPath } from '../xml/xpath';
import { analyzePatch, treeBefore, treeBeforePatch, type PatchAnalysis } from './patchAnalysis';
import { writePatchedTree } from './patchedDocument';
import { documentTree, type PatchNode, type PatchNodeAttribute, type PatchOperation, type PatchSource } from './patchTree';

/** An edit of a text: `length` characters at `offset` replaced by `text`. */
export interface PatchTextEdit {
  offset: number;
  length: number;
  text: string;
}

export interface PatchWriteChange {
  /** Line of the edited text, from 0. */
  line: number;
  /** An edit of what the patch brings in, or a new operation. */
  kind: 'content' | 'operation';
  label: string;
}

export interface PatchWriteRefusal {
  /** Line of the edited text, from 0. */
  line: number;
  reason: string;
}

export interface PatchWrite {
  /** The patch's new text; absent when a change cannot be written, and then none is. */
  text?: string;
  /** The edits that make the patch's text `text`, line by line; offsets in the patch's text. */
  edits: PatchTextEdit[];
  changes: PatchWriteChange[];
  refused: PatchWriteRefusal[];
}

/** The attributes that name an element in a path, in this order. */
const identifying = ['name', 'value', 'ref', 'id'];

/** A 53-bit hash of a text. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const lineBreaks = /\r\n|\r/g;

/** What a node is, whole: kind, name, attributes in any order, comment text, children in order. */
class Hashes {
  private readonly known = new Map<PatchNode, string>();

  of(node: PatchNode): string {
    let hash = this.known.get(node);
    if (hash === undefined) {
      const text =
        node.kind === 'comment'
          ? `c\u0000${node.stringValue().replace(lineBreaks, '\n')}`
          : `${node.kind}\u0000${node.name}\u0000${node.attributes
              .map((attribute) => `${attribute.name}=${attribute.value.replace(lineBreaks, '\n')}`)
              .sort()
              .join('\u0001')}\u0000${node.children.map((child) => this.of(child)).join(',')}`;
      hash = hash53(text).toString(36);
      this.known.set(node, hash);
    }
    return hash;
  }
}

function regionOf(node: PatchNode): XmlRegion | undefined {
  return node.element ?? node.comment;
}

/** A node of a file's tree as any tree built from the same files has it. */
function keyOf(node: PatchNode): string {
  return `${node.source.file}\u0000${regionOf(node)?.start ?? -1}`;
}

function nodesByKey(tree: PatchNode): Map<string, PatchNode> {
  const nodes = new Map<string, PatchNode>();
  const walk = (node: PatchNode): void => {
    nodes.set(keyOf(node), node);
    node.children.forEach(walk);
  };
  walk(tree);
  return nodes;
}

type Key = (node: PatchNode) => string | undefined;

const byNameAndIdentity: Key = (node) => {
  if (node.kind !== 'element') {
    return undefined;
  }
  const identity = identifying.map((name) => node.attribute(name)).find((value) => value !== undefined);
  return `${node.name}\u0000${identity ?? ''}`;
};

const byName: Key = (node) => (node.kind === 'element' ? node.name : undefined);

/** Pairs of indexes with equal keys in `a[aFrom, aTo)` and `b[bFrom, bTo)`, in order: a longest common subsequence. */
function commonPairs(a: readonly PatchNode[], b: readonly PatchNode[], key: Key, aFrom: number, aTo: number, bFrom: number, bTo: number): [number, number][] {
  const head: [number, number][] = [];
  const tail: [number, number][] = [];
  let aStart = aFrom;
  let bStart = bFrom;
  let aEnd = aTo;
  let bEnd = bTo;
  while (aStart < aEnd && bStart < bEnd) {
    const found = key(a[aStart]);
    if (found === undefined || found !== key(b[bStart])) {
      break;
    }
    head.push([aStart++, bStart++]);
  }
  while (aEnd > aStart && bEnd > bStart) {
    const found = key(a[aEnd - 1]);
    if (found === undefined || found !== key(b[bEnd - 1])) {
      break;
    }
    tail.unshift([--aEnd, --bEnd]);
  }
  const rows = aEnd - aStart;
  const columns = bEnd - bStart;
  const middle: [number, number][] = [];
  if (rows > 0 && columns > 0 && rows * columns <= 4_000_000) {
    const aKeys = a.slice(aStart, aEnd).map(key);
    const bKeys = b.slice(bStart, bEnd).map(key);
    const width = columns + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let row = rows - 1; row >= 0; row--) {
      for (let column = columns - 1; column >= 0; column--) {
        lengths[row * width + column] =
          aKeys[row] !== undefined && aKeys[row] === bKeys[column]
            ? lengths[(row + 1) * width + column + 1] + 1
            : Math.max(lengths[(row + 1) * width + column], lengths[row * width + column + 1]);
      }
    }
    let row = 0;
    let column = 0;
    while (row < rows && column < columns) {
      if (aKeys[row] !== undefined && aKeys[row] === bKeys[column]) {
        middle.push([aStart + row++, bStart + column++]);
      } else if (lengths[(row + 1) * width + column] >= lengths[row * width + column + 1]) {
        row++;
      } else {
        column++;
      }
    }
  }
  return [...head, ...middle, ...tail];
}

/** Pairs the children of two nodes: equal ones, then by name and identity, then by name, each in the gaps the one before left. */
function matchChildren(a: readonly PatchNode[], b: readonly PatchNode[], hashes: Hashes): [number, number][] {
  let pairs = commonPairs(a, b, (node) => hashes.of(node), 0, a.length, 0, b.length);
  for (const key of [byNameAndIdentity, byName]) {
    const more: [number, number][] = [];
    let aFrom = 0;
    let bFrom = 0;
    for (const [aAt, bAt] of [...pairs, [a.length, b.length] as [number, number]]) {
      if (aAt > aFrom && bAt > bFrom) {
        more.push(...commonPairs(a, b, key, aFrom, aAt, bFrom, bAt));
      }
      aFrom = aAt + 1;
      bFrom = bAt + 1;
    }
    pairs = [...pairs, ...more].sort((x, y) => x[0] - y[0]);
  }
  return pairs;
}

/** An XPath string literal for a value, when it can be written in one. */
function literal(value: string): string | undefined {
  if (/[\r\n\t]/.test(value)) {
    // A line break or tab in an attribute of the patch becomes a space when the game reads it.
    return undefined;
  }
  return !value.includes("'") ? `'${value}'` : !value.includes('"') ? `"${value}"` : undefined;
}

interface PathText {
  text: string;
  /** True when a step needs a position. */
  positional: boolean;
}

function stepOf(node: PatchNode): PathText | undefined {
  const parent = node.parent;
  if (!parent) {
    return undefined;
  }
  if (node.kind === 'comment') {
    const comments = parent.children.filter((child) => child.kind === 'comment');
    const value = node.stringValue();
    const quoted = literal(value);
    if (quoted) {
      const same = comments.filter((comment) => comment.stringValue() === value);
      return same.length === 1
        ? { text: `/comment()[.=${quoted}]`, positional: false }
        : { text: `/comment()[.=${quoted}][${same.indexOf(node) + 1}]`, positional: true };
    }
    return { text: `/comment()[${comments.indexOf(node) + 1}]`, positional: comments.length > 1 };
  }
  const name = node.name;
  if (parent.kind === 'document') {
    return { text: `/${name}`, positional: false };
  }
  const siblings = parent.children.filter((child) => child.kind === 'element' && child.name === name);
  const usable = node.attributes.filter((attribute) => literal(attribute.value) !== undefined);
  const ordered = [
    ...identifying.flatMap((key) => usable.filter((attribute) => attribute.name === key)),
    ...usable.filter((attribute) => !identifying.includes(attribute.name)),
  ];
  const chosen: PatchNodeAttribute[] = [];
  let sharing = siblings.filter((sibling) => sibling !== node);
  if (ordered.length > 0 && (identifying.includes(ordered[0].name) || sharing.length > 0)) {
    for (const attribute of ordered) {
      if (chosen.length > 0 && sharing.length === 0) {
        break;
      }
      if (chosen.length === 0 || sharing.some((sibling) => sibling.attribute(attribute.name) !== attribute.value)) {
        chosen.push(attribute);
        sharing = sharing.filter((sibling) => sibling.attribute(attribute.name) === attribute.value);
      }
    }
  }
  const text = `/${name}${chosen.map((attribute) => `[@${attribute.name}=${literal(attribute.value) ?? ''}]`).join('')}`;
  if (sharing.length === 0) {
    return { text, positional: false };
  }
  const matching = siblings.filter((sibling) => chosen.every((attribute) => sibling.attribute(attribute.name) === attribute.value));
  return { text: `${text}[${matching.indexOf(node) + 1}]`, positional: true };
}

/** The full path of a node in its tree, by the rule in the header. */
export function pathOf(node: PatchNode): PathText | undefined {
  const steps: string[] = [];
  let positional = false;
  for (let at: PatchNode | undefined = node; at && at.kind !== 'document'; at = at.parent) {
    const step = stepOf(at);
    if (!step) {
      return undefined;
    }
    steps.unshift(step.text);
    positional ||= step.positional;
  }
  return { text: steps.join(''), positional };
}

const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The whitespace between the start of the offset's line and the offset, when there is only whitespace. */
function indentAt(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) {
    start--;
  }
  return start === 0 || text[start - 1] === '\n' || text[start - 1] === '\r' ? text.slice(start, offset) : '';
}

/** The stretches of a text whose whitespace counts: attribute values and comments, in order. */
class Verbatim {
  private readonly ranges: XmlRegion[];

  constructor(structure: XmlStructure) {
    this.ranges = [
      ...structure.comments,
      ...structure.elements.flatMap((element) => element.attributes.map((attribute) => ({ start: attribute.valueStart, end: attribute.valueEnd }))),
    ].sort((a, b) => a.start - b.start);
  }

  /** True when the offset lies inside one of them. */
  inside(offset: number): boolean {
    let low = 0;
    let high = this.ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.ranges[middle].start < offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    // Ranges do not overlap, except a comment's around nothing else: the last one starting before is enough.
    return low > 0 && offset < this.ranges[low - 1].end;
  }
}

/**
 * A stretch of a text taken to another place: its lines after the first moved from one indentation to
 * another, except lines inside a value or a comment, whose whitespace counts.
 */
function reindent(text: string, stretch: XmlRegion, to: string, eol: string, verbatim?: Verbatim): string {
  const part = text.slice(stretch.start, stretch.end);
  const from = indentAt(text, stretch.start);
  const pattern = /\r\n|\r|\n/g;
  const lines: string[] = [];
  let last = 0;
  for (let match = pattern.exec(part); ; match = pattern.exec(part)) {
    const line = part.slice(last, match ? match.index : part.length);
    const kept = lines.length === 0 || verbatim?.inside(stretch.start + last) === true;
    lines.push(kept ? line : line.startsWith(from) ? to + line.slice(from.length) : line.trim() === '' ? '' : line);
    if (!match) {
      break;
    }
    last = match.index + match[0].length;
  }
  return lines.join(eol);
}

class Lines {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    const pattern = /\r\n|\r|\n/g;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      this.starts.push(match.index + match[0].length);
    }
  }

  of(offset: number): number {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.starts[middle] <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low - 1;
  }
}

interface Layout {
  eol: string;
  /** The indentation of the operations in `<diff>`, and of what they hold. */
  operation: string;
  content: string;
}

function layoutOf(text: string, root: XmlElement): Layout {
  const eol = /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
  const rootIndent = indentAt(text, root.start);
  const first = root.children[0];
  const operation = (first && indentAt(text, first.start)) || `${rootIndent}  `;
  let unit = '  ';
  const holding = root.children.find((child) => child.children.length > 0);
  if (holding) {
    const own = indentAt(text, holding.start);
    const inner = indentAt(text, holding.children[0].start);
    if (inner.startsWith(own) && inner.length > own.length) {
      unit = inner.slice(own.length);
    }
  }
  return { eol, operation, content: operation + unit };
}

/** A form a new operation can take: what its path selects, and what it holds. */
interface OperationForm {
  op: 'add' | 'replace' | 'remove';
  node: PatchNode;
  /** `/@name` after the node's path. */
  attribute?: string;
  pos?: 'after' | 'before' | 'prepend';
  /** The attribute of `add type="@name"`. */
  type?: string;
  /** A value it holds. */
  value?: string;
  /** Nodes it holds: a stretch of the edited text. */
  content?: XmlRegion;
}

interface NewOperation {
  line: number;
  label: string;
  /** Where it changes the target, for its place among the operations. */
  near: PatchNode;
  /** In order of preference; the first whose path needs no position is taken, else the first that selects its node. */
  forms: OperationForm[];
}

function describe(node: PatchNode): string {
  return node.kind === 'comment' ? 'a comment' : `<${node.name}>`;
}

/** The operation elements of a patch, in order. */
function operationElements(source: PatchSource): XmlElement[] {
  return source.structure.roots[0]?.children.filter((child) => child.name === 'add' || child.name === 'replace' || child.name === 'remove') ?? [];
}

/** What an operation selects, the same in any analysis of the patch; the patch's own nodes by their text, since offsets move. */
function selectionKey(operation: PatchOperation, patchFile: string): string {
  const selection = operation.selection;
  if (!selection) {
    return operation.status;
  }
  const node = selection.kind === 'node' ? selection.node : selection.owner;
  const region = regionOf(node);
  const where = node.source.file === patchFile ? `own\u0000${region ? node.source.text.slice(region.start, region.end) : ''}` : keyOf(node);
  return `${operation.status}\u0000${selection.kind}\u0000${where}\u0000${selection.kind === 'attribute' ? selection.name : ''}`;
}

class Writer {
  readonly changes: PatchWriteChange[] = [];
  readonly refused: PatchWriteRefusal[] = [];
  readonly contentEdits: PatchTextEdit[] = [];
  readonly operations: NewOperation[] = [];
  /** The elements of each operation the edited text no longer has, and the operations something is inserted into. */
  private readonly removedIn = new Map<XmlElement, number>();
  private readonly insertedIn = new Set<XmlElement>();
  private readonly patchText: string;
  private readonly lines: Lines;
  private readonly verbatim: Verbatim;

  constructor(
    private readonly patch: PatchAnalysis,
    private readonly edited: PatchSource,
    private readonly hashes: Hashes,
    private readonly layout: Layout
  ) {
    this.patchText = patch.source.text;
    this.lines = new Lines(edited.text);
    this.verbatim = new Verbatim(edited.structure);
  }

  /** A stretch of the edited text, indented for its place in the patch. */
  private taken(stretch: XmlRegion, indent: string): string {
    return reindent(this.edited.text, stretch, indent, this.layout.eol, this.verbatim);
  }

  private isOwn(node: PatchNode): boolean {
    return node.source === this.patch.source;
  }

  /** Brought in by this patch and copied as it has it: an edit there is an edit of the patch's text. */
  private isPureOwn(node: PatchNode): boolean {
    return this.isOwn(node) && !node.changed && node.kind !== 'document';
  }

  private lineOf(node: PatchNode | undefined): number {
    const region = node && regionOf(node);
    return region ? this.lines.of(region.start) : 0;
  }

  private refuse(line: number, reason: string): void {
    this.refused.push({ line, reason });
  }

  compare(before: PatchNode, after: PatchNode): void {
    if (before.kind === 'element' && this.isPureOwn(before)) {
      this.replaceOwn(before, after);
      return;
    }
    if (before.kind === 'element' && !this.isOwn(before) && before.parent?.kind !== 'document' && this.carriesNoValue(before, after)) {
      const region = regionOf(after);
      if (region) {
        this.operations.push({
          line: this.lineOf(after),
          label: `<${before.name}> replaced`,
          near: before,
          forms: [{ op: 'replace', node: before, content: region }],
        });
      }
      return;
    }
    if (before.kind === 'element') {
      this.attributes(before, after);
    }
    this.children(before, after);
  }

  /**
   * True when a changed value cannot be the text of an operation, which the game reads with its whitespace
   * collapsed: a value over several lines, or with spaces around it. The whole element is replaced then.
   */
  private carriesNoValue(before: PatchNode, after: PatchNode): boolean {
    return after.attributes.some(
      (attribute) => before.attribute(attribute.name) !== attribute.value && attribute.value !== attribute.value.replace(/\s+/g, ' ').trim()
    );
  }

  private attributes(before: PatchNode, after: PatchNode): void {
    const names = [...new Set([...before.attributes.map((attribute) => attribute.name), ...after.attributes.map((attribute) => attribute.name)])];
    for (const name of names) {
      const old = before.attributes.find((attribute) => attribute.name === name);
      const now = after.attributes.find((attribute) => attribute.name === name);
      if (old?.value.replace(lineBreaks, '\n') === now?.value.replace(lineBreaks, '\n')) {
        continue;
      }
      const line = now?.written ? this.lines.of(now.written.start) : this.lineOf(after);
      if (old?.setBy?.source === this.patch.source) {
        this.setOwnValue(old, now, line);
      } else if (this.isOwn(before)) {
        this.refuse(line, `The patch brings in <${before.name}> and changes it again: change it where the patch does`);
      } else if (old && now) {
        this.operations.push({
          line,
          label: `@${name} of <${before.name}> set to "${now.value}"`,
          near: before,
          forms: [{ op: 'replace', node: before, attribute: name, value: now.value }],
        });
      } else if (now) {
        this.operations.push({
          line,
          label: `@${name}="${now.value}" added to <${before.name}>`,
          near: before,
          forms: [{ op: 'add', node: before, type: name, value: now.value }],
        });
      } else {
        this.operations.push({ line, label: `@${name} removed from <${before.name}>`, near: before, forms: [{ op: 'remove', node: before, attribute: name }] });
      }
    }
  }

  private children(before: PatchNode, after: PatchNode): void {
    const pairs = matchChildren(before.children, after.children, this.hashes);
    let beforeAt = 0;
    let afterAt = 0;
    let previous: PatchNode | undefined;
    for (const [beforeIndex, afterIndex] of [...pairs, [before.children.length, after.children.length] as [number, number]]) {
      const removed = before.children.slice(beforeAt, beforeIndex);
      const inserted = after.children.slice(afterAt, afterIndex);
      const next = before.children[beforeIndex];
      const line = this.lineOf(inserted[0] ?? after.children[afterIndex] ?? after);
      if (removed.length > 0 && inserted.length > 0 && inserted.some((node) => node.kind === 'element')) {
        this.replaceRun(before, removed, inserted, line);
      } else {
        removed.forEach((node) => this.remove(node, line));
        if (inserted.length > 0) {
          this.insert(before, inserted, previous, next, line);
        }
      }
      if (next && beforeIndex < before.children.length) {
        const counterpart = after.children[afterIndex];
        if (this.hashes.of(next) !== this.hashes.of(counterpart)) {
          this.compare(next, counterpart);
        }
      }
      previous = next;
      beforeAt = beforeIndex + 1;
      afterAt = afterIndex + 1;
    }
  }

  private stretch(nodes: readonly PatchNode[]): XmlRegion {
    return { start: regionOf(nodes[0])?.start ?? 0, end: regionOf(nodes[nodes.length - 1])?.end ?? 0 };
  }

  private remove(node: PatchNode, line: number): void {
    if (this.isPureOwn(node)) {
      this.deleteOwn(node);
      this.changes.push({ line, kind: 'content', label: `${describe(node)} the patch brings in removed` });
    } else if (this.isOwn(node)) {
      this.refuse(line, `The patch brings in ${describe(node)} and changes it again: remove it where the patch does`);
    } else if (node.parent?.kind === 'document') {
      this.refuse(line, 'A patch cannot remove what is outside the root element');
    } else {
      this.operations.push({ line, label: `${describe(node)} removed`, near: node, forms: [{ op: 'remove', node }] });
    }
  }

  private insert(parent: PatchNode, inserted: readonly PatchNode[], previous: PatchNode | undefined, next: PatchNode | undefined, line: number): void {
    const content = this.stretch(inserted);
    const label = `${inserted.map(describe).join(', ')} added`;
    if (previous && this.isPureOwn(previous)) {
      this.insertOwn(previous, content, 'after');
      this.changes.push({ line, kind: 'content', label });
      return;
    }
    if (next && this.isPureOwn(next)) {
      this.insertOwn(next, content, 'before');
      this.changes.push({ line, kind: 'content', label });
      return;
    }
    if (parent.kind === 'document') {
      this.refuse(line, 'A patch cannot add anything outside the root element');
      return;
    }
    const forms: OperationForm[] = [];
    if (previous && !this.isOwn(previous)) {
      forms.push({ op: 'add', node: previous, pos: 'after', content });
    }
    if (next && !this.isOwn(next)) {
      forms.push({ op: 'add', node: next, pos: 'before', content });
    }
    if (!this.isOwn(parent)) {
      if (!next) {
        forms.push({ op: 'add', node: parent, content });
      }
      if (!previous) {
        forms.push({ op: 'add', node: parent, pos: 'prepend', content });
      }
    }
    if (forms.length === 0) {
      this.refuse(line, 'The patch brings in the elements around it and changes them again: add it where the patch does');
      return;
    }
    this.operations.push({ line, label, near: previous ?? next ?? parent, forms });
  }

  private replaceRun(parent: PatchNode, removed: readonly PatchNode[], inserted: readonly PatchNode[], line: number): void {
    const [first, ...rest] = removed;
    if (this.isPureOwn(first)) {
      this.replaceOwn(first, undefined, this.stretch(inserted));
      this.changes.push({ line, kind: 'content', label: `${describe(first)} the patch brings in replaced` });
    } else if (this.isOwn(first)) {
      this.refuse(line, `The patch brings in ${describe(first)} and changes it again: replace it where the patch does`);
      return;
    } else if (parent.kind === 'document') {
      this.refuse(line, 'A patch cannot replace what is outside the root element');
      return;
    } else {
      this.operations.push({
        line,
        label: `${describe(first)} replaced by ${inserted.map(describe).join(', ')}`,
        near: first,
        forms: [{ op: 'replace', node: first, content: this.stretch(inserted) }],
      });
    }
    rest.forEach((node) => this.remove(node, line));
  }

  /** The operation element of the patch that holds an offset of the patch. */
  private operationAt(offset: number): XmlElement | undefined {
    return operationElements(this.patch.source).find((operation) => operation.start <= offset && offset < operation.end);
  }

  /** Puts the edited text of a node, or a stretch of it, where the patch has its own node. */
  private replaceOwn(node: PatchNode, after: PatchNode | undefined, stretch = after && regionOf(after)): void {
    const region = regionOf(node);
    if (!region || !stretch) {
      return;
    }
    const text = this.taken(stretch, indentAt(this.patchText, region.start));
    this.contentEdits.push({ offset: region.start, length: region.end - region.start, text });
    if (after) {
      this.changes.push({ line: this.lineOf(after), kind: 'content', label: `${describe(node)} the patch brings in changed` });
    }
  }

  /** The stretch of the patch's text that removes a region: its whole line when nothing else is on it. */
  private removal(region: XmlRegion): PatchTextEdit {
    const text = this.patchText;
    let start = region.start;
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) {
      start--;
    }
    let end = region.end;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) {
      end++;
    }
    const lineBefore = start === 0 || text[start - 1] === '\n' || text[start - 1] === '\r';
    const lineAfter = end === text.length || text[end] === '\n' || text[end] === '\r';
    if (lineBefore && lineAfter && start > 0) {
      start -= text[start - 1] === '\n' && text[start - 2] === '\r' ? 2 : 1;
      return { offset: start, length: end - start, text: '' };
    }
    return { offset: region.start, length: region.end - region.start, text: '' };
  }

  private deleteOwn(node: PatchNode): void {
    const region = regionOf(node);
    if (!region) {
      return;
    }
    this.contentEdits.push(this.removal(region));
    const operation = this.operationAt(region.start);
    if (operation && node.element?.parent === operation) {
      this.removedIn.set(operation, (this.removedIn.get(operation) ?? 0) + 1);
    }
  }

  private insertOwn(anchor: PatchNode, stretch: XmlRegion, where: 'after' | 'before'): void {
    const region = regionOf(anchor);
    if (!region) {
      return;
    }
    const indent = indentAt(this.patchText, region.start);
    const run = this.taken(stretch, indent);
    this.contentEdits.push(
      where === 'after'
        ? { offset: region.end, length: 0, text: `${this.layout.eol}${indent}${run}` }
        : { offset: region.start, length: 0, text: `${run}${this.layout.eol}${indent}` }
    );
    const operation = this.operationAt(region.start);
    if (operation) {
      this.insertedIn.add(operation);
    }
  }

  /** A value this patch sets, changed or removed in the edited text: the operation that sets it changes. */
  private setOwnValue(old: PatchNodeAttribute, now: PatchNodeAttribute | undefined, line: number): void {
    const operation = old.setBy?.operation;
    if (!operation) {
      return;
    }
    const text = this.patchText;
    if (now) {
      if (!operation.endTag) {
        this.refuse(line, `The operation that sets @${old.name} holds no value to change`);
        return;
      }
      let start = operation.startTagEnd;
      let end = operation.endTag.start;
      while (start < end && /\s/.test(text[start])) {
        start++;
      }
      while (end > start && /\s/.test(text[end - 1])) {
        end--;
      }
      this.contentEdits.push({ offset: start, length: end - start, text: escapeText(now.value) });
      this.changes.push({ line, kind: 'content', label: `@${old.name} the patch sets changed to "${now.value}"` });
      return;
    }
    const sel = attributeNamed(operation, 'sel');
    if (old.written && sel) {
      // The file has the attribute: the patch removes it instead of setting it.
      const path = operation.name === 'add' ? `${sel.value}/@${old.name}` : sel.value;
      this.contentEdits.push({ offset: operation.start, length: operation.end - operation.start, text: `<remove sel="${escapeAttribute(path)}"/>` });
    } else {
      this.contentEdits.push(this.removal(operation));
    }
    this.changes.push({ line, kind: 'content', label: `@${old.name} the patch sets removed` });
  }

  /**
   * The patch's text with the edits of what it brings in. An operation left with none of its elements
   * goes; a `replace` becomes a `remove`, since what it replaced stays away.
   */
  applyContentEdits(): string | undefined {
    const edits = [...this.contentEdits];
    for (const [operation, count] of this.removedIn) {
      if (count < operation.children.length || this.insertedIn.has(operation)) {
        continue;
      }
      for (let at = edits.length - 1; at >= 0; at--) {
        if (edits[at].offset >= operation.start && edits[at].offset + edits[at].length <= operation.end) {
          edits.splice(at, 1);
        }
      }
      const sel = attributeNamed(operation, 'sel');
      edits.push(
        operation.name === 'replace' && sel
          ? { offset: operation.start, length: operation.end - operation.start, text: `<remove ${this.patchText.slice(sel.start, sel.end)}/>` }
          : this.removal(operation)
      );
    }
    edits.sort((a, b) => a.offset - b.offset || a.length - b.length);
    let text = this.patchText;
    for (let at = edits.length - 1; at >= 0; at--) {
      const edit = edits[at];
      if (at + 1 < edits.length && edit.offset + edit.length > edits[at + 1].offset) {
        return undefined;
      }
      text = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.length);
    }
    return text;
  }

  /** The text of a new operation as it would find the tree, in the first form its path suits. */
  operationText(operation: NewOperation, tree: PatchNode): string | undefined {
    const nodes = nodesByKey(tree);
    let chosen: { form: OperationForm; path: string } | undefined;
    for (const form of operation.forms) {
      const node = nodes.get(keyOf(form.node));
      const path = node && pathOf(node);
      if (!node || !path) {
        continue;
      }
      const text = form.attribute ? `${path.text}/@${form.attribute}` : path.text;
      const selected = evaluateXPath(parseXPath(text), tree);
      const only = selected.length === 1 ? selected[0] : undefined;
      if (!only || (only.kind === 'node' ? only.node : only.owner) !== node) {
        continue;
      }
      if (!path.positional) {
        chosen = { form, path: text };
        break;
      }
      chosen ??= { form, path: text };
    }
    if (!chosen) {
      return undefined;
    }
    const { form, path } = chosen;
    const { eol, operation: indent, content: inner } = this.layout;
    const attributes = [`sel="${escapeAttribute(path)}"`, ...(form.pos ? [`pos="${form.pos}"`] : []), ...(form.type ? [`type="@${form.type}"`] : [])].join(' ');
    if (form.value !== undefined) {
      return `<${form.op} ${attributes}>${escapeText(form.value)}</${form.op}>`;
    }
    if (form.content) {
      return `<${form.op} ${attributes}>${eol}${inner}${this.taken(form.content, inner)}${eol}${indent}</${form.op}>`;
    }
    return `<${form.op} ${attributes}/>`;
  }
}

function sourceOf(file: string, text: string): PatchSource {
  return { file, text, structure: parseXml(text) };
}

/** The patch's text with an operation's text inserted before an operation element, or at the end of `<diff>`. */
function insertOperation(text: string, root: XmlElement, before: XmlElement | undefined, operation: string, layout: Layout): string | undefined {
  const { eol, operation: indent } = layout;
  if (before) {
    const lineStart = before.start - indentAt(text, before.start).length;
    return indentAt(text, before.start) !== '' || lineStart === 0 || /[\r\n]/.test(text[lineStart - 1])
      ? `${text.slice(0, lineStart)}${indent}${operation}${eol}${text.slice(lineStart)}`
      : `${text.slice(0, before.start)}${operation}${eol}${indent}${text.slice(before.start)}`;
  }
  if (root.selfClosing) {
    const head = text.slice(0, root.startTagEnd - 2).trimEnd();
    return `${head}>${eol}${indent}${operation}${eol}${indentAt(text, root.start)}</${root.name}>${text.slice(root.startTagEnd)}`;
  }
  const endTag = root.endTag;
  if (!endTag) {
    return undefined;
  }
  const lineStart = endTag.start - indentAt(text, endTag.start).length;
  const alone = lineStart === 0 || /[\r\n]/.test(text[lineStart - 1]);
  return alone
    ? `${text.slice(0, lineStart)}${indent}${operation}${eol}${text.slice(lineStart)}`
    : `${text.slice(0, endTag.start)}${eol}${indent}${operation}${eol}${indentAt(text, root.start)}${text.slice(endTag.start)}`;
}

/** The fewest edits, line by line, that make one text another. */
export function lineEdits(before: string, after: string): PatchTextEdit[] {
  const split = (text: string): string[] => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const a = split(before);
  const b = split(after);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of a) {
    offsets.push(offset);
    offset += line.length;
  }
  offsets.push(offset);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const rows = a.length - head - tail;
  const columns = b.length - head - tail;
  if (rows * columns > 4_000_000) {
    return [{ offset: offsets[head], length: offsets[a.length - tail] - offsets[head], text: b.slice(head, b.length - tail).join('') }];
  }
  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      lengths[row * width + column] =
        a[head + row] === b[head + column]
          ? lengths[(row + 1) * width + column + 1] + 1
          : Math.max(lengths[(row + 1) * width + column], lengths[row * width + column + 1]);
    }
  }
  const edits: PatchTextEdit[] = [];
  let row = 0;
  let column = 0;
  let open: { row: number; column: number } | undefined;
  const close = (): void => {
    if (open) {
      edits.push({
        offset: offsets[head + open.row],
        length: offsets[head + row] - offsets[head + open.row],
        text: b.slice(head + open.column, head + column).join(''),
      });
      open = undefined;
    }
  };
  while (row < rows || column < columns) {
    if (row < rows && column < columns && a[head + row] === b[head + column]) {
      close();
      row++;
      column++;
    } else {
      open ??= { row, column };
      if (column >= columns || (row < rows && lengths[(row + 1) * width + column] >= lengths[row * width + column + 1])) {
        row++;
      } else {
        column++;
      }
    }
  }
  close();
  return edits;
}

/** The stretches of text inside the elements of a text, in order, whitespace collapsed; and its lines. */
interface ElementTexts {
  texts: { element: XmlElement; start: number; text: string }[];
  lines: Lines;
}

function elementTextsOf(text: string, structure: XmlStructure): ElementTexts {
  const texts: ElementTexts['texts'] = [];
  for (const element of structure.elements) {
    for (const run of textRunsOf(element, text, structure.comments)) {
      texts.push({ element, start: run.start, text: text.slice(run.start, run.end).replace(/\s+/g, ' ') });
    }
  }
  // An element's text after its children comes after theirs.
  texts.sort((a, b) => a.start - b.start);
  return { texts, lines: new Lines(text) };
}

/**
 * The first stretch of text inside an element that differs between two texts, with its line and
 * element: in whichever text it comes first, the lines before an edit being alike in both.
 */
function textDifference(before: ElementTexts, after: ElementTexts): { line: number; name: string } | undefined {
  const count = Math.max(before.texts.length, after.texts.length);
  let at = 0;
  while (at < count && before.texts[at]?.element.name === after.texts[at]?.element.name && before.texts[at]?.text === after.texts[at]?.text) {
    at++;
  }
  if (at === count) {
    return undefined;
  }
  const old = before.texts[at] && { line: before.lines.of(before.texts[at].start), name: before.texts[at].element.name };
  const now = after.texts[at] && { line: after.lines.of(after.texts[at].start), name: after.texts[at].element.name };
  return now && (!old || now.line <= old.line) ? now : old;
}

/**
 * What a patch must become so that the file it changes, with the patch applied, is the edited text:
 * the side of a patch comparison after editing. See the header.
 */
export function writePatch(patch: PatchAnalysis, edited: string, index: ScriptIndex): PatchWrite {
  const refuse = (reason: string, line = 0): PatchWrite => ({ edits: [], changes: [], refused: [{ line, reason }] });
  const root = patch.source.structure.roots[0];
  const target = patch.target.file;
  if (!patch.document || target === undefined || !root || root.name !== 'diff') {
    return refuse('The patch changes no file');
  }
  const problem = patch.source.structure.problems[0];
  if (problem) {
    return refuse(`The patch is not well-formed: ${problem.message}`);
  }
  const editedSource = sourceOf(`${target}#edited`, edited);
  const editedProblem = editedSource.structure.problems[0];
  if (editedProblem) {
    return refuse(`Not well-formed: ${editedProblem.message}`, new Lines(edited).of(editedProblem.start));
  }
  // The side as it shows the file, text between nodes of different files left out.
  const side = patch.patched?.written.text ?? writePatchedTree(patch.document).text;
  const editedTexts = elementTextsOf(edited, editedSource.structure);
  const textChange = textDifference(elementTextsOf(side, patch.patched?.analysis.structure ?? parseXml(side)), editedTexts);
  if (textChange) {
    return refuse(`Text inside <${textChange.name}> changed: only elements, attributes and comments are written into the patch`, textChange.line);
  }
  const editedTree = documentTree(editedSource);
  const hashes = new Hashes();
  if (hashes.of(patch.document) === hashes.of(editedTree)) {
    return { text: patch.source.text, edits: [], changes: [], refused: [] };
  }
  const layout = layoutOf(patch.source.text, root);
  const writer = new Writer(patch, editedSource, hashes, layout);
  writer.compare(patch.document, editedTree);
  if (writer.refused.length > 0) {
    return { edits: [], changes: writer.changes, refused: writer.refused };
  }
  let text = writer.applyContentEdits();
  if (text === undefined) {
    return refuse('Changes of what the patch brings in overlap');
  }
  const file = patch.source.file;
  let analysis = analyzePatch(sourceOf(file, text), index);
  const before = treeBeforePatch(patch, index);
  if (!analysis?.document || !before) {
    return refuse('The patch changes no file');
  }
  const order = new Map<string, number>();
  const walk = (node: PatchNode): void => {
    order.set(keyOf(node), order.size);
    node.children.forEach(walk);
  };
  walk(before);
  const orderOf = (node: PatchNode | undefined): number | undefined => (node ? order.get(keyOf(node)) : undefined);
  const anchorOf = (operation: PatchOperation): PatchNode | undefined =>
    operation.selection?.kind === 'node' ? operation.selection.node : operation.selection?.owner;

  const refused: PatchWriteRefusal[] = [];
  const operations = [...writer.operations].sort((a, b) => (orderOf(a.near) ?? Infinity) - (orderOf(b.near) ?? Infinity));
  for (const operation of operations) {
    const current: PatchAnalysis = analysis;
    const near = orderOf(operation.near) ?? Infinity;
    const places = current.operations.map((existing) => orderOf(anchorOf(existing)));
    let at = -1;
    places.forEach((place, number) => {
      if (place !== undefined && place <= near) {
        at = number + 1;
      }
    });
    if (at === -1) {
      const first = places.findIndex((place) => place !== undefined);
      at = first === -1 ? current.operations.length : first;
    }
    let placed: { text: string; analysis: PatchAnalysis } | undefined;
    for (const position of new Set([at, current.operations.length])) {
      const next = current.operations[position]?.element;
      const tree = next ? treeBefore(current, next, index) : current.document;
      const operationText = tree && writer.operationText(operation, tree);
      const inserted = operationText && insertOperation(current.source.text, current.source.structure.roots[0], next, operationText, layout);
      const after = inserted ? analyzePatch(sourceOf(file, inserted), index) : undefined;
      if (!inserted || !after || after.operations.length !== current.operations.length + 1 || after.operations[position]?.status !== 'applied') {
        continue;
      }
      const kept = current.operations.every(
        (existing, number) => selectionKey(existing, file) === selectionKey(after.operations[number < position ? number : number + 1], file)
      );
      if (kept) {
        placed = { text: inserted, analysis: after };
        break;
      }
    }
    if (!placed) {
      refused.push({
        line: operation.line,
        reason: `No operation found for this change (${operation.label}) that leaves the patch's other operations as they are`,
      });
      continue;
    }
    text = placed.text;
    analysis = placed.analysis;
    writer.changes.push({ line: operation.line, kind: 'operation', label: operation.label });
  }
  if (refused.length > 0) {
    return { edits: [], changes: writer.changes, refused };
  }
  if (!analysis.document || hashes.of(analysis.document) !== hashes.of(editedTree)) {
    return {
      edits: [],
      changes: writer.changes,
      refused: [{ line: firstDifference(analysis.document, editedTree, hashes), reason: 'The patch written would not give this text' }],
    };
  }
  // Text the edited file keeps inside elements, which the patch may have moved away from where it is shown.
  if (editedTexts.texts.length > 0) {
    const written = writePatchedTree(analysis.document).text;
    const lost = textDifference(elementTextsOf(written, parseXml(written)), editedTexts);
    if (lost) {
      return { edits: [], changes: writer.changes, refused: [{ line: lost.line, reason: 'The patch written would not give this text' }] };
    }
  }
  return { text, edits: lineEdits(patch.source.text, text), changes: writer.changes.sort((a, b) => a.line - b.line), refused: [] };
}

/** The line of the edited text where two trees first differ. */
function firstDifference(written: PatchNode | undefined, edited: PatchNode, hashes: Hashes): number {
  const lines = new Lines(edited.source.text);
  let a = written;
  let b = edited;
  for (;;) {
    const index = b.children.findIndex((child, number) => !a?.children[number] || hashes.of(child) !== hashes.of(a.children[number]));
    const child = b.children[index];
    const region = regionOf(child ?? b);
    if (!child || !a?.children[index] || a.children[index].name !== child.name || a.children[index].children.length === 0) {
      return region ? lines.of(region.start) : 0;
    }
    a = a.children[index];
    b = child;
  }
}
