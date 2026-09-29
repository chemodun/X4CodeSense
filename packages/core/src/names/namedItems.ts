/**
 * Named items of a script besides variables, with their definitions and the references to them in one
 * document.
 *
 * AI scripts: labels belong to the `<attention>` block they are written in; every block has its own and
 * a `resume` inside a block jumps within it. `abort_called_scripts resume` in an interrupt handler of the
 * script, and any other label reference outside the blocks (`<patch>`, `<init>`), targets whichever block
 * is running, so it may name a label of any block. A label named inside `<interrupts><library>` belongs
 * to the scripts that use the library. Interrupt library items (`actions`, `handler` and `conditions`
 * under `<interrupts><library>`) have globally unique names; they are referenced by the attributes typed
 * `interrupt_actionsref`, `interrupt_handlerref`, `interrupt_conditionsref`, and by
 * `<include_interrupt_actions ref>`, whose documentation names the action sets. Most are defined in
 * other scripts, which this document cannot see.
 *
 * Mission Director scripts: cue and library names are unique in a script. Expressions name them as the
 * head of a chain (`Start.$x`, `<signal_cue cue="Start">`, `<include_actions ref="Lib">`) or after the
 * script's own name (`md.Script.Start`). A bare name that is no keyword and no cue of the script is kept
 * as an unresolved cue reference, unless it is the whole value of an attribute that does not take a cue
 * (a macro or sound id) or a value of the attribute's own enumeration. In a library such a name is
 * resolved in the script that includes the library, so it is marked external.
 *
 * The evidence for these rules is recorded in the plan (vanilla 9.00 and the mods): labels never repeat
 * within a block, every `resume` finds its label, handler references find a label in some block, cue
 * names never repeat within a script and never equal a keyword.
 */
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { parsedValue } from '../expressions/attributeExpression';
import { walkExpression, type Expression } from '../expressions/parser';
import type { ScriptProperties } from '../properties/scriptProperties';
import type { ScriptSchema } from '../types';
import { offsetInValue, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';
import { enumerationsOf, isExpressionAttribute, typeNamesOf, type XsdAttribute, type XsdElement, type XsdSchema } from '../xsd/schema';

export type NamedItemKind = 'label' | 'actions' | 'handler' | 'conditions' | 'cue';

export interface NamedItem {
  kind: NamedItemKind;
  name: string;
  /** Where the name is unique: `attention#<n>` for a label of an attention block, `script`, or `external` for names resolved in other scripts. */
  scope: string;
  /** The attention element of a label scope. */
  owner?: XmlElement;
  definitions: NamedOccurrence[];
  references: NamedOccurrence[];
}

export type NamedOccurrenceRole = 'definition' | 'reference';

export interface NamedOccurrence {
  kind: NamedItemKind;
  name: string;
  /** Text offsets of the name. */
  start: number;
  end: number;
  role: NamedOccurrenceRole;
  element: XmlElement;
  attribute: XmlAttribute;
  /** The item a definition defines, or the items a reference may resolve to; never empty. */
  items: NamedItem[];
  /** True when the name is resolved in another script by design: a label named in an interrupt library, a bare name in a Mission Director library. */
  external: boolean;
  /** True for a cue reference under `@` or tested with `?`: a missing cue does not fail there. */
  guarded: boolean;
}

export interface DocumentNames {
  items: NamedItem[];
  /** Every occurrence in text order. */
  occurrences: NamedOccurrence[];
  /** The occurrence that contains a caret at the offset. */
  occurrenceAt(offset: number): NamedOccurrence | undefined;
  /** Items of a kind, defined in this document, that a reference written in the element may name. */
  visible(kind: NamedItemKind, element: XmlElement): NamedItem[];
}

/** What the collector needs of an analysis: the scanned structure, the resolved declarations, which may be empty, and the script's name. */
export type NameSource = Pick<DocumentAnalysis, 'structure' | 'declarations' | 'detection'>;

/** Attribute types whose values name an item of a kind. */
const referenceTypes: ReadonlyMap<string, NamedItemKind> = new Map<string, NamedItemKind>([
  ['labelname', 'label'],
  ['interrupt_actionsref', 'actions'],
  ['interrupt_handlerref', 'handler'],
  ['interrupt_conditionsref', 'conditions'],
]);

/** Elements whose `ref` attribute names a Mission Director cue or library: the schema types it as a plain expression. */
const cueRefElements: ReadonlySet<string> = new Set(['cue', 'include_actions', 'run_actions']);

function hasAncestor(element: XmlElement, test: (candidate: XmlElement) => boolean): boolean {
  for (let current = element.parent; current; current = current.parent) {
    if (test(current)) {
      return true;
    }
  }
  return false;
}

/** True inside `<interrupts><library>` of an AI script. */
function insideInterruptLibrary(element: XmlElement): boolean {
  return hasAncestor(element, (candidate) => candidate.name === 'library' && candidate.parent?.name === 'interrupts');
}

/** The `<attention>` block an element of an AI script sits in. */
function attentionOf(element: XmlElement): XmlElement | undefined {
  for (let current: XmlElement | undefined = element; current; current = current.parent) {
    if (current.name === 'attention') {
      return current;
    }
  }
  return undefined;
}

/** The kind of item an attribute defines, or undefined. */
export function definitionKindOf(element: XmlElement, attributeName: string, schema: ScriptSchema): NamedItemKind | undefined {
  if (attributeName !== 'name') {
    return undefined;
  }
  if (schema === 'md') {
    return element.name === 'cue' || element.name === 'library' ? 'cue' : undefined;
  }
  if (element.name === 'label') {
    return 'label';
  }
  if (element.parent?.name === 'library' && element.parent.parent?.name === 'interrupts') {
    switch (element.name) {
      case 'actions':
      case 'handler':
      case 'conditions':
        return element.name;
    }
  }
  return undefined;
}

/** The kind of item a plain (not expression) attribute of an AI script names, or undefined. */
export function referenceKindOf(element: XmlElement, attributeName: string, declared: XsdAttribute | undefined): NamedItemKind | undefined {
  if (element.name === 'include_interrupt_actions' && attributeName === 'ref') {
    return 'actions';
  }
  if (!declared || (element.name === 'label' && attributeName === 'name')) {
    return undefined;
  }
  for (const name of typeNamesOf(declared.type)) {
    const kind = referenceTypes.get(name);
    if (kind) {
      return kind;
    }
  }
  return undefined;
}

/** True when a Mission Director attribute takes a cue: typed `cuename`, or the `ref` of a cue instance or a library call. */
export function isCueAttribute(element: XmlElement, attributeName: string, declared: XsdAttribute | undefined): boolean {
  if (attributeName === 'ref' && cueRefElements.has(element.name)) {
    return true;
  }
  return declared !== undefined && typeNamesOf(declared.type).has('cuename');
}

class NameCollector {
  readonly items: NamedItem[] = [];
  readonly occurrences: NamedOccurrence[] = [];
  private readonly byKey = new Map<string, NamedItem>();
  private readonly attentionScopes = new Map<XmlElement, string>();

  constructor(
    private readonly analysis: NameSource,
    private readonly schema: ScriptSchema,
    private readonly xsd: XsdSchema | undefined,
    private readonly properties: ScriptProperties | undefined
  ) {}

  private item(kind: NamedItemKind, scope: string, name: string, owner?: XmlElement): NamedItem {
    const key = `${kind}\n${scope}\n${name}`;
    let item = this.byKey.get(key);
    if (!item) {
      item = { kind, name, scope, definitions: [], references: [] };
      if (owner) {
        item.owner = owner;
      }
      this.byKey.set(key, item);
      this.items.push(item);
    }
    return item;
  }

  private declarationOf(element: XmlElement): XsdElement | undefined {
    return this.analysis.declarations.get(element) ?? this.xsd?.anyDeclaration(element.name);
  }

  private add(
    items: NamedItem[],
    role: NamedOccurrenceRole,
    element: XmlElement,
    attribute: XmlAttribute,
    start: number,
    end: number,
    external = false,
    guarded = false
  ): void {
    const { kind, name } = items[0];
    const occurrence: NamedOccurrence = { kind, name, start, end, role, element, attribute, items, external, guarded };
    for (const item of items) {
      (role === 'definition' ? item.definitions : item.references).push(occurrence);
    }
    this.occurrences.push(occurrence);
  }

  /** The trimmed value of a plain attribute with its text offsets, or undefined when it is empty. */
  private valueOf(attribute: XmlAttribute): { name: string; start: number; end: number } | undefined {
    if (attribute.quote === '') {
      return undefined;
    }
    const value = attribute.value;
    const name = value.trim();
    if (name === '') {
      return undefined;
    }
    const index = value.indexOf(name);
    return { name, start: offsetInValue(attribute, index), end: offsetInValue(attribute, index + name.length) };
  }

  /** `attention#<n>` for the n-th attention block of the script. */
  attentionScope(attention: XmlElement): string {
    let scope = this.attentionScopes.get(attention);
    if (scope === undefined) {
      const siblings = attention.parent?.children.filter((child) => child.name === 'attention') ?? [attention];
      scope = `attention#${siblings.indexOf(attention)}`;
      this.attentionScopes.set(attention, scope);
    }
    return scope;
  }

  collect(): void {
    const elements = this.analysis.structure?.elements ?? [];
    // Definitions first: a label reference outside a block resolves against the labels of every block.
    for (const element of elements) {
      for (const attribute of element.attributes) {
        const kind = definitionKindOf(element, attribute.name, this.schema);
        const value = kind && this.valueOf(attribute);
        if (!kind || !value) {
          continue;
        }
        const attention = kind === 'label' ? attentionOf(element) : undefined;
        const item = attention ? this.item(kind, this.attentionScope(attention), value.name, attention) : this.item(kind, 'script', value.name);
        this.add([item], 'definition', element, attribute, value.start, value.end);
      }
    }
    if (this.schema === 'md') {
      this.collectCueReferences(elements);
    } else {
      this.collectAiReferences(elements);
    }
    this.occurrences.sort((a, b) => a.start - b.start);
  }

  private collectAiReferences(elements: readonly XmlElement[]): void {
    for (const element of elements) {
      const declaration = this.declarationOf(element);
      for (const attribute of element.attributes) {
        const kind = referenceKindOf(element, attribute.name, declaration?.attributes.get(attribute.name));
        const value = kind && this.valueOf(attribute);
        if (!kind || !value) {
          continue;
        }
        if (kind !== 'label') {
          this.add([this.item(kind, 'script', value.name)], 'reference', element, attribute, value.start, value.end);
          continue;
        }
        if (insideInterruptLibrary(element)) {
          this.add([this.item('label', 'external', value.name)], 'reference', element, attribute, value.start, value.end, true);
          continue;
        }
        const attention = attentionOf(element);
        if (attention) {
          this.add([this.item('label', this.attentionScope(attention), value.name, attention)], 'reference', element, attribute, value.start, value.end);
          continue;
        }
        const targets = this.items.filter(
          (item) => item.kind === 'label' && item.name === value.name && item.scope.startsWith('attention#') && item.definitions.length > 0
        );
        this.add(targets.length > 0 ? targets : [this.item('label', 'script', value.name)], 'reference', element, attribute, value.start, value.end);
      }
    }
  }

  private collectCueReferences(elements: readonly XmlElement[]): void {
    const scriptName = this.analysis.detection.script?.name ?? '';
    for (const element of elements) {
      const declaration = this.declarationOf(element);
      if (!declaration) {
        continue;
      }
      let inLibrary: boolean | undefined;
      for (const attribute of element.attributes) {
        const declared = declaration.attributes.get(attribute.name);
        if (attribute.quote === '' || attribute.value.trim() === '' || !declared || !isExpressionAttribute(declared)) {
          continue;
        }
        const whole = parsedValue(attribute).expression;
        // Worked out only when a name turns up: most expressions name keywords and variables only.
        let enumeration: Set<string> | undefined;
        let guarded: Set<Expression> | undefined;
        const isEnumerationValue = (name: string): boolean => (enumeration ??= new Set(enumerationsOf(declared.type).map((value) => value.value))).has(name);
        const record = (name: string, start: number, end: number, node: Expression, external: boolean): void => {
          guarded ??= guardedNodes(whole);
          this.add(
            [this.item('cue', 'script', name)],
            'reference',
            element,
            attribute,
            offsetInValue(attribute, start),
            offsetInValue(attribute, end),
            external,
            guarded.has(node)
          );
        };
        walkExpression(whole, (node) => {
          if (node.kind === 'name') {
            // A keyword, or a value of the attribute's own enumeration (`position="top_right"`).
            if (this.properties?.keyword(node.name, 'md') || isEnumerationValue(node.name)) {
              return;
            }
            if ((this.byKey.get(`cue\nscript\n${node.name}`)?.definitions.length ?? 0) > 0) {
              record(node.name, node.start, node.end, node, false);
            } else if (this.properties && (node !== whole || isCueAttribute(element, attribute.name, declared))) {
              // Unknown to this script: a typo, or a cue of the script that includes this library.
              inLibrary ??= hasAncestor(element, (candidate) => candidate.name === 'library');
              record(node.name, node.start, node.end, node, inLibrary);
            }
            return;
          }
          // `md.<this script>.<cue>`
          if (
            node.kind === 'property' &&
            !node.name.startsWith('$') &&
            node.name !== '' &&
            node.object.kind === 'property' &&
            node.object.name === scriptName &&
            node.object.object.kind === 'name' &&
            node.object.object.name === 'md'
          ) {
            record(node.name, node.nameStart, node.nameEnd, node, false);
          }
        });
      }
    }
  }

  occurrenceAt(offset: number): NamedOccurrence | undefined {
    let low = 0;
    let high = this.occurrences.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const occurrence = this.occurrences[middle];
      if (offset < occurrence.start) {
        high = middle - 1;
      } else if (offset > occurrence.end) {
        low = middle + 1;
      } else {
        return occurrence;
      }
    }
    return undefined;
  }

  visible(kind: NamedItemKind, element: XmlElement): NamedItem[] {
    const defined = this.items.filter((item) => item.kind === kind && item.definitions.length > 0);
    if (kind !== 'label') {
      return defined.filter((item) => item.scope === 'script');
    }
    if (insideInterruptLibrary(element)) {
      return [];
    }
    const attention = attentionOf(element);
    if (attention) {
      const scope = this.attentionScope(attention);
      return defined.filter((item) => item.scope === scope);
    }
    const seen = new Set<string>();
    return defined.filter((item) => item.scope.startsWith('attention#') && !seen.has(item.name) && seen.add(item.name));
  }
}

/** Nodes where a missing cue does not fail: everything under `@`, and the operand of `?`. */
function guardedNodes(expression: Expression): Set<Expression> {
  const guarded = new Set<Expression>();
  walkExpression(expression, (node) => {
    if (node.kind === 'unary' && node.operator === '@') {
      walkExpression(node.operand, (inner) => guarded.add(inner));
    } else if (node.kind === 'exists') {
      guarded.add(node.operand);
    }
  });
  return guarded;
}

/** Collects the named items of an analysed script document. */
export function collectNames(analysis: NameSource, schema: ScriptSchema, xsd: XsdSchema | undefined, properties: ScriptProperties | undefined): DocumentNames {
  const collector = new NameCollector(analysis, schema, xsd, properties);
  collector.collect();
  return {
    items: collector.items,
    occurrences: collector.occurrences,
    occurrenceAt: (offset) => collector.occurrenceAt(offset),
    visible: (kind, element) => collector.visible(kind, element),
  };
}

/** Every occurrence connected to this one: the items it defines or may name, their definitions and references, and so on, in text order. */
export function relatedOccurrences(occurrence: NamedOccurrence): NamedOccurrence[] {
  const seenItems = new Set<NamedItem>();
  const found = new Set<NamedOccurrence>([occurrence]);
  const pending = [...occurrence.items];
  while (pending.length > 0) {
    const item = pending.pop() as NamedItem;
    if (seenItems.has(item)) {
      continue;
    }
    seenItems.add(item);
    for (const other of [...item.definitions, ...item.references]) {
      if (!found.has(other)) {
        found.add(other);
        pending.push(...other.items);
      }
    }
  }
  return [...found].sort((a, b) => a.start - b.start);
}
