/**
 * The XSD model of one schema (`md` or `aiscripts`, with `common.xsd` merged in, or `diff`), built from
 * the schema texts with the core's own scanner. Only the subset of XML Schema the game uses is supported:
 * sequence, choice, all, group references, `any` wildcards, named complex types with extension,
 * attribute groups, simple types with restriction facets, unions and lists; entities a schema file
 * declares in its own DOCTYPE are expanded in facet values. Everything is compiled lazily and cached, so a
 * schema loads in milliseconds and only the parts a document touches get resolved.
 */
import type { SourceLocation } from '../sourceLocation';
import { attributeNamed, decodeAttributeValue, parseXml, type XmlElement } from '../xml/xmlStructure';
import { compileContentModel, type ContentModel, type ElementParticle, type GroupParticle, type Particle } from './contentModel';

/** Where a declaration lives: the start tag of its node in a schema file. */
export type XsdLocation = SourceLocation;

export interface XsdFile {
  /** Absolute path, used in locations. */
  path: string;
  text: string;
}

export interface XsdProblem {
  file: string;
  message: string;
}

export type XsdBuiltin = 'string' | 'integer' | 'nonNegativeInteger' | 'float' | 'boolean' | 'other';

export interface XsdEnumeration {
  value: string;
  documentation?: string;
  location: XsdLocation;
}

export interface XsdSimpleType {
  /** Name of a named type; anonymous types have none. */
  name?: string;
  location?: XsdLocation;
  documentation?: string;
  variety: 'atomic' | 'union' | 'list';
  /** Atomic types: the named type this one restricts, absent when the base is a built-in type. */
  base?: XsdSimpleType;
  /** Effective built-in base; `string` for unions and lists. */
  builtin: XsdBuiltin;
  /** Enumeration facets declared at this level. */
  enumerations: XsdEnumeration[];
  /** Pattern facets declared at this level, anchored to the whole value. */
  patterns: RegExp[];
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
  /** Union member types. */
  members: XsdSimpleType[];
  /** Item type of a list. */
  itemType?: XsdSimpleType;
}

export interface XsdAttribute {
  name: string;
  type: XsdSimpleType;
  /** The declared type name, when the attribute refers to a named type. */
  typeName?: string;
  required: boolean;
  default?: string;
  documentation?: string;
  location: XsdLocation;
}

interface ComplexType {
  attributes: Map<string, XsdAttribute>;
  particle?: Particle;
}

const builtinByName: Record<string, XsdBuiltin> = {
  string: 'string',
  normalizedString: 'string',
  token: 'string',
  integer: 'integer',
  int: 'integer',
  long: 'integer',
  short: 'integer',
  positiveInteger: 'nonNegativeInteger',
  nonNegativeInteger: 'nonNegativeInteger',
  unsignedInt: 'nonNegativeInteger',
  float: 'float',
  double: 'float',
  decimal: 'float',
  boolean: 'boolean',
};

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

function isBuiltinReference(typeName: string): boolean {
  return typeName.startsWith('xs:') || typeName.startsWith('xsd:');
}

function builtinOf(typeName: string): XsdBuiltin {
  return builtinByName[localName(typeName)] ?? 'other';
}

function occursOf(node: XmlElement): { min: number; max: number } {
  const min = attributeNamed(node, 'minOccurs')?.value;
  const max = attributeNamed(node, 'maxOccurs')?.value;
  return {
    min: min === undefined ? 1 : Math.max(0, parseInt(min, 10) || 0),
    max: max === undefined ? 1 : max === 'unbounded' ? Infinity : Math.max(1, parseInt(max, 10) || 1),
  };
}

function childrenNamed(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((child) => localName(child.name) === name);
}

function firstChildNamed(node: XmlElement, ...names: string[]): XmlElement | undefined {
  return node.children.find((child) => names.includes(localName(child.name)));
}

/** The general entities a file declares in the internal subset of its DOCTYPE, by name. */
function entitiesOf(text: string): Map<string, string> {
  const entities = new Map<string, string>();
  const doctype = /<!DOCTYPE[^[>]*\[([^]*?)\]\s*>/.exec(text);
  if (!doctype) {
    return entities;
  }
  for (const match of doctype[1].matchAll(/<!ENTITY\s+([\w.:-]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g)) {
    entities.set(match[1], match[2] ?? match[3]);
  }
  return entities;
}

/** Replaces references to the given entities, their own references included; others stay as written. */
function expandEntities(raw: string, entities: ReadonlyMap<string, string>, depth = 0): string {
  return raw.replace(/&([\w.:-]+);/g, (reference, name: string) => {
    const replacement = entities.get(name);
    return replacement === undefined || depth > 16 ? reference : expandEntities(replacement, entities, depth + 1);
  });
}

// XML name characters, for the `\i` and `\c` escapes of XSD regular expressions.
const nameStartCharacters =
  'A-Za-z_:\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const nameCharacters = `${nameStartCharacters}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;

/** An XSD pattern as a JavaScript regular expression source: `\i`, `\c`, `\I` and `\C` become character classes. */
function patternSource(pattern: string): string {
  let source = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\' && index + 1 < pattern.length) {
      const escaped = pattern[index + 1];
      index++;
      const characters = escaped === 'i' || escaped === 'I' ? nameStartCharacters : escaped === 'c' || escaped === 'C' ? nameCharacters : undefined;
      if (characters === undefined) {
        source += `\\${escaped}`;
      } else if (inClass) {
        // A negated escape inside a class has no simple form; it is left as the plain class.
        source += characters;
      } else {
        source += escaped === 'i' || escaped === 'c' ? `[${characters}]` : `[^${characters}]`;
      }
      continue;
    }
    if (character === '[') {
      inClass = true;
    } else if (character === ']') {
      inClass = false;
    }
    source += character;
  }
  return source;
}

const integerPattern = /^[+-]?\d+$/;
const nonNegativeIntegerPattern = /^\+?\d+$/;
const floatPattern = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const booleanPattern = /^(true|false|1|0)$/;

function acceptsBuiltin(builtin: XsdBuiltin, value: string): boolean {
  switch (builtin) {
    case 'integer':
      return integerPattern.test(value);
    case 'nonNegativeInteger':
      return nonNegativeIntegerPattern.test(value);
    case 'float':
      return floatPattern.test(value);
    case 'boolean':
      return booleanPattern.test(value);
    default:
      return true;
  }
}

/** Whitespace normalisation applied before facets are checked: line breaks and tabs count as spaces, ends are trimmed. */
export function normalizeValue(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ').trim();
}

function acceptsNormalized(type: XsdSimpleType, value: string): boolean {
  if (type.variety === 'union') {
    return type.members.some((member) => acceptsNormalized(member, value));
  }
  if (type.variety === 'list') {
    const items = value.split(/\s+/).filter((item) => item.length > 0);
    return type.itemType === undefined || items.every((item) => acceptsNormalized(type.itemType as XsdSimpleType, item));
  }
  if (type.base ? !acceptsNormalized(type.base, value) : !acceptsBuiltin(type.builtin, value)) {
    return false;
  }
  if (type.enumerations.length > 0 && !type.enumerations.some((enumeration) => enumeration.value === value)) {
    return false;
  }
  // Several patterns in one restriction step are alternatives; steps combine by restriction of the base.
  if (type.patterns.length > 0 && !type.patterns.some((pattern) => pattern.test(value))) {
    return false;
  }
  if (type.minInclusive !== undefined || type.maxInclusive !== undefined || type.minExclusive !== undefined || type.maxExclusive !== undefined) {
    const number = Number(value);
    if (Number.isNaN(number)) {
      return false;
    }
    if (type.minInclusive !== undefined && number < type.minInclusive) {
      return false;
    }
    if (type.maxInclusive !== undefined && number > type.maxInclusive) {
      return false;
    }
    if (type.minExclusive !== undefined && number <= type.minExclusive) {
      return false;
    }
    if (type.maxExclusive !== undefined && number >= type.maxExclusive) {
      return false;
    }
  }
  return true;
}

/** True when the value is valid for the type. */
export function acceptsValue(type: XsdSimpleType, value: string): boolean {
  return acceptsNormalized(type, normalizeValue(value));
}

/** All enumeration values the type admits, across unions, lists and restriction chains, in declaration order. */
export function enumerationsOf(type: XsdSimpleType): XsdEnumeration[] {
  const result: XsdEnumeration[] = [];
  const seen = new Set<string>();
  const visit = (current: XsdSimpleType): void => {
    if (current.enumerations.length > 0) {
      for (const enumeration of current.enumerations) {
        if (!seen.has(enumeration.value)) {
          seen.add(enumeration.value);
          result.push(enumeration);
        }
      }
      // A restriction with its own enumeration narrows the base: the base's values are not offered.
      return;
    }
    if (current.base) {
      visit(current.base);
    }
    for (const member of current.members) {
      visit(member);
    }
    if (current.itemType) {
      visit(current.itemType);
    }
  };
  visit(type);
  return result;
}

const typeNamesCache = new WeakMap<XsdSimpleType, ReadonlySet<string>>();

/**
 * Names of all named types the type is built from: itself, restriction bases, union members and list
 * items. Computed once per type: every expression check asks it for every attribute.
 */
export function typeNamesOf(type: XsdSimpleType): ReadonlySet<string> {
  let cached = typeNamesCache.get(type);
  if (!cached) {
    cached = collectTypeNames(type);
    typeNamesCache.set(type, cached);
  }
  return cached;
}

function collectTypeNames(type: XsdSimpleType): Set<string> {
  const names = new Set<string>();
  const visit = (current: XsdSimpleType): void => {
    if (current.name !== undefined) {
      if (names.has(current.name)) {
        return;
      }
      names.add(current.name);
    }
    if (current.base) {
      visit(current.base);
    }
    for (const member of current.members) {
      visit(member);
    }
    if (current.itemType) {
      visit(current.itemType);
    }
  };
  visit(type);
  return names;
}

/** True when an attribute takes script expressions: a type in its chain has `expression` in its name (`expression`, `lvalueexpression`, `booleanexpression`, ...). */
export function isExpressionAttribute(declared: XsdAttribute | undefined): boolean {
  if (!declared) {
    return false;
  }
  for (const name of typeNamesOf(declared.type)) {
    if (name.includes('expression')) {
      return true;
    }
  }
  return false;
}

/** True when a pattern facet applies somewhere in the type: in it, its restriction bases, union members or list items. */
export function constrainedByPattern(type: XsdSimpleType): boolean {
  if (type.patterns.length > 0) {
    return true;
  }
  if (type.base && constrainedByPattern(type.base)) {
    return true;
  }
  if (type.itemType && constrainedByPattern(type.itemType)) {
    return true;
  }
  return type.members.some(constrainedByPattern);
}

/** True when some part of the type is only constrained by a pattern or not at all, so it takes free text such as an expression. */
export function acceptsFreeText(type: XsdSimpleType): boolean {
  if (type.variety === 'union') {
    return type.members.some(acceptsFreeText);
  }
  if (type.variety === 'list') {
    return type.itemType === undefined || acceptsFreeText(type.itemType);
  }
  if (type.enumerations.length > 0) {
    return false;
  }
  if (type.base) {
    return acceptsFreeText(type.base);
  }
  return type.builtin === 'string' || type.builtin === 'other';
}

/** An element declaration: a global one or one inside a content model. Resolved lazily. */
export class XsdElement {
  readonly name: string;
  readonly location: XsdLocation;
  /** Name of the referenced named type, when the declaration uses `type="..."`. */
  readonly typeName?: string;
  private complexType: ComplexType | null | undefined;
  private model: ContentModel | undefined;
  private documentationText: string | undefined | null;

  constructor(
    private readonly schema: XsdSchema,
    private readonly node: XmlElement
  ) {
    this.name = attributeNamed(node, 'name')?.value ?? '';
    this.location = schema.locationOf(node);
    const typeName = attributeNamed(node, 'type')?.value;
    if (typeName !== undefined) {
      this.typeName = typeName;
    }
  }

  /** Documentation of the declaration, or of its named type when the declaration itself has none. */
  get documentation(): string | undefined {
    if (this.documentationText === undefined) {
      this.documentationText =
        this.schema.documentationOf(this.node) ?? (this.typeName !== undefined ? this.schema.documentationOfType(this.typeName) : undefined) ?? null;
    }
    return this.documentationText ?? undefined;
  }

  private resolved(): ComplexType | null {
    if (this.complexType === undefined) {
      this.complexType = this.schema.complexTypeOfElement(this.node) ?? null;
    }
    return this.complexType;
  }

  /** Attributes the element may carry, by name. */
  get attributes(): ReadonlyMap<string, XsdAttribute> {
    return this.resolved()?.attributes ?? emptyAttributes;
  }

  get contentModel(): ContentModel {
    if (!this.model) {
      this.model = compileContentModel(this.resolved()?.particle);
    }
    return this.model;
  }

  /** Declaration of a child element by name, when the content model allows it anywhere. */
  child(name: string): XsdElement | undefined {
    return this.contentModel.declarations.get(name);
  }
}

const emptyAttributes: ReadonlyMap<string, XsdAttribute> = new Map();

interface ParsedFile {
  path: string;
  text: string;
  /** Entities declared in the file's DOCTYPE; `diff.xsd` writes its patterns with them. */
  entities: ReadonlyMap<string, string>;
}

/**
 * One script schema. Construct it with the schema file and every file it includes; declarations from
 * all files share one namespace, as `xs:include` prescribes.
 */
export class XsdSchema {
  readonly problems: XsdProblem[] = [];
  private readonly fileOfNode = new WeakMap<XmlElement, ParsedFile>();
  private readonly globalElements = new Map<string, XmlElement>();
  /** Every element declaration by name, global or nested, in file order. */
  private readonly elementNodesByName = new Map<string, XmlElement[]>();
  private readonly complexTypeNodes = new Map<string, XmlElement>();
  private readonly simpleTypeNodes = new Map<string, XmlElement>();
  private readonly groupNodes = new Map<string, XmlElement>();
  private readonly attributeGroupNodes = new Map<string, XmlElement>();
  private readonly declarations = new WeakMap<XmlElement, XsdElement>();
  private readonly complexTypes = new WeakMap<XmlElement, ComplexType>();
  private readonly simpleTypes = new WeakMap<XmlElement, XsdSimpleType>();
  private readonly namedSimpleTypes = new Map<string, XsdSimpleType>();
  private readonly attributeGroups = new Map<string, Map<string, XsdAttribute>>();
  private readonly builtinTypes = new Map<string, XsdSimpleType>();
  private readonly anyType: XsdSimpleType = { variety: 'atomic', builtin: 'string', enumerations: [], patterns: [], members: [] };

  constructor(
    readonly name: string,
    /** The schema file and the files it includes, in load order. */
    readonly files: readonly XsdFile[]
  ) {
    for (const file of files) {
      const parsed: ParsedFile = { path: file.path, text: file.text, entities: entitiesOf(file.text) };
      const structure = parseXml(file.text);
      for (const problem of structure.problems) {
        this.problems.push({ file: file.path, message: `${problem.message} at offset ${problem.start}` });
      }
      for (const element of structure.elements) {
        this.fileOfNode.set(element, parsed);
        if (localName(element.name) === 'element') {
          const elementName = attributeNamed(element, 'name')?.value;
          if (elementName !== undefined) {
            const nodes = this.elementNodesByName.get(elementName);
            if (nodes) {
              nodes.push(element);
            } else {
              this.elementNodesByName.set(elementName, [element]);
            }
          }
        }
      }
      const root = structure.roots[0];
      if (!root || localName(root.name) !== 'schema') {
        this.problems.push({ file: file.path, message: 'not an XML Schema document' });
        continue;
      }
      for (const child of root.children) {
        const childName = attributeNamed(child, 'name')?.value;
        if (childName === undefined) {
          continue;
        }
        switch (localName(child.name)) {
          case 'element':
            this.globalElements.set(childName, child);
            break;
          case 'complexType':
            this.complexTypeNodes.set(childName, child);
            break;
          case 'simpleType':
            this.simpleTypeNodes.set(childName, child);
            break;
          case 'group':
            this.groupNodes.set(childName, child);
            break;
          case 'attributeGroup':
            this.attributeGroupNodes.set(childName, child);
            break;
        }
      }
    }
  }

  /** Names of the global elements, the possible document roots. */
  get rootNames(): string[] {
    return [...this.globalElements.keys()];
  }

  /** Declaration of a global element, the document root. */
  root(name: string): XsdElement | undefined {
    const node = this.globalElements.get(name);
    return node ? this.declaration(node) : undefined;
  }

  /**
   * Some declaration of an element with this name, wherever it appears in the schema: the first one in
   * file order. For a document whose structure is broken around an element, it is the best guess for
   * the element's attributes and children while the user is still typing.
   */
  anyDeclaration(name: string): XsdElement | undefined {
    const node = this.elementNodesByName.get(name)?.[0];
    return node ? this.declaration(node) : undefined;
  }

  /** A named simple type, for example `classlookup`, or undefined when the schema has none of that name. */
  simpleType(name: string): XsdSimpleType | undefined {
    return this.simpleTypeNodes.has(name) ? this.resolveSimpleType(name) : undefined;
  }

  /** Names of all named simple types. */
  get simpleTypeNames(): string[] {
    return [...this.simpleTypeNodes.keys()];
  }

  /** @internal */
  locationOf(node: XmlElement): XsdLocation {
    return { file: this.fileOfNode.get(node)?.path ?? '', start: node.start, end: node.startTagEnd };
  }

  /** @internal Documentation of a named complex or simple type. */
  documentationOfType(typeName: string): string | undefined {
    const node = this.complexTypeNodes.get(typeName) ?? this.simpleTypeNodes.get(typeName);
    return node ? this.documentationOf(node) : undefined;
  }

  /** @internal Text of `xs:annotation/xs:documentation` under the node, trimmed line by line. */
  documentationOf(node: XmlElement): string | undefined {
    const annotation = firstChildNamed(node, 'annotation');
    const documentation = annotation && firstChildNamed(annotation, 'documentation');
    const file = documentation && this.fileOfNode.get(documentation);
    if (!documentation || !file || !documentation.endTag) {
      return undefined;
    }
    const raw = file.text.slice(documentation.startTagEnd, documentation.endTag.start);
    const lines = decodeAttributeValue(raw, [])
      .split(/\r?\n/)
      .map((line) => line.trim());
    while (lines.length > 0 && lines[0] === '') {
      lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  /** @internal */
  declaration(node: XmlElement): XsdElement {
    let declaration = this.declarations.get(node);
    if (!declaration) {
      declaration = new XsdElement(this, node);
      this.declarations.set(node, declaration);
    }
    return declaration;
  }

  private problem(node: XmlElement, message: string): void {
    this.problems.push({ file: this.fileOfNode.get(node)?.path ?? '', message: `${message} at offset ${node.start}` });
  }

  /** @internal The complex type of an element declaration: inline, named, or none for simple and empty elements. */
  complexTypeOfElement(node: XmlElement): ComplexType | undefined {
    const inline = firstChildNamed(node, 'complexType');
    if (inline) {
      return this.complexType(inline);
    }
    const typeName = attributeNamed(node, 'type')?.value;
    if (typeName === undefined || isBuiltinReference(typeName) || this.simpleTypeNodes.has(typeName)) {
      return undefined;
    }
    const named = this.complexTypeNodes.get(typeName);
    if (!named) {
      this.problem(node, `unknown type '${typeName}'`);
      return undefined;
    }
    return this.complexType(named);
  }

  private complexType(node: XmlElement): ComplexType {
    let result = this.complexTypes.get(node);
    if (!result) {
      result = { attributes: new Map() };
      // Registered before compiling, so a type that extends itself cannot recurse forever.
      this.complexTypes.set(node, result);
      this.compileComplexType(node, result);
    }
    return result;
  }

  private compileComplexType(node: XmlElement, into: ComplexType): void {
    for (const child of node.children) {
      switch (localName(child.name)) {
        case 'attribute':
          this.addAttribute(child, into.attributes);
          break;
        case 'attributeGroup':
          this.addAttributeGroup(child, into.attributes);
          break;
        case 'sequence':
        case 'choice':
        case 'all':
          into.particle = this.particle(child);
          break;
        case 'group':
          into.particle = this.groupParticle(child);
          break;
        case 'complexContent':
        case 'simpleContent': {
          const derivation = firstChildNamed(child, 'extension', 'restriction');
          if (!derivation) {
            break;
          }
          const baseName = attributeNamed(derivation, 'base')?.value ?? '';
          const baseNode = this.complexTypeNodes.get(baseName);
          const base = baseNode ? this.complexType(baseNode) : undefined;
          if (!base && !isBuiltinReference(baseName) && !this.simpleTypeNodes.has(baseName)) {
            this.problem(derivation, `unknown base type '${baseName}'`);
          }
          const own: ComplexType = { attributes: new Map() };
          this.compileComplexType(derivation, own);
          if (base && localName(derivation.name) === 'extension') {
            for (const [name, attribute] of base.attributes) {
              into.attributes.set(name, attribute);
            }
          }
          for (const [name, attribute] of own.attributes) {
            into.attributes.set(name, attribute);
          }
          if (base && localName(derivation.name) === 'extension' && base.particle && own.particle) {
            into.particle = { kind: 'sequence', particles: [base.particle, own.particle], min: 1, max: 1 };
          } else {
            into.particle = own.particle ?? (localName(derivation.name) === 'extension' ? base?.particle : undefined);
          }
          break;
        }
      }
    }
  }

  private addAttribute(node: XmlElement, into: Map<string, XsdAttribute>): void {
    const name = attributeNamed(node, 'name')?.value;
    if (name === undefined) {
      this.problem(node, 'attribute without name');
      return;
    }
    const typeName = attributeNamed(node, 'type')?.value;
    const inline = firstChildNamed(node, 'simpleType');
    const type = inline ? this.simpleTypeOf(inline) : typeName !== undefined ? this.resolveSimpleType(typeName) : this.anyType;
    const attribute: XsdAttribute = {
      name,
      type,
      required: attributeNamed(node, 'use')?.value === 'required',
      location: this.locationOf(node),
    };
    if (typeName !== undefined) {
      attribute.typeName = typeName;
    }
    const defaultValue = attributeNamed(node, 'default')?.value;
    if (defaultValue !== undefined) {
      attribute.default = defaultValue;
    }
    const documentation = this.documentationOf(node);
    if (documentation !== undefined) {
      attribute.documentation = documentation;
    }
    into.set(name, attribute);
  }

  private addAttributeGroup(reference: XmlElement, into: Map<string, XsdAttribute>): void {
    const name = attributeNamed(reference, 'ref')?.value ?? '';
    let group = this.attributeGroups.get(name);
    if (!group) {
      group = new Map();
      this.attributeGroups.set(name, group);
      const node = this.attributeGroupNodes.get(name);
      if (!node) {
        this.problem(reference, `unknown attribute group '${name}'`);
      } else {
        for (const child of node.children) {
          switch (localName(child.name)) {
            case 'attribute':
              this.addAttribute(child, group);
              break;
            case 'attributeGroup':
              this.addAttributeGroup(child, group);
              break;
          }
        }
      }
    }
    for (const [attributeName, attribute] of group) {
      into.set(attributeName, attribute);
    }
  }

  private particle(node: XmlElement): GroupParticle {
    const kind = localName(node.name) as GroupParticle['kind'];
    const particles: Particle[] = [];
    for (const child of node.children) {
      switch (localName(child.name)) {
        case 'element': {
          const { min, max } = occursOf(child);
          const element: ElementParticle = { kind: 'element', declaration: this.declaration(child), min, max };
          particles.push(element);
          break;
        }
        case 'sequence':
        case 'choice':
        case 'all':
          particles.push(this.particle(child));
          break;
        case 'group':
          particles.push(this.groupParticle(child));
          break;
        case 'any':
          particles.push({ kind: 'any', ...occursOf(child) });
          break;
      }
    }
    return { kind, particles, ...occursOf(node) };
  }

  /** The model group of a named group, with the occurrence of the reference. */
  private groupParticle(reference: XmlElement): GroupParticle {
    const name = attributeNamed(reference, 'ref')?.value ?? '';
    const { min, max } = occursOf(reference);
    const node = this.groupNodes.get(name);
    const model = node && firstChildNamed(node, 'sequence', 'choice', 'all');
    if (!model) {
      this.problem(reference, `unknown group '${name}'`);
      return { kind: 'sequence', particles: [], min, max };
    }
    const inner = this.particle(model);
    // The reference's occurrence wraps the group's model, which may carry its own (`<xs:choice minOccurs="0" maxOccurs="unbounded">`).
    return min === 1 && max === 1 ? inner : { kind: 'sequence', particles: [inner], min, max };
  }

  private builtinType(typeName: string): XsdSimpleType {
    let type = this.builtinTypes.get(typeName);
    if (!type) {
      type = { name: typeName, variety: 'atomic', builtin: builtinOf(typeName), enumerations: [], patterns: [], members: [] };
      this.builtinTypes.set(typeName, type);
    }
    return type;
  }

  private resolveSimpleType(typeName: string): XsdSimpleType {
    if (isBuiltinReference(typeName)) {
      return this.builtinType(typeName);
    }
    let type = this.namedSimpleTypes.get(typeName);
    if (type) {
      return type;
    }
    const node = this.simpleTypeNodes.get(typeName);
    if (!node) {
      this.problems.push({ file: '', message: `unknown simple type '${typeName}'` });
      return this.anyType;
    }
    type = this.simpleTypeOf(node);
    this.namedSimpleTypes.set(typeName, type);
    return type;
  }

  private simpleTypeOf(node: XmlElement): XsdSimpleType {
    let type = this.simpleTypes.get(node);
    if (type) {
      return type;
    }
    type = { variety: 'atomic', builtin: 'string', enumerations: [], patterns: [], members: [], location: this.locationOf(node) };
    const name = attributeNamed(node, 'name')?.value;
    if (name !== undefined) {
      type.name = name;
      // Registered early so a type that refers to itself resolves to this object.
      this.namedSimpleTypes.set(name, type);
    }
    this.simpleTypes.set(node, type);
    const documentation = this.documentationOf(node);
    if (documentation !== undefined) {
      type.documentation = documentation;
    }
    const definition = firstChildNamed(node, 'restriction', 'union', 'list');
    if (!definition) {
      return type;
    }
    switch (localName(definition.name)) {
      case 'restriction':
        this.compileRestriction(definition, type);
        break;
      case 'union': {
        type.variety = 'union';
        const memberTypes = attributeNamed(definition, 'memberTypes')?.value ?? '';
        for (const memberName of memberTypes.split(/\s+/).filter((member) => member.length > 0)) {
          type.members.push(this.resolveSimpleType(memberName));
        }
        for (const inline of childrenNamed(definition, 'simpleType')) {
          type.members.push(this.simpleTypeOf(inline));
        }
        break;
      }
      case 'list': {
        type.variety = 'list';
        const itemTypeName = attributeNamed(definition, 'itemType')?.value;
        const inline = firstChildNamed(definition, 'simpleType');
        if (inline) {
          type.itemType = this.simpleTypeOf(inline);
        } else if (itemTypeName !== undefined) {
          type.itemType = this.resolveSimpleType(itemTypeName);
        }
        break;
      }
    }
    return type;
  }

  /** The `value` of a facet, with the entities of its file expanded as an XML parser would. */
  private valueOf(facet: XmlElement): string | undefined {
    const attribute = attributeNamed(facet, 'value');
    const entities = this.fileOfNode.get(facet)?.entities;
    if (!attribute || !entities || entities.size === 0) {
      return attribute?.value;
    }
    return decodeAttributeValue(expandEntities(attribute.rawValue, entities), []);
  }

  private compileRestriction(restriction: XmlElement, type: XsdSimpleType): void {
    const baseName = attributeNamed(restriction, 'base')?.value;
    const inlineBase = firstChildNamed(restriction, 'simpleType');
    if (inlineBase) {
      type.base = this.simpleTypeOf(inlineBase);
      type.builtin = type.base.builtin;
    } else if (baseName !== undefined && !isBuiltinReference(baseName)) {
      type.base = this.resolveSimpleType(baseName);
      type.builtin = type.base.builtin;
    } else if (baseName !== undefined) {
      type.builtin = builtinOf(baseName);
    }
    for (const facet of restriction.children) {
      const value = this.valueOf(facet);
      if (value === undefined) {
        continue;
      }
      switch (localName(facet.name)) {
        case 'enumeration': {
          const enumeration: XsdEnumeration = { value, location: this.locationOf(facet) };
          const documentation = this.documentationOf(facet);
          if (documentation !== undefined) {
            enumeration.documentation = documentation;
          }
          type.enumerations.push(enumeration);
          break;
        }
        case 'pattern':
          try {
            type.patterns.push(new RegExp(`^(?:${patternSource(value)})$`));
          } catch {
            this.problem(facet, `pattern '${value}' is not a valid regular expression`);
          }
          break;
        case 'minInclusive':
          type.minInclusive = Number(value);
          break;
        case 'maxInclusive':
          type.maxInclusive = Number(value);
          break;
        case 'minExclusive':
          type.minExclusive = Number(value);
          break;
        case 'maxExclusive':
          type.maxExclusive = Number(value);
          break;
      }
    }
  }
}
