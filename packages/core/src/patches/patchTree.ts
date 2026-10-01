/**
 * The document a patch changes, as a tree the patch operations work on.
 *
 * A tree starts from the tolerant structure of the target file: its elements and comments, each node
 * keeping the file and scanned element it came from. Patches are applied to it in load order, and a
 * patch's operations in document order, as the game does: `add` (appended, or `pos` `prepend`, `before`,
 * `after`; `type="@attr"` adds an attribute with the operation's text as value), `replace` (a node by the
 * operation's elements, an attribute's value by its text) and `remove`. An operation applies to
 * the one node its `sel` selects; with none or several, a condition (`if`) that does not hold, or one of
 * the cases the game refuses, it is skipped and the next one goes on. A library file of the game also
 * gets the merge files of extensions, in the same load order (`mergeFile`).
 */
import { textOf } from '../xml/miniXPath';
import { attributeNamed, decodeAttributeValue, type XmlAttribute, type XmlElement, type XmlRegion, type XmlStructure } from '../xml/xmlStructure';
import {
  conditionHolds,
  evaluateXPath,
  parseXPath,
  parseXPathCondition,
  type XPath,
  type XPathCondition,
  type XPathNode,
  type XPathSelection,
} from '../xml/xpath';

/** A file a tree is built from or patched with. */
export interface PatchSource {
  file: string;
  text: string;
  structure: XmlStructure;
}

export interface PatchNodeAttribute {
  name: string;
  value: string;
  /** The attribute as written in the node's file; a patch that sets the value does not change it. */
  written?: XmlAttribute;
  /** The operation that set the value, and its patch, when a patch did. */
  setBy?: { operation: XmlElement; source: PatchSource };
}

/** The child elements of one name by the value of one attribute, and the value each had when it was built. */
interface ChildIndex {
  name: string;
  attribute: string;
  byValue: Map<string, PatchNode[]>;
  valueOf: Map<PatchNode, string | undefined>;
}

export class PatchNode implements XPathNode<PatchNode> {
  parent: PatchNode | undefined;
  children: PatchNode[] = [];
  readonly attributes: PatchNodeAttribute[];
  /** True once a patch changed the node or something below it. */
  changed = false;
  /**
   * For a node an operation brought in: the node whose column it takes when written out, the one it
   * replaces or is added next to, or, one step deeper, the one it is added into.
   */
  placed?: { anchor: PatchNode; deeper: boolean };
  private text: string | undefined;
  /** Indexes of the children, built when a path first asks, until a change makes them wrong (`markChanged`). */
  private indexes: Map<string, ChildIndex> | undefined;

  constructor(
    readonly kind: 'document' | 'element' | 'comment',
    /** The file the node comes from: the target, or the patch that added it. */
    readonly source: PatchSource,
    /** The scanned element of an element node. */
    readonly element?: XmlElement,
    /** The comment of a comment node. */
    readonly comment?: XmlRegion
  ) {
    this.attributes = element ? element.attributes.map((attribute) => ({ name: attribute.name, value: attribute.value, written: attribute })) : [];
  }

  get name(): string {
    return this.element?.name ?? '';
  }

  attribute(name: string): string | undefined {
    return this.attributes.find((attribute) => attribute.name === name)?.value;
  }

  /** An element's text without its markup, references decoded and whitespace collapsed; a comment's text as written. */
  stringValue(): string {
    if (this.text === undefined) {
      if (this.comment) {
        this.text = this.source.text.slice(this.comment.start + 4, Math.max(this.comment.start + 4, this.comment.end - 3));
      } else if (this.element?.endTag) {
        const inner = this.source.text.slice(this.element.startTagEnd, this.element.endTag.start).replace(/<!--[^]*?-->|<[^>]*>/g, ' ');
        this.text = decodeAttributeValue(inner, []).replace(/\s+/g, ' ').trim();
      } else {
        this.text = '';
      }
    }
    return this.text;
  }

  childrenWith(name: string, attribute: string, value: string): readonly PatchNode[] {
    const key = `${name}@${attribute}`;
    this.indexes ??= new Map();
    let index = this.indexes.get(key);
    if (!index) {
      index = { name, attribute, byValue: new Map(), valueOf: new Map() };
      for (const child of this.children) {
        if (child.kind === 'element' && child.name === name) {
          const childValue = child.attribute(attribute);
          index.valueOf.set(child, childValue);
          if (childValue !== undefined) {
            const list = index.byValue.get(childValue);
            if (list) {
              list.push(child);
            } else {
              index.byValue.set(childValue, [child]);
            }
          }
        }
      }
      this.indexes.set(key, index);
    }
    return index.byValue.get(value) ?? [];
  }

  /**
   * Marks the node and its ancestors as changed. Every change of a tree ends here, on the node whose children or
   * attributes changed: its indexes go, and those of its parent that hold another value of it than it has now.
   * The ancestors' indexes stay, so changes deep in one `ware` do not rebuild the index of every `ware`.
   */
  markChanged(): void {
    this.indexes = undefined;
    this.parent?.forgetValueOf(this);
    this.changed = true;
    for (let node = this.parent; node; node = node.parent) {
      node.changed = true;
    }
  }

  private forgetValueOf(child: PatchNode): void {
    for (const [key, index] of this.indexes ?? []) {
      if (index.name === child.name && index.valueOf.get(child) !== child.attribute(index.attribute)) {
        this.indexes?.delete(key);
      }
    }
  }
}

/** Builds nodes from a scanned file, comments placed among the elements by their offsets. */
class NodeBuilder {
  constructor(private readonly source: PatchSource) {}

  /** Index of the first comment that starts at or after the offset. */
  private firstCommentAt(offset: number): number {
    const comments = this.source.structure.comments;
    let low = 0;
    let high = comments.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (comments[middle].start < offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  /** Nodes for the elements, and the comments between `from` and `to` that lie outside them, in order. */
  nodes(elements: readonly XmlElement[], from: number, to: number, parent: PatchNode): PatchNode[] {
    const comments = this.source.structure.comments;
    const result: PatchNode[] = [];
    let next = this.firstCommentAt(from);
    const commentsBefore = (offset: number): void => {
      while (next < comments.length && comments[next].start < offset) {
        const node = new PatchNode('comment', this.source, undefined, comments[next]);
        node.parent = parent;
        result.push(node);
        next++;
      }
    };
    for (const element of elements) {
      commentsBefore(element.start);
      result.push(this.element(element, parent));
      next = this.firstCommentAt(element.end);
    }
    commentsBefore(to);
    return result;
  }

  element(element: XmlElement, parent: PatchNode | undefined): PatchNode {
    const node = new PatchNode('element', this.source, element);
    node.parent = parent;
    node.children = this.nodes(element.children, element.startTagEnd, element.endTag?.start ?? element.end, node);
    return node;
  }
}

/** The document node of a file, with its root element and the comments around it. */
export function documentTree(source: PatchSource): PatchNode {
  const document = new PatchNode('document', source);
  document.children = new NodeBuilder(source).nodes(source.structure.roots, 0, source.text.length, document);
  return document;
}

export type PatchOperationKind = 'add' | 'replace' | 'remove';

/**
 * What became of an operation: applied; its path selects nothing or several nodes; skipped because its
 * condition does not hold; invalid (missing `sel`, a wrong `pos`, or a case the game refuses, with the
 * reason); or unknown, when its `sel` or `if` is not understood or a patch before it was not.
 */
export type PatchOperationStatus = 'applied' | 'no-match' | 'several-matches' | 'skipped' | 'invalid' | 'unknown';

export interface PatchOperation {
  /** The `add`, `replace` or `remove` element of the patch. */
  element: XmlElement;
  kind: PatchOperationKind;
  sel?: XmlAttribute;
  path?: XPath;
  condition?: XPathCondition;
  status: PatchOperationStatus;
  /** How many nodes the path selects. */
  matches: number;
  /** The node, attribute or text selected, when there is exactly one. */
  selection?: XPathSelection<PatchNode>;
  /** For a path that selects nothing: how many of its first steps still select something. */
  matchingSteps?: number;
  /** Why the game refuses the operation. */
  reason?: string;
  /** Where inserted nodes went, and the nodes. */
  parent?: PatchNode;
  inserted: PatchNode[];
}

const positions: ReadonlySet<string> = new Set(['before', 'after', 'prepend']);

/** The text of an operation, as an attribute value: references decoded, whitespace collapsed. */
function operationText(operation: XmlElement, source: PatchSource): string {
  return textOf(operation, source.text);
}

function insert(parent: PatchNode, index: number, nodes: PatchNode[], anchor: PatchNode, deeper: boolean): void {
  for (const node of nodes) {
    node.parent = parent;
    node.placed = { anchor, deeper };
  }
  parent.children.splice(index, 0, ...nodes);
  parent.markChanged();
}

/**
 * Merges a file into a tree as the game merges an extension's library file whose root has the name of the
 * tree's: the children of its root, comments too, are appended to the tree's root. False when the roots
 * differ, and the game skips the file.
 */
export function mergeFile(document: PatchNode, merge: PatchSource): boolean {
  const root = merge.structure.roots[0];
  const target = document.children.find((child) => child.kind === 'element');
  if (!root || !target || root.name !== target.name) {
    return false;
  }
  const nodes = new NodeBuilder(merge).nodes(root.children, root.startTagEnd, root.endTag?.start ?? root.end, target);
  if (nodes.length > 0) {
    insert(target, target.children.length, nodes, target, true);
  }
  return true;
}

/**
 * Applies the operations of a patch to a tree, in order, and tells what became of each. With
 * `uncertain`, the tree may differ from the game's already, so no operation is said to select nothing.
 * With `until`, the operations stop before that one.
 */
export function applyPatch(document: PatchNode, patch: PatchSource, uncertain = false, until?: XmlElement): PatchOperation[] {
  const root = patch.structure.roots[0];
  if (!root) {
    return [];
  }
  const builder = new NodeBuilder(patch);
  const operations: PatchOperation[] = [];
  for (const element of root.children) {
    if (element === until) {
      break;
    }
    if (element.name !== 'add' && element.name !== 'replace' && element.name !== 'remove') {
      continue;
    }
    const kind: PatchOperationKind = element.name;
    const operation: PatchOperation = { element, kind, status: 'unknown', matches: 0, inserted: [] };
    operations.push(operation);
    const sel = attributeNamed(element, 'sel');
    const pos = kind === 'add' ? attributeNamed(element, 'pos')?.value : undefined;
    if (!sel || (pos !== undefined && !positions.has(pos))) {
      operation.status = 'invalid';
      continue;
    }
    operation.sel = sel;
    operation.path = parseXPath(sel.value);
    const condition = attributeNamed(element, 'if');
    if (condition) {
      operation.condition = parseXPathCondition(condition.value);
    }
    if (operation.path.problem || operation.condition?.path.problem) {
      uncertain = true;
      continue;
    }
    if (operation.condition && !conditionHolds(operation.condition, document)) {
      operation.status = 'skipped';
      continue;
    }
    const selections = evaluateXPath(operation.path, document);
    operation.matches = selections.length;
    if (selections.length !== 1) {
      if (uncertain) {
        continue;
      }
      operation.status = selections.length === 0 ? 'no-match' : 'several-matches';
      if (selections.length === 0) {
        let count = operation.path.steps.length - 1;
        while (count > 0 && evaluateXPath(operation.path, document, count).length === 0) {
          count--;
        }
        operation.matchingSteps = count;
      }
      continue;
    }
    const selection = selections[0];
    operation.selection = selection;
    const content = builder.nodes(element.children, element.startTagEnd, element.endTag?.start ?? element.end, document);
    const elements = content.filter((node) => node.kind === 'element');
    const refuse = (reason: string): void => {
      operation.status = 'invalid';
      operation.reason = reason;
    };
    operation.status = 'applied';
    if (kind === 'add') {
      const type = attributeNamed(element, 'type')?.value.trim();
      if (type !== undefined) {
        const owner = selection.kind === 'node' ? selection.node : selection.owner;
        if (elements.length > 0 || owner.kind !== 'element' || !type.startsWith('@')) {
          refuse(`Cannot add a node as an attribute '${type}'`);
          continue;
        }
        const name = type.slice(1);
        const existing = owner.attributes.find((attribute) => attribute.name === name);
        if (existing) {
          existing.value = operationText(element, patch);
          existing.setBy = { operation: element, source: patch };
        } else {
          owner.attributes.push({ name, value: operationText(element, patch), setBy: { operation: element, source: patch } });
        }
        owner.markChanged();
        continue;
      }
      if (selection.kind !== 'node') {
        refuse('Cannot add a node to an attribute or a text');
        continue;
      }
      const target = selection.node;
      if (pos === 'before' || pos === 'after') {
        const parent = target.parent;
        if (!parent || parent.kind === 'document') {
          refuse('Cannot add a node next to the root element');
          continue;
        }
        insert(parent, parent.children.indexOf(target) + (pos === 'after' ? 1 : 0), content, target, false);
        operation.parent = parent;
      } else if (target.kind !== 'element') {
        refuse('Cannot add a node into a comment');
        continue;
      } else {
        insert(target, pos === 'prepend' ? 0 : target.children.length, content, target, true);
        operation.parent = target;
      }
      operation.inserted = content;
    } else if (kind === 'replace') {
      if (selection.kind !== 'node') {
        if (elements.length > 0) {
          refuse('Cannot replace an attribute or a text with a node');
          continue;
        }
        if (selection.kind === 'attribute') {
          const attribute = selection.owner.attributes.find((candidate) => candidate.name === selection.name);
          if (attribute) {
            attribute.value = operationText(element, patch);
            attribute.setBy = { operation: element, source: patch };
          }
        }
        selection.owner.markChanged();
        continue;
      }
      const target = selection.node;
      const parent = target.parent;
      if (!parent || (target.kind === 'element' && parent.kind === 'document')) {
        refuse('Cannot replace the root element');
        continue;
      }
      // diff.xsd allows one element, the game takes several: its own DLC patches replace nodes with several.
      if (elements.length === 0) {
        refuse('Cannot replace a node with an attribute or a text');
        continue;
      }
      const index = parent.children.indexOf(target);
      parent.children.splice(index, 1);
      insert(parent, index, content, target, false);
      operation.parent = parent;
      operation.inserted = content;
    } else {
      if (selection.kind === 'attribute') {
        const owner = selection.owner;
        const index = owner.attributes.findIndex((attribute) => attribute.name === selection.name);
        owner.attributes.splice(index, 1);
        owner.markChanged();
      } else if (selection.kind === 'node') {
        const parent = selection.node.parent;
        if (!parent || (selection.node.kind === 'element' && parent.kind === 'document')) {
          refuse('Cannot remove the root element');
          continue;
        }
        parent.children.splice(parent.children.indexOf(selection.node), 1);
        parent.markChanged();
      }
    }
  }
  return operations;
}
