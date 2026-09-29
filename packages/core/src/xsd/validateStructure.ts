import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { XmlAttribute, XmlElement, XmlStructure } from '../xml/xmlStructure';
import type { ContentProblem } from './contentModel';
import { acceptsFreeText, acceptsValue, constrainedByPattern, enumerationsOf, type XsdAttribute, type XsdElement, type XsdSchema } from './schema';

export interface StructureValidationOptions {
  /** Check the order and completeness of child elements, not only their names. */
  checkContent: boolean;
  /** `source` of the produced diagnostics. */
  source: string;
  /** Attributes whose values the caller checks itself, so their type's facets are not applied. */
  checkedElsewhere?: (declared: XsdAttribute) => boolean;
  /** Check only the attributes and children of the elements for which this holds; declarations are found for all. */
  checkElement?: (element: XmlElement) => boolean;
}

export interface StructureValidation {
  diagnostics: Diagnostic[];
  /** The schema declaration of every element that could be resolved. */
  declarations: Map<XmlElement, XsdElement>;
}

export type StructureDiagnosticCode =
  | 'unknown-root-element'
  | 'unknown-element'
  | 'invalid-child-element'
  | 'missing-child-element'
  | 'unknown-attribute'
  | 'missing-required-attribute'
  | 'invalid-attribute-value';

const listedNames = 8;

function listOf(names: readonly string[]): string {
  if (names.length === 0) {
    return 'nothing';
  }
  const shown = names.slice(0, listedNames).map((name) => `'${name}'`);
  return names.length > listedNames ? `${shown.join(', ')} and ${names.length - listedNames} more` : shown.join(', ');
}

/** True for the namespace declarations and schema instance attributes that no schema declares. */
export function isInfrastructureAttribute(name: string): boolean {
  return name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('xsi:');
}

function describeExpected(attribute: XsdAttribute): string {
  const values = enumerationsOf(attribute.type).map((enumeration) => enumeration.value);
  if (values.length > 0) {
    const list = attribute.type.variety === 'list' ? `a list of ${listOf(values)}` : `one of ${listOf(values)}`;
    return acceptsFreeText(attribute.type) ? `${list} or an expression` : list;
  }
  if (attribute.typeName !== undefined) {
    return `a value of type '${attribute.typeName}'`;
  }
  if (constrainedByPattern(attribute.type)) {
    return 'an expression';
  }
  return attribute.type.builtin === 'string' || attribute.type.builtin === 'other' ? 'text' : `a ${attribute.type.builtin}`;
}

class Validator {
  readonly diagnostics: Diagnostic[] = [];
  readonly declarations = new Map<XmlElement, XsdElement>();

  constructor(
    private readonly document: TextDocument,
    private readonly options: StructureValidationOptions
  ) {}

  private report(code: StructureDiagnosticCode, message: string, start: number, end: number): void {
    this.diagnostics.push({
      range: Range.create(this.document.positionAt(start), this.document.positionAt(end)),
      message,
      severity: DiagnosticSeverity.Error,
      code,
      source: this.options.source,
    });
  }

  validate(structure: XmlStructure, schema: XsdSchema, rootName: string): void {
    const root = structure.roots[0];
    if (!root) {
      return;
    }
    for (const extra of structure.roots.slice(1)) {
      this.report('unknown-root-element', `Unexpected root element '${extra.name}': the document already has a root`, extra.nameStart, extra.nameEnd);
    }
    const rootDeclaration = schema.root(rootName);
    if (!rootDeclaration) {
      return;
    }
    if (root.name !== rootName) {
      this.report('unknown-root-element', `Root element must be '${rootName}'`, root.nameStart, root.nameEnd);
      return;
    }
    this.declarations.set(root, rootDeclaration);
    const pending: XmlElement[] = [root];
    while (pending.length > 0) {
      const element = pending.pop() as XmlElement;
      const declaration = this.declarations.get(element) as XsdElement;
      const checked = this.options.checkElement?.(element) ?? true;
      if (checked) {
        this.validateAttributes(element, declaration);
      }
      this.validateChildren(element, declaration, checked);
      for (const child of element.children) {
        if (this.declarations.has(child)) {
          pending.push(child);
        }
      }
    }
  }

  private validateAttributes(element: XmlElement, declaration: XsdElement): void {
    const allowed = declaration.attributes;
    const present = new Set<string>();
    for (const attribute of element.attributes) {
      if (isInfrastructureAttribute(attribute.name)) {
        continue;
      }
      present.add(attribute.name);
      const declared = allowed.get(attribute.name);
      if (!declared) {
        this.report('unknown-attribute', `Unknown attribute '${attribute.name}' in '${element.name}'`, attribute.nameStart, attribute.nameEnd);
        continue;
      }
      this.validateValue(element, attribute, declared);
    }
    for (const [name, declared] of allowed) {
      if (declared.required && !present.has(name)) {
        this.report('missing-required-attribute', `Missing required attribute '${name}' in '${element.name}'`, element.nameStart, element.nameEnd);
      }
    }
  }

  private validateValue(element: XmlElement, attribute: XmlAttribute, declared: XsdAttribute): void {
    if (attribute.quote === '' || this.options.checkedElsewhere?.(declared) || acceptsValue(declared.type, attribute.value)) {
      return;
    }
    const shown = attribute.value.length > 40 ? `${attribute.value.slice(0, 37)}...` : attribute.value;
    this.report(
      'invalid-attribute-value',
      `Invalid value '${shown}' for attribute '${attribute.name}' in '${element.name}'. Expected ${describeExpected(declared)}`,
      attribute.valueStart,
      attribute.valueEnd
    );
  }

  private validateChildren(element: XmlElement, declaration: XsdElement, checked: boolean): void {
    const model = declaration.contentModel;
    for (const child of element.children) {
      const childDeclaration = model.declarations.get(child.name);
      if (childDeclaration) {
        this.declarations.set(child, childDeclaration);
      }
    }
    if (!checked) {
      return;
    }
    // Children a wildcard allows get no declaration: the schema says nothing about them.
    const problems: ContentProblem[] = this.options.checkContent
      ? model.validate(element.children.map((child) => child.name))
      : element.children.flatMap((child, index) => (model.declarations.has(child.name) || model.wildcard ? [] : [{ index, expected: [] }]));
    for (const problem of problems) {
      const child = element.children[problem.index];
      if (!child) {
        this.report(
          'missing-child-element',
          `Element '${element.name}' is missing a required child. Expected ${listOf(problem.expected)}`,
          element.nameStart,
          element.nameEnd
        );
      } else if (!model.declarations.has(child.name) && !model.wildcard) {
        const message =
          model.declarations.size === 0
            ? `Element '${element.name}' does not allow child elements, found '${child.name}'`
            : `Unknown element '${child.name}' in '${element.name}'`;
        this.report('unknown-element', message, child.nameStart, child.nameEnd);
      } else {
        const previous = problem.index > 0 ? ` after '${element.children[problem.index - 1].name}'` : ' as first child';
        this.report(
          'invalid-child-element',
          `Element '${child.name}' is not allowed${previous} in '${element.name}'. Expected ${listOf(problem.expected)}`,
          child.nameStart,
          child.nameEnd
        );
      }
    }
  }
}

/** Validates the elements and attributes of a script document against its schema. */
export function validateStructure(
  structure: XmlStructure,
  schema: XsdSchema,
  rootName: string,
  document: TextDocument,
  options: StructureValidationOptions
): StructureValidation {
  const validator = new Validator(document, options);
  validator.validate(structure, schema, rootName);
  validator.diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return { diagnostics: validator.diagnostics, declarations: validator.declarations };
}
