/**
 * The model behind `scriptproperties.xml`: datatypes with their supertypes and properties, and keywords
 * with their properties. Property names are patterns such as `cargo.{$ware}.count`, split into segments
 * so a chain in an expression can be matched step by step.
 *
 * `import` elements pull enumeration values out of other game files (`wares.xml`, `common.xsd`, ...) with
 * the small XPath subset in `miniXPath`. Everything keeps its location for go to definition.
 */
import type { SourceLocation } from '../sourceLocation';
import type { ScriptSchema } from '../types';
import { selectElements, selectValue } from '../xml/miniXPath';
import { attributeNamed, parseXml, type XmlElement, type XmlStructure } from '../xml/xmlStructure';

/**
 * One segment of a property name pattern:
 * - `literal`: a fixed name such as `cargo`;
 * - `expression`: `{$type}`, a braced expression of that datatype, or a bare value of the keyword of that name;
 * - `variable`: `$<variable>` or `$<keyname>`, a variable or key written as `$name`;
 * - `any`: `<cuename>`, `<classname>`, ..., any name; some stand for the values of a keyword;
 * - `args`: `[$x, $y, $z]`, a bracketed argument list.
 */
export type PropertySegment =
  | { kind: 'literal'; text: string }
  | { kind: 'expression'; type: string }
  | { kind: 'variable'; name: string }
  | { kind: 'any'; name: string }
  | { kind: 'args'; text: string };

const expressionPlaceholder = /^\{\$(\w+)\}$/;
const variablePlaceholder = /^\$<(\w+)>$/;
const anyPlaceholder = /^<(\w+)>$/;

/** Splits a property name pattern on the dots outside brackets, braces and angle brackets. */
function splitPattern(name: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < name.length; index++) {
    const character = name[index];
    if (character === '[' || character === '{' || character === '<') {
      depth++;
    } else if (character === ']' || character === '}' || character === '>') {
      depth--;
    } else if (character === '.' && depth === 0) {
      parts.push(name.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(name.slice(start));
  return parts;
}

/** Splits a property name pattern into its segments. */
export function parseSegments(name: string): PropertySegment[] {
  return splitPattern(name).map((part) => {
    const expression = expressionPlaceholder.exec(part);
    if (expression) {
      return { kind: 'expression', type: expression[1] };
    }
    const variable = variablePlaceholder.exec(part);
    if (variable) {
      return { kind: 'variable', name: variable[1] };
    }
    const any = anyPlaceholder.exec(part);
    if (any) {
      return { kind: 'any', name: any[1] };
    }
    if (part.startsWith('[')) {
      return { kind: 'args', text: part };
    }
    return { kind: 'literal', text: part };
  });
}

export class ScriptProperty {
  readonly segments: readonly PropertySegment[];

  constructor(
    /** The name pattern as written, for example `isclass.{$class}`. */
    readonly name: string,
    /** Description of the value the property yields. */
    readonly result: string,
    /** Datatype name of the value, when declared. */
    readonly type: string | undefined,
    readonly owner: ScriptDatatype | ScriptKeyword,
    readonly location: SourceLocation | undefined
  ) {
    this.segments = parseSegments(name);
  }
}

export class ScriptDatatype {
  readonly properties = new Map<string, ScriptProperty>();
  supertype: ScriptDatatype | undefined;

  constructor(
    readonly name: string,
    readonly supertypeName: string | undefined,
    /** Unit suffix of literals of this type, such as `s` for time or `Cr` for money. */
    readonly suffix: string | undefined,
    /** A pseudo datatype is a live accessor whose result cannot be stored in a variable. */
    readonly pseudo: boolean,
    readonly location: SourceLocation | undefined
  ) {}

  /** This type and its supertypes, nearest first. */
  *chain(): IterableIterator<ScriptDatatype> {
    yield this;
    if (this.supertype) {
      yield* this.supertype.chain();
    }
  }

  /** Own properties first, then inherited ones that are not shadowed. */
  *allProperties(): IterableIterator<ScriptProperty> {
    const seen = new Set<string>();
    for (const current of this.chain()) {
      for (const property of current.properties.values()) {
        if (!seen.has(property.name)) {
          seen.add(property.name);
          yield property;
        }
      }
    }
  }

  /** The property with exactly this name pattern, own or inherited. */
  property(name: string): ScriptProperty | undefined {
    for (const current of this.chain()) {
      const found = current.properties.get(name);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** True when this type is the named type or derives from it. */
  isA(name: string): boolean {
    for (const current of this.chain()) {
      if (current.name === name) {
        return true;
      }
    }
    return false;
  }
}

export class ScriptKeyword {
  readonly properties = new Map<string, ScriptProperty>();
  /** Datatype of the keyword's own value, when declared. */
  type: ScriptDatatype | undefined;
  /** True when values were imported from game data files: a lookup whose list may lag behind the game or its DLCs. */
  imported = false;

  constructor(
    readonly name: string,
    readonly description: string,
    readonly typeName: string | undefined,
    /** Script kind the keyword is limited to; undefined for both. */
    readonly script: ScriptSchema | undefined,
    readonly location: SourceLocation | undefined
  ) {}

  /** Own properties, then those of the keyword's datatype. */
  *allProperties(): IterableIterator<ScriptProperty> {
    const seen = new Set<string>();
    for (const property of this.properties.values()) {
      seen.add(property.name);
      yield property;
    }
    if (this.type) {
      for (const property of this.type.allProperties()) {
        if (!seen.has(property.name)) {
          yield property;
        }
      }
    }
  }
}

export interface PropertySource {
  /** Absolute path, used in locations. */
  path: string;
  text: string;
}

export interface PropertySources {
  /** `scriptproperties.xml`. */
  main: PropertySource;
  /** Further definitions in the same format, read after the main file. */
  additions?: PropertySource[];
  /** Resolves an `import` source name such as `wares.xml` or `common.xsd` to its text, or undefined when missing. */
  readImport(source: string): PropertySource | undefined;
}

interface ParsedSource extends PropertySource {
  structure: XmlStructure;
}

const scriptByAttribute: Record<string, ScriptSchema> = { md: 'md', ai: 'aiscripts' };

export class ScriptProperties {
  readonly datatypes = new Map<string, ScriptDatatype>();
  readonly keywords: ScriptKeyword[] = [];
  readonly problems: string[] = [];
  /** Texts of every file the model was built from, by path, to turn locations into positions. */
  readonly sources = new Map<string, string>();
  private readonly imports = new Map<string, ParsedSource | null>();

  private constructor(private readonly input: PropertySources) {}

  /** Builds the model from the main file, the additions and the files they import. */
  static parse(sources: PropertySources): ScriptProperties {
    const properties = new ScriptProperties(sources);
    const parsed: ParsedSource[] = [];
    for (const source of [sources.main, ...(sources.additions ?? [])]) {
      properties.sources.set(source.path, source.text);
      parsed.push({ ...source, structure: parseXml(source.text) });
    }
    for (const source of parsed) {
      properties.readDatatypes(source);
    }
    for (const datatype of properties.datatypes.values()) {
      if (datatype.supertypeName !== undefined) {
        datatype.supertype = properties.datatypes.get(datatype.supertypeName);
        if (!datatype.supertype) {
          properties.problems.push(`datatype '${datatype.name}' derives from unknown datatype '${datatype.supertypeName}'`);
        }
      }
    }
    for (const source of parsed) {
      properties.readKeywords(source);
    }
    return properties;
  }

  /** The keyword usable in a script kind: the one declared for that kind, else the shared one. */
  keyword(name: string, schema?: ScriptSchema): ScriptKeyword | undefined {
    let shared: ScriptKeyword | undefined;
    for (const keyword of this.keywords) {
      if (keyword.name !== name) {
        continue;
      }
      if (keyword.script === undefined) {
        shared = keyword;
      } else if (keyword.script === schema) {
        return keyword;
      }
    }
    return shared;
  }

  /** Keywords usable in a script kind. */
  keywordsFor(schema: ScriptSchema): ScriptKeyword[] {
    return this.keywords.filter((keyword) => keyword.script === undefined || keyword.script === schema);
  }

  datatype(name: string): ScriptDatatype | undefined {
    return this.datatypes.get(name);
  }

  private locationOf(source: PropertySource, node: XmlElement): SourceLocation {
    return { file: source.path, start: node.start, end: node.startTagEnd };
  }

  private root(source: ParsedSource): XmlElement | undefined {
    const root = source.structure.roots[0];
    if (!root || root.name !== 'scriptproperties') {
      this.problems.push(`${source.path}: not a scriptproperties document`);
      return undefined;
    }
    return root;
  }

  private readDatatypes(source: ParsedSource): void {
    const root = this.root(source);
    for (const node of root?.children ?? []) {
      if (node.name !== 'datatype') {
        continue;
      }
      const name = attributeNamed(node, 'name')?.value;
      if (name === undefined) {
        this.problems.push(`${source.path}: datatype without name at offset ${node.start}`);
        continue;
      }
      let datatype = this.datatypes.get(name);
      if (!datatype) {
        datatype = new ScriptDatatype(
          name,
          attributeNamed(node, 'type')?.value,
          attributeNamed(node, 'suffix')?.value,
          attributeNamed(node, 'pseudo')?.value === 'true',
          this.locationOf(source, node)
        );
        this.datatypes.set(name, datatype);
      }
      for (const child of node.children) {
        if (child.name === 'property') {
          this.readProperty(source, child, datatype, datatype.properties);
        }
      }
    }
  }

  private readKeywords(source: ParsedSource): void {
    const root = this.root(source);
    for (const node of root?.children ?? []) {
      if (node.name !== 'keyword') {
        continue;
      }
      const name = attributeNamed(node, 'name')?.value;
      if (name === undefined) {
        this.problems.push(`${source.path}: keyword without name at offset ${node.start}`);
        continue;
      }
      const scriptAttribute = attributeNamed(node, 'script')?.value;
      const script = scriptAttribute === undefined ? undefined : scriptByAttribute[scriptAttribute];
      if (scriptAttribute !== undefined && script === undefined) {
        this.problems.push(`${source.path}: keyword '${name}' has unknown script '${scriptAttribute}'`);
      }
      const typeName = attributeNamed(node, 'type')?.value;
      // A later file (the additions) may extend a keyword the main file declares.
      let keyword = this.keywords.find((existing) => existing.name === name && existing.script === script);
      if (!keyword) {
        keyword = new ScriptKeyword(name, attributeNamed(node, 'description')?.value ?? '', typeName, script, this.locationOf(source, node));
        if (typeName !== undefined) {
          keyword.type = this.datatypes.get(typeName);
          if (!keyword.type) {
            this.problems.push(`${source.path}: keyword '${name}' has unknown type '${typeName}'`);
          }
        }
        this.keywords.push(keyword);
      }
      for (const child of node.children) {
        if (child.name === 'property') {
          this.readProperty(source, child, keyword, keyword.properties);
        } else if (child.name === 'import') {
          this.readImport(source, child, keyword);
        }
      }
    }
  }

  private readProperty(source: PropertySource, node: XmlElement, owner: ScriptDatatype | ScriptKeyword, into: Map<string, ScriptProperty>): void {
    const name = attributeNamed(node, 'name')?.value;
    if (name === undefined) {
      this.problems.push(`${source.path}: property without name at offset ${node.start}`);
      return;
    }
    into.set(
      name,
      new ScriptProperty(name, attributeNamed(node, 'result')?.value ?? '', attributeNamed(node, 'type')?.value, owner, this.locationOf(source, node))
    );
  }

  private importSource(name: string): ParsedSource | undefined {
    let parsed = this.imports.get(name);
    if (parsed === undefined) {
      const source = this.input.readImport(name);
      parsed = source ? { ...source, structure: parseXml(source.text) } : null;
      this.imports.set(name, parsed);
      if (source) {
        this.sources.set(source.path, source.text);
      }
    }
    return parsed ?? undefined;
  }

  private readImport(source: PropertySource, node: XmlElement, keyword: ScriptKeyword): void {
    const fileName = attributeNamed(node, 'source')?.value ?? '';
    const select = attributeNamed(node, 'select')?.value ?? '';
    const template = node.children.find((child) => child.name === 'property');
    if (!template) {
      this.problems.push(`${source.path}: import for keyword '${keyword.name}' has no property template`);
      return;
    }
    const imported = this.importSource(fileName);
    if (!imported) {
      this.problems.push(`${source.path}: import source '${fileName}' for keyword '${keyword.name}' is missing`);
      return;
    }
    let nodes: XmlElement[];
    try {
      nodes = selectElements(imported.structure, select);
    } catch (error) {
      this.problems.push(`${source.path}: import for keyword '${keyword.name}': ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    keyword.imported = true;
    const nameExpression = attributeNamed(template, 'name')?.value ?? '';
    const resultExpression = attributeNamed(template, 'result')?.value ?? '';
    const type = attributeNamed(template, 'type')?.value;
    const ignorePrefix = attributeNamed(template, 'ignoreprefix')?.value === 'true';
    let count = 0;
    for (const found of nodes) {
      let name = selectValue(found, nameExpression, imported.text);
      if (name === '') {
        continue;
      }
      if (ignorePrefix && name.startsWith(`${keyword.name}.`)) {
        name = name.slice(keyword.name.length + 1);
      }
      let result = selectValue(found, resultExpression, imported.text);
      if (result === '') {
        result = attributeNamed(found, 'comment')?.value ?? '';
      }
      keyword.properties.set(name, new ScriptProperty(name, result, type, keyword, { file: imported.path, start: found.start, end: found.startTagEnd }));
      count++;
    }
    if (count === 0) {
      this.problems.push(`${source.path}: import for keyword '${keyword.name}' from '${fileName}' selected nothing`);
    }
  }
}
