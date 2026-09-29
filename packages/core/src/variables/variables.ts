/**
 * Script variables and where they live.
 *
 * An AI script has one table of `$variables` for the whole script. A Mission Director script has one
 * table per cue: `$x` written in a cue refers to the table of the cue's namespace cue, which is the cue
 * itself when it is a root cue, a library, or declares `namespace="this"` or `"static"`, and the parent's
 * namespace cue otherwise. `this.$x`, `static.$x` and `staticbase.$x` name the cue's own table,
 * `parent.$x` the parent cue's, `namespace.$x` the namespace cue's, `Cue.$x` another cue's; `global.$x`
 * is the global table and `md.Script.Cue.$x` or `player.entity.$x` a remote table this document cannot
 * see into. Variables on values (`$obj.$x`, `event.param.$x`) are table keys, not script variables.
 *
 * A definition is an lvalue attribute whose whole value is the variable (`<set_value name="$x">`), or
 * a `<param name="x">` of a script or library. `<remove_value name="$x">` removes.
 *
 * AI scripts share interrupt library items (`<interrupts><library>` actions, handlers, conditions) by
 * name. An item runs in the script that uses it: what it sets counts as set in that script, which the
 * script index tells when the item is in another file; and what it reads is the using script's to set,
 * so those reads are external to the item's own script.
 */
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { IndexedPosition, ScriptIndex } from '../project/scriptIndex';
import { isChainNode, stepsOf } from '../expressions/astChain';
import { parsedValue } from '../expressions/attributeExpression';
import type { Expression } from '../expressions/parser';
import { resolveChain } from '../expressions/propertyChain';
import type { ScriptProperties } from '../properties/scriptProperties';
import type { ScriptSchema } from '../types';
import { attributeNamed, offsetInValue, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';
import { isExpressionAttribute, typeNamesOf, type XsdAttribute, type XsdElement, type XsdSchema } from '../xsd/schema';

export type VariableTableKind = 'script' | 'cue' | 'library' | 'global' | 'remote';

export interface VariableTable {
  kind: VariableTableKind;
  /** `script`, the cue or library name, `global`, or the object text of a remote table. */
  name: string;
  /** The aiscript root, cue or library element that owns the table. */
  owner?: XmlElement;
  variables: Map<string, ScriptVariable>;
  /**
   * Tables that share variables with this one: a library whose actions are spliced in with
   * `<include_actions>` runs in the including cue's table, so each sees the other's definitions.
   */
  links: Set<VariableTable>;
  /** True when code this document cannot see fills the table: a cue instantiating a library of another script. */
  opaque?: boolean;
}

export type OccurrenceKind = 'definition' | 'reference' | 'removal';

export interface VariableOccurrence {
  /** Variable name without `$`. */
  name: string;
  /** Text offsets of `$name`, or of the name of a `<param>`. */
  start: number;
  end: number;
  kind: OccurrenceKind;
  /** True when a missing variable does not fail here: under `@`, or tested with `?`. */
  guarded: boolean;
  /** True inside an interrupt library item of an AI script: it runs in the scripts that use it, which set what it reads. */
  external: boolean;
  element: XmlElement;
  attribute: XmlAttribute;
  table: VariableTable;
}

/** A definition in another file: a variable set by an interrupt library item the script uses. */
export interface ElsewhereDefinition {
  position: IndexedPosition;
  /** What sets it, such as `interrupt actions CheckTarget`. */
  via: string;
}

export interface ScriptVariable {
  name: string;
  table: VariableTable;
  definitions: VariableOccurrence[];
  references: VariableOccurrence[];
  removals: VariableOccurrence[];
  /** Definitions in other files, known from the script index. */
  elsewhere: ElsewhereDefinition[];
  /** Datatype names the definitions give the variable, when they could be told. */
  types: Set<string>;
}

/** What the collector needs of an analysis: the scanned structure and the resolved declarations, which may be empty. */
export type VariableSource = Pick<DocumentAnalysis, 'structure' | 'declarations'>;

export interface DocumentVariables {
  tables: VariableTable[];
  /** Every occurrence in text order. */
  occurrences: VariableOccurrence[];
  /** The table a bare `$name` written inside the element refers to. */
  tableOf(element: XmlElement): VariableTable;
  /** The table `object.$name` refers to for an object written as a chain of names (`this`, `parent`, `global`, a cue), or undefined for a key of a value. */
  tableForObjectText(object: string, element: XmlElement): VariableTable | undefined;
  /** The occurrence that contains a caret at the offset. */
  occurrenceAt(offset: number): VariableOccurrence | undefined;
  /** The variable of an occurrence. */
  variableOf(occurrence: VariableOccurrence): ScriptVariable;
  /** True when the variable is set in its table or in a table linked to it. */
  isDefined(variable: ScriptVariable): boolean;
}

/** Cue keywords that name a table relative to the current cue. */
const cueKeywords: ReadonlySet<string> = new Set(['this', 'static', 'staticbase', 'parent', 'namespace']);

function isLvalue(declared: XsdAttribute | undefined): boolean {
  if (!declared) {
    return false;
  }
  for (const name of typeNamesOf(declared.type)) {
    if (name.startsWith('lvalue')) {
      return true;
    }
  }
  return false;
}

/** Text of a chain of names with no variables, braces or brackets in it, such as `player.entity` or `md.Script.Cue`; undefined otherwise. */
function nameChainText(node: Expression): string | undefined {
  if (node.kind === 'name') {
    return node.name;
  }
  if (node.kind === 'property' && !node.name.startsWith('$')) {
    const object = nameChainText(node.object);
    return object === undefined ? undefined : `${object}.${node.name}`;
  }
  return undefined;
}

class Collector {
  readonly tables: VariableTable[] = [];
  readonly occurrences: VariableOccurrence[] = [];
  private readonly tableByOwner = new Map<XmlElement, VariableTable>();
  private readonly tableByName = new Map<string, VariableTable>();
  private readonly namespaces = new Map<XmlElement, XmlElement>();
  private readonly cuesByName = new Map<string, XmlElement>();
  private readonly scriptTable: VariableTable;

  constructor(
    private readonly analysis: VariableSource,
    private readonly schema: ScriptSchema,
    private readonly xsd: XsdSchema | undefined,
    private readonly properties: ScriptProperties | undefined
  ) {
    const root = analysis.structure?.roots[0];
    this.scriptTable = this.table('script', 'script', root);
    for (const element of analysis.structure?.elements ?? []) {
      if (this.isCue(element)) {
        const name = attributeNamed(element, 'name')?.value;
        if (name !== undefined && name !== '' && !this.cuesByName.has(name)) {
          this.cuesByName.set(name, element);
        }
      }
    }
  }

  private table(kind: VariableTableKind, name: string, owner?: XmlElement): VariableTable {
    if (owner) {
      const existing = this.tableByOwner.get(owner);
      if (existing) {
        return existing;
      }
    } else {
      const existing = this.tableByName.get(`${kind}:${name}`);
      if (existing) {
        return existing;
      }
    }
    const created: VariableTable = { kind, name, variables: new Map(), links: new Set() };
    if (owner) {
      created.owner = owner;
      this.tableByOwner.set(owner, created);
    } else {
      this.tableByName.set(`${kind}:${name}`, created);
    }
    this.tables.push(created);
    return created;
  }

  private isCue(element: XmlElement): boolean {
    return this.schema === 'md' && (element.name === 'cue' || element.name === 'library');
  }

  /** The cue or library the element belongs to. */
  private cueOf(element: XmlElement): XmlElement | undefined {
    for (let current: XmlElement | undefined = element; current; current = current.parent) {
      if (this.isCue(current)) {
        return current;
      }
    }
    return undefined;
  }

  /** The cue whose table a bare `$name` inside the cue refers to. */
  private namespaceOf(cue: XmlElement): XmlElement {
    const known = this.namespaces.get(cue);
    if (known) {
      return known;
    }
    let result = cue;
    const namespace = attributeNamed(cue, 'namespace')?.value;
    if (cue.name !== 'library' && namespace !== 'this' && namespace !== 'static') {
      const parent = cue.parent && this.cueOf(cue.parent);
      if (parent) {
        result = this.namespaceOf(parent);
      }
    }
    this.namespaces.set(cue, result);
    return result;
  }

  private cueTable(cue: XmlElement): VariableTable {
    return this.table(cue.name === 'library' ? 'library' : 'cue', attributeNamed(cue, 'name')?.value ?? '', cue);
  }

  tableOf(element: XmlElement): VariableTable {
    const cue = this.cueOf(element);
    return cue ? this.cueTable(this.namespaceOf(cue)) : this.scriptTable;
  }

  /** The table `object.$x` refers to, or undefined when the variable is a key of a value. */
  private tableForObject(object: Expression, element: XmlElement): VariableTable | undefined {
    const text = nameChainText(object);
    return text === undefined ? undefined : this.tableForObjectText(text, element);
  }

  /** The table `object.$x` refers to for an object written as a chain of names. */
  tableForObjectText(text: string, element: XmlElement): VariableTable | undefined {
    if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(text)) {
      return undefined;
    }
    if (text === 'global') {
      return this.table('global', 'global');
    }
    if (this.schema === 'md') {
      const cue = this.cueOf(element);
      if (cueKeywords.has(text)) {
        if (!cue) {
          return this.table('remote', text);
        }
        switch (text) {
          case 'parent': {
            const parent = cue.parent && this.cueOf(cue.parent);
            return parent ? this.cueTable(parent) : this.table('remote', text);
          }
          case 'namespace':
            return this.cueTable(this.namespaceOf(cue));
          default:
            return this.cueTable(cue);
        }
      }
      const named = this.cuesByName.get(text);
      if (named) {
        return this.cueTable(named);
      }
    }
    return this.table('remote', text);
  }

  private declarationOf(element: XmlElement): XsdElement | undefined {
    return this.analysis.declarations.get(element) ?? this.xsd?.anyDeclaration(element.name);
  }

  collect(): void {
    for (const element of this.analysis.structure?.elements ?? []) {
      if (element.name === 'param') {
        this.collectParam(element);
      }
      const declaration = this.declarationOf(element);
      if (!declaration) {
        continue;
      }
      for (const attribute of element.attributes) {
        const declared = declaration.attributes.get(attribute.name);
        if (attribute.quote === '' || attribute.value.trim() === '' || !isExpressionAttribute(declared)) {
          continue;
        }
        this.collectAttribute(element, attribute, isLvalue(declared));
      }
    }
    this.linkIncludedLibraries();
    this.occurrences.sort((a, b) => a.start - b.start);
  }

  /** `<include_actions ref="Lib">` splices the library's actions into the including cue: both run in one table. */
  private linkIncludedLibraries(): void {
    if (this.schema !== 'md') {
      return;
    }
    for (const element of this.analysis.structure?.elements ?? []) {
      if (element.name !== 'include_actions' && element.name !== 'cue') {
        continue;
      }
      const ref = attributeNamed(element, 'ref')?.value;
      if (ref === undefined || ref === '') {
        continue;
      }
      const library = this.cuesByName.get(ref);
      if (!library || library.name !== 'library') {
        if (element.name === 'cue') {
          // `<cue ref="md.Script.Library">`: another script's library fills this cue's variables.
          this.cueTable(element).opaque = true;
        }
        continue;
      }
      const user = element.name === 'cue' ? this.cueTable(element) : this.tableOf(element);
      const used = this.cueTable(library);
      if (user !== used) {
        user.links.add(used);
        used.links.add(user);
      }
    }
  }

  /** True when the variable is set in its table, in a table linked to it, or by a library item of another file. */
  isDefined(variable: ScriptVariable): boolean {
    if (variable.definitions.length > 0 || variable.elsewhere.length > 0) {
      return true;
    }
    const seen = new Set<VariableTable>([variable.table]);
    const pending = [...variable.table.links];
    while (pending.length > 0) {
      const table = pending.pop() as VariableTable;
      if (seen.has(table)) {
        continue;
      }
      seen.add(table);
      if ((table.variables.get(variable.name)?.definitions.length ?? 0) > 0) {
        return true;
      }
      pending.push(...table.links);
    }
    return false;
  }

  /**
   * `<param name="x">` of a script (`aiscript/params`) or a library (`library/params`) defines `$x`; so
   * does a `<param>` given to a cue that instantiates a library (`<cue ref="Lib"><param name="x">`).
   */
  private collectParam(element: XmlElement): void {
    const parent = element.parent;
    let table: VariableTable | undefined;
    if (parent?.name === 'params') {
      // Declared parameters: of the script (`aiscript/params`, `order/params`) or of a library (`library/params`).
      const cue = this.cueOf(parent);
      table = cue ? this.cueTable(cue) : this.scriptTable;
    } else if (parent?.name === 'cue') {
      const library = this.cuesByName.get(attributeNamed(parent, 'ref')?.value ?? '');
      table = library && library.name === 'library' ? this.cueTable(library) : undefined;
    }
    const name = attributeNamed(element, 'name');
    if (!table || !name || name.value === '') {
      return;
    }
    const occurrence = this.add(table, name.value.replace(/^\$/, ''), name.valueStart, name.valueEnd, 'definition', false, element, name);
    const type = attributeNamed(element, 'type')?.value;
    if (type !== undefined && type !== '') {
      this.variableOf(occurrence).types.add(type);
    }
    this.inferType(occurrence, element);
  }

  private add(
    table: VariableTable,
    name: string,
    start: number,
    end: number,
    kind: OccurrenceKind,
    guarded: boolean,
    element: XmlElement,
    attribute: XmlAttribute
  ): VariableOccurrence {
    const external = this.schema === 'aiscripts' && this.inInterruptLibrary(element);
    const occurrence: VariableOccurrence = { name, start, end, kind, guarded, external, element, attribute, table };
    const variable = this.variableOf(occurrence);
    (kind === 'definition' ? variable.definitions : kind === 'removal' ? variable.removals : variable.references).push(occurrence);
    this.occurrences.push(occurrence);
    return occurrence;
  }

  private inInterruptLibrary(element: XmlElement): boolean {
    for (let current = element.parent; current; current = current.parent) {
      if (current.name === 'library' && current.parent?.name === 'interrupts') {
        return true;
      }
    }
    return false;
  }

  variableOf(occurrence: Pick<VariableOccurrence, 'name' | 'table'>): ScriptVariable {
    let variable = occurrence.table.variables.get(occurrence.name);
    if (!variable) {
      variable = { name: occurrence.name, table: occurrence.table, definitions: [], references: [], removals: [], elsewhere: [], types: new Set() };
      occurrence.table.variables.set(occurrence.name, variable);
    }
    return variable;
  }

  /**
   * The variables that interrupt library items of other files set, for the items an AI script uses:
   * `include_interrupt_actions ref`, `<handler ref>`, and a handler's `actions` and `conditions ref`.
   * Items of the script itself are in its own table already.
   */
  addLibraryDefinitions(index: ScriptIndex): void {
    if (this.schema !== 'aiscripts') {
      return;
    }
    const root = this.analysis.structure?.roots[0];
    const scriptName = root ? attributeNamed(root, 'name')?.value : undefined;
    for (const element of this.analysis.structure?.elements ?? []) {
      const ref = attributeNamed(element, 'ref')?.value.trim();
      if (!ref) {
        continue;
      }
      const kind =
        element.name === 'include_interrupt_actions'
          ? 'actions'
          : element.name === 'handler' && element.parent?.name === 'interrupts'
            ? 'handler'
            : (element.name === 'actions' || element.name === 'conditions') && element.parent?.name === 'handler'
              ? element.name
              : undefined;
      if (!kind) {
        continue;
      }
      for (const item of index.libraryItems(kind, ref)) {
        if (item.script === scriptName && !item.patch) {
          continue;
        }
        for (const set of item.variables) {
          const variable = this.variableOf({ name: set.name, table: this.scriptTable });
          if (!variable.elsewhere.some((known) => known.position.file === set.position.file && known.position.line === set.position.line)) {
            variable.elsewhere.push({ position: set.position, via: `interrupt ${kind} ${item.name}` });
          }
        }
      }
    }
  }

  private collectAttribute(element: XmlElement, attribute: XmlAttribute, lvalue: boolean): void {
    const parsed = parsedValue(attribute);
    const whole = parsed.expression;
    const kindOfWhole: OccurrenceKind = lvalue ? (element.name === 'remove_value' ? 'removal' : 'definition') : 'reference';
    const record = (table: VariableTable, name: string, start: number, end: number, node: Expression, guarded: boolean): VariableOccurrence =>
      this.add(
        table,
        name,
        offsetInValue(attribute, start),
        offsetInValue(attribute, end),
        node === whole ? kindOfWhole : 'reference',
        guarded,
        element,
        attribute
      );

    const visit = (node: Expression, guarded: boolean): void => {
      switch (node.kind) {
        case 'variable': {
          const occurrence = record(this.tableOf(element), node.name.slice(1), node.start, node.end, node, guarded);
          if (occurrence.kind === 'definition') {
            this.inferType(occurrence, element);
          }
          return;
        }
        case 'property': {
          if (node.name.startsWith('$')) {
            const table = this.tableForObject(node.object, element);
            if (table) {
              const occurrence = record(table, node.name.slice(1), node.nameStart, node.nameEnd, node, guarded);
              if (occurrence.kind === 'definition') {
                this.inferType(occurrence, element);
              }
            }
          }
          visit(node.object, guarded);
          return;
        }
        case 'dynamic':
          visit(node.object, guarded);
          visit(node.key, false);
          return;
        case 'args':
          visit(node.object, guarded);
          for (const argument of node.args) {
            visit(argument, false);
          }
          return;
        case 'unary':
          visit(node.operand, guarded || node.operator === '@');
          return;
        case 'exists':
          // `$x?` tests the variable itself; `$x.y?` still evaluates `$x`.
          visit(node.operand, guarded || node.operand.kind === 'variable' || (node.operand.kind === 'property' && node.operand.name.startsWith('$')));
          return;
        case 'cast':
          visit(node.operand, guarded);
          return;
        case 'group':
          visit(node.expression, guarded);
          return;
        case 'binary':
          visit(node.left, guarded);
          visit(node.right, guarded);
          return;
        case 'conditional':
          visit(node.condition, guarded);
          visit(node.then, guarded);
          if (node.else) {
            visit(node.else, guarded);
          }
          return;
        case 'textref':
          visit(node.page, guarded);
          visit(node.id, guarded);
          return;
        case 'list':
          for (const item of node.items) {
            visit(item, guarded);
          }
          return;
        case 'table':
          for (const entry of node.entries) {
            // `table[$key = value]`: the key names an entry, it does not read a variable.
            if (entry.key.kind !== 'variable') {
              visit(entry.key, guarded);
            }
            visit(entry.value, guarded);
          }
          return;
        case 'call':
          for (const argument of node.args) {
            visit(argument, guarded);
          }
          return;
        default:
          return;
      }
    };
    visit(whole, false);
  }

  /** Types a definition gives its variable: `<param type="...">`, or the datatype of the value in `exact` or `default`. */
  private inferType(occurrence: VariableOccurrence, element: XmlElement): void {
    if (!this.properties) {
      return;
    }
    const declaration = this.declarationOf(element);
    for (const source of ['exact', 'default']) {
      const attribute = attributeNamed(element, source);
      if (!attribute || attribute.value.trim() === '' || !isExpressionAttribute(declaration?.attributes.get(source))) {
        continue;
      }
      const node = parsedValue(attribute).expression;
      const datatype = this.datatypeOf(node, attribute.value);
      if (datatype !== undefined) {
        this.variableOf(occurrence).types.add(datatype);
      }
      return;
    }
  }

  /** Datatype name of a value expression when it is a resolvable chain or a literal. */
  private datatypeOf(node: Expression, text: string): string | undefined {
    if (!this.properties) {
      return undefined;
    }
    if (node.kind === 'group') {
      return this.datatypeOf(node.expression, text);
    }
    if (node.kind === 'table') {
      return 'table';
    }
    if (isChainNode(node) || node.kind === 'name' || node.kind === 'string' || node.kind === 'number' || node.kind === 'list' || node.kind === 'textref') {
      const { steps } = stepsOf(node, text);
      const resolved = resolveChain({ steps }, this.properties, this.schema);
      return resolved.steps[resolved.steps.length - 1].datatype?.name;
    }
    return undefined;
  }

  occurrenceAt(offset: number): VariableOccurrence | undefined {
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
}

/** Collects the variables of an analysed script document; with the script index, those that library items of other files set as well. */
export function collectVariables(
  analysis: VariableSource,
  schema: ScriptSchema,
  xsd: XsdSchema | undefined,
  properties: ScriptProperties | undefined,
  index?: ScriptIndex
): DocumentVariables {
  const collector = new Collector(analysis, schema, xsd, properties);
  collector.collect();
  if (index) {
    collector.addLibraryDefinitions(index);
  }
  return {
    tables: collector.tables,
    occurrences: collector.occurrences,
    tableOf: (element) => collector.tableOf(element),
    tableForObjectText: (object, element) => collector.tableForObjectText(object, element),
    occurrenceAt: (offset) => collector.occurrenceAt(offset),
    variableOf: (occurrence) => collector.variableOf(occurrence),
    isDefined: (variable) => collector.isDefined(variable),
  };
}
