/**
 * References to Mission Director scripts and their cues in expressions: `md.<Script>` and
 * `md.<Script>.<Cue>`, followed by anything (`.$x`, `.state`, …). `md.$x` is a variable of the `md`
 * table, not a script. Found in the parsed expression tree, so a reference inside a string is none.
 */
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { parsedValue } from '../expressions/attributeExpression';
import { walkExpression, type Expression } from '../expressions/parser';
import { offsetInValue, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';
import { isExpressionAttribute, type XsdSchema } from '../xsd/schema';

export interface MdReference {
  element: XmlElement;
  attribute: XmlAttribute;
  script: string;
  /** Text offsets of the script name. */
  scriptStart: number;
  scriptEnd: number;
  /** The cue name, when one follows the script name. */
  cue?: string;
  cueStart?: number;
  cueEnd?: number;
  /** True under `@` or tested with `?`: a missing cue does not fail there. */
  guarded: boolean;
}

/** Nodes where a missing name does not fail: everything under `@`, and what `?` tests. */
function guardedNodes(expression: Expression): Set<Expression> {
  const guarded = new Set<Expression>();
  walkExpression(expression, (node) => {
    if (node.kind === 'unary' && node.operator === '@') {
      walkExpression(node.operand, (inner) => guarded.add(inner));
    } else if (node.kind === 'exists') {
      walkExpression(node.operand, (inner) => guarded.add(inner));
    }
  });
  return guarded;
}

/** The `md.<Script>[.<Cue>]` references of one attribute value. */
export function mdReferencesInAttribute(element: XmlElement, attribute: XmlAttribute): MdReference[] {
  const references = new Map<object, MdReference>();
  const whole = parsedValue(attribute).expression;
  let guarded: Set<Expression> | undefined;
  const isGuarded = (node: Expression): boolean => (guarded ??= guardedNodes(whole)).has(node);
  walkExpression(whole, (node) => {
    if (node.kind !== 'property' || node.name === '' || node.name.startsWith('$')) {
      return;
    }
    const object = node.object;
    if (object.kind === 'name' && object.name === 'md') {
      if (!references.has(node)) {
        references.set(node, {
          element,
          attribute,
          script: node.name,
          scriptStart: offsetInValue(attribute, node.nameStart),
          scriptEnd: offsetInValue(attribute, node.nameEnd),
          guarded: isGuarded(node),
        });
      }
      return;
    }
    if (object.kind === 'property' && object.object.kind === 'name' && object.object.name === 'md' && object.name !== '' && !object.name.startsWith('$')) {
      references.set(object, {
        element,
        attribute,
        script: object.name,
        scriptStart: offsetInValue(attribute, object.nameStart),
        scriptEnd: offsetInValue(attribute, object.nameEnd),
        cue: node.name,
        cueStart: offsetInValue(attribute, node.nameStart),
        cueEnd: offsetInValue(attribute, node.nameEnd),
        guarded: isGuarded(node),
      });
    }
  });
  return [...references.values()].sort((a, b) => a.scriptStart - b.scriptStart);
}

/** Every `md.<Script>[.<Cue>]` reference in the expression attributes of an analysed script. */
export function mdReferencesOf(analysis: DocumentAnalysis, xsd: XsdSchema | undefined): MdReference[] {
  const references: MdReference[] = [];
  for (const element of analysis.structure?.elements ?? []) {
    const declaration = analysis.declarations.get(element) ?? xsd?.anyDeclaration(element.name);
    if (!declaration) {
      continue;
    }
    for (const attribute of element.attributes) {
      if (attribute.quote === '' || !attribute.value.includes('md.') || !isExpressionAttribute(declaration.attributes.get(attribute.name))) {
        continue;
      }
      references.push(...mdReferencesInAttribute(element, attribute));
    }
  }
  return references;
}

/** The reference and the part of it under a caret at a text offset in an attribute. */
export function mdReferenceAt(element: XmlElement, attribute: XmlAttribute, offset: number): { reference: MdReference; part: 'script' | 'cue' } | undefined {
  if (!attribute.value.includes('md.')) {
    return undefined;
  }
  for (const reference of mdReferencesInAttribute(element, attribute)) {
    if (offset >= reference.scriptStart && offset <= reference.scriptEnd) {
      return { reference, part: 'script' };
    }
    if (reference.cueStart !== undefined && reference.cueEnd !== undefined && offset >= reference.cueStart && offset <= reference.cueEnd) {
      return { reference, part: 'cue' };
    }
  }
  return undefined;
}
