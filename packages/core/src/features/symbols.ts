/**
 * The outline of a script or patch document.
 *
 * Mission Director scripts: the script, its cues and libraries as they nest, and the parameters of
 * libraries and cue instances. AI scripts: the script, the order with its parameters, the interrupts
 * with their handlers and library items, `init`, `patch` blocks, the attention blocks with their labels,
 * and `on_abort`. In both, each variable the script sets is listed where it is first set, with the cue
 * whose table holds it when that is another one (the namespace cue, as the hover says). Patch
 * documents: each operation, named by its path, with the outline of the content it brings in. The
 * elements that make the outline each belong to one kind of script, except `library`, so content is
 * outlined without knowing where it lands; a patch's folder tells which kind of library it brings in.
 * Variables need the schemas; the rest is read from the structure alone and works on half-typed XML.
 */
import { Range, SymbolKind, type DocumentSymbol } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { scriptSchemaOf } from '../analysis/positionContext';
import type { ScriptSchema } from '../types';
import type { VariableOccurrence } from '../variables/variables';
import { attributeNamed, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';

interface Outlined {
  kind: SymbolKind;
  name: string;
  detail?: string;
  /** Where the name is written; the element's name when there is none. */
  selection?: { start: number; end: number };
}

/** The trimmed value of an attribute with its text offsets, or undefined when it is empty. */
function valueOf(attribute: XmlAttribute | undefined): { value: string; start: number; end: number } | undefined {
  if (!attribute || attribute.quote === '') {
    return undefined;
  }
  const value = attribute.rawValue.trim();
  if (value === '') {
    return undefined;
  }
  const start = attribute.valueStart + attribute.rawValue.indexOf(value);
  return { value: attribute.value.trim(), start, end: start + value.length };
}

/** An item named by an attribute, or by the fallback when the attribute is missing or empty, as while typing. */
function named(element: XmlElement, attribute: string, kind: SymbolKind, fallback: string, detail?: string): Outlined {
  const value = valueOf(attributeNamed(element, attribute));
  return {
    kind,
    name: value?.value ?? fallback,
    ...(detail ? { detail } : {}),
    ...(value ? { selection: value } : {}),
  };
}

function attributeValue(element: XmlElement, name: string): string | undefined {
  const value = attributeNamed(element, name)?.value.trim();
  return value === '' ? undefined : value;
}

function cueDetail(element: XmlElement): string | undefined {
  const facts: string[] = [];
  const ref = attributeValue(element, 'ref');
  if (ref) {
    facts.push(`instance of ${ref}`);
  }
  if (attributeValue(element, 'instantiate') === 'true') {
    facts.push('instantiated');
  }
  const namespace = attributeValue(element, 'namespace');
  if (namespace) {
    facts.push(`namespace ${namespace}`);
  }
  return facts.length > 0 ? facts.join(', ') : undefined;
}

/** A parameter of a script, an order, a library or a cue instance: it sets the variable of its name. */
function isParameter(element: XmlElement): boolean {
  return element.name === 'param' && (element.parent?.name === 'params' || element.parent?.name === 'cue');
}

/** What the element is in the outline, or undefined when only its descendants may be. */
function outlined(element: XmlElement, schema: ScriptSchema | undefined): Outlined | undefined {
  switch (element.name) {
    case 'mdscript':
    case 'aiscript':
      return element.parent ? undefined : named(element, 'name', SymbolKind.Module, element.name);
    case 'diff':
      return element.parent ? undefined : { kind: SymbolKind.Module, name: 'diff' };
    case 'add':
    case 'replace':
    case 'remove': {
      if (element.parent?.name !== 'diff' || element.parent.parent) {
        return undefined;
      }
      const sel = valueOf(attributeNamed(element, 'sel'));
      const detail = [element.name, attributeValue(element, 'type') ?? attributeValue(element, 'pos')].filter(Boolean).join(' ');
      return sel
        ? { kind: SymbolKind.Operator, name: sel.value.replace(/\s+/g, ' '), detail, selection: sel }
        : { kind: SymbolKind.Operator, name: element.name, detail };
    }
    case 'cue':
      return named(element, 'name', SymbolKind.Event, 'cue', cueDetail(element));
    case 'library': {
      // Both kinds of script have libraries: the kind of the document tells, else a name, which only Mission Director libraries have.
      if (element.parent?.name === 'interrupts' || schema === 'aiscripts' || (schema === undefined && !attributeNamed(element, 'name'))) {
        return { kind: SymbolKind.Namespace, name: 'library' };
      }
      const purpose = attributeValue(element, 'purpose');
      return named(element, 'name', SymbolKind.Function, 'library', purpose ? `library, purpose ${purpose}` : 'library');
    }
    case 'param': {
      if (!isParameter(element)) {
        return undefined;
      }
      const parameter = named(element, 'name', SymbolKind.Property, 'param');
      const type = attributeValue(element, 'type');
      return { ...parameter, name: parameter.selection ? `$${parameter.name.replace(/^\$/, '')}` : parameter.name, detail: type ? `param, ${type}` : 'param' };
    }
    case 'order':
      return named(element, 'id', SymbolKind.Interface, 'order', 'order');
    case 'interrupts':
      return { kind: SymbolKind.Namespace, name: 'interrupts' };
    case 'attention': {
      const min = attributeValue(element, 'min');
      return { kind: SymbolKind.Namespace, name: 'attention', ...(min ? { detail: `min ${min}` } : {}) };
    }
    case 'patch': {
      // The patch blocks of an AI script; those of cues and libraries are left to their cue.
      if (element.parent?.name !== 'aiscript') {
        return undefined;
      }
      const version = attributeValue(element, 'sinceversion');
      return { kind: SymbolKind.Namespace, name: 'patch', ...(version ? { detail: `since version ${version}` } : {}) };
    }
    case 'init':
      return { kind: SymbolKind.Constructor, name: 'init' };
    case 'on_abort':
      return { kind: SymbolKind.Event, name: 'on_abort' };
    case 'label':
      return named(element, 'name', SymbolKind.Key, 'label', 'label');
    case 'handler': {
      if (attributeNamed(element, 'name')) {
        return named(element, 'name', SymbolKind.Event, 'handler', 'handler');
      }
      if (attributeNamed(element, 'ref')) {
        return named(element, 'ref', SymbolKind.Event, 'handler', 'handler ref');
      }
      // An inline handler, told apart by what it waits for.
      const first = element.children.find((child) => child.name === 'conditions')?.children[0];
      return { kind: SymbolKind.Event, name: 'handler', ...(first ? { detail: first.name } : {}) };
    }
    case 'actions':
    case 'conditions':
      // Only the items of an interrupt library have a name.
      return attributeNamed(element, 'name') ? named(element, 'name', SymbolKind.Function, element.name, element.name) : undefined;
  }
  return undefined;
}

/**
 * The outline of a script or patch document; empty for other documents. Symbols nest as their elements
 * do, in document order.
 */
export function documentSymbols(analysis: DocumentAnalysis): DocumentSymbol[] {
  const structure = analysis.structure;
  if (!structure || (!analysis.detection.script && !analysis.detection.isDiff)) {
    return [];
  }
  const document = analysis.document;
  const schema = scriptSchemaOf(analysis);
  const range = (start: number, end: number): Range => Range.create(document.positionAt(start), document.positionAt(end));
  const symbolOf = new Map<XmlElement, DocumentSymbol>();
  const walk = (elements: readonly XmlElement[]): DocumentSymbol[] => {
    const symbols: DocumentSymbol[] = [];
    for (const element of elements) {
      const item = outlined(element, schema);
      if (!item) {
        symbols.push(...walk(element.children));
        continue;
      }
      const selection = item.selection ?? { start: element.nameStart, end: element.nameEnd };
      const symbol: DocumentSymbol = {
        name: item.name,
        kind: item.kind,
        range: range(element.start, Math.max(element.end, selection.end)),
        selectionRange: range(selection.start, selection.end),
        children: walk(element.children),
      };
      if (item.detail) {
        symbol.detail = item.detail;
      }
      symbolOf.set(element, symbol);
      symbols.push(symbol);
    }
    return symbols;
  };
  const symbols = walk(structure.roots);
  if (analysis.detection.script) {
    addVariables(analysis, symbolOf, range);
  }
  return symbols;
}

/**
 * Adds each variable a script sets at its first definition, under the innermost symbol around it. That
 * is the first definition inside the element that owns the variable's table (the script, a cue or a
 * library), else the first one elsewhere (`Cue.$x` written by another cue); so a library's parameter
 * stays a parameter when a `run_actions` call before the library sets it too. When the symbol around
 * the definition is not the owner, the detail names the owner. Parameters are there already; tables
 * this document cannot see into (`global`, remote cues) are left out.
 */
function addVariables(analysis: DocumentAnalysis, symbolOf: Map<XmlElement, DocumentSymbol>, range: (start: number, end: number) => Range): void {
  const variables = analysis.variables;
  if (!variables) {
    return;
  }
  const added = new Map<DocumentSymbol, DocumentSymbol[]>();
  for (const table of variables.tables) {
    const owner = table.owner;
    if (!owner || !symbolOf.has(owner)) {
      continue;
    }
    const within = (occurrence: VariableOccurrence): boolean => occurrence.start >= owner.start && occurrence.end <= owner.end;
    for (const variable of table.variables.values()) {
      let first: VariableOccurrence | undefined;
      for (const definition of variable.definitions) {
        if (!first || (within(definition) && !within(first)) || (within(definition) === within(first) && definition.start < first.start)) {
          first = definition;
        }
      }
      if (!first || (isParameter(first.element) && symbolOf.has(first.element))) {
        continue;
      }
      let holder: XmlElement | undefined = first.element;
      while (holder && !symbolOf.has(holder)) {
        holder = holder.parent;
      }
      const parent = holder && symbolOf.get(holder);
      if (!parent) {
        continue;
      }
      const facts = variable.types.size > 0 ? [[...variable.types].join(' or ')] : [];
      if (holder !== owner && (table.kind === 'cue' || table.kind === 'library')) {
        facts.push(`of ${table.kind} ${table.name}`);
      }
      let list = added.get(parent);
      if (!list) {
        added.set(parent, (list = []));
      }
      list.push({
        name: `$${first.name}`,
        kind: SymbolKind.Variable,
        ...(facts.length > 0 ? { detail: facts.join(', ') } : {}),
        range: range(Math.min(first.attribute.start, first.start), Math.max(first.attribute.end, first.end)),
        selectionRange: range(first.start, first.end),
      });
    }
  }
  for (const [parent, list] of added) {
    const children = [...(parent.children ?? []), ...list];
    children.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
    parent.children = children;
  }
}
