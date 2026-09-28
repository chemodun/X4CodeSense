import { Range, type Hover } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { positionContext, schemaOf } from '../analysis/positionContext';
import { isInsideString, tokenize } from '../expressions/lexer';
import { chainAtToken, resolveChain, type ResolvedStep } from '../expressions/propertyChain';
import type { GameData } from '../gameData';
import { offsetInValue, type XmlAttribute } from '../xml/xmlStructure';
import { enumerationsOf, isExpressionAttribute, type XsdAttribute } from '../xsd/schema';
import { describeAttribute, describeCandidates, describeElement, describeKeyword, describeProperty, escapeMarkdown } from './markdown';

function hover(analysis: DocumentAnalysis, value: string, start: number, end: number): Hover {
  return {
    contents: { kind: 'markdown', value },
    range: Range.create(analysis.document.positionAt(start), analysis.document.positionAt(end)),
  };
}

/** Markdown for a resolved chain step, or undefined when nothing is known about it. */
export function describeStep(step: ResolvedStep): string | undefined {
  if (step.keyword) {
    return describeKeyword(step.keyword);
  }
  if (step.property) {
    return describeProperty(step.property);
  }
  if (step.candidates && step.candidates.length > 0) {
    return describeCandidates(step.candidates);
  }
  return undefined;
}

function hoverInValue(
  analysis: DocumentAnalysis,
  attribute: XmlAttribute,
  declared: XsdAttribute | undefined,
  index: number,
  game: GameData | undefined
): Hover | undefined {
  if (!declared) {
    return undefined;
  }
  const value = attribute.value;
  const enumeration = enumerationsOf(declared.type).find((candidate) => candidate.value === value.trim());
  if (enumeration) {
    const lines = [`**${escapeMarkdown(enumeration.value)}**`];
    if (enumeration.documentation) {
      lines.push('', escapeMarkdown(enumeration.documentation));
    }
    return hover(analysis, lines.join('\n'), attribute.valueStart, attribute.valueEnd);
  }
  const properties = game?.properties;
  const schema = analysis.detection.script?.schema;
  if (!properties || !schema || !isExpressionAttribute(declared)) {
    return undefined;
  }
  if (isInsideString(tokenize(value), index)) {
    return undefined;
  }
  const found = chainAtToken(value, index);
  if (!found) {
    return undefined;
  }
  const resolved = resolveChain(found.chain, properties, schema);
  const step = resolved.steps[found.stepIndex];
  const text = describeStep(step);
  if (text === undefined) {
    return undefined;
  }
  return hover(analysis, text, offsetInValue(attribute, step.step.start), offsetInValue(attribute, step.step.end));
}

/** Hover information for an offset in an analysed document. */
export function hoverAt(analysis: DocumentAnalysis, offset: number, game: GameData | undefined): Hover | undefined {
  const context = positionContext(analysis, offset, schemaOf(game, analysis));
  switch (context.kind) {
    case 'element-name': {
      const declaration = context.declaration;
      return declaration && context.element ? hover(analysis, describeElement(declaration), context.element.nameStart, context.element.nameEnd) : undefined;
    }
    case 'end-tag-name': {
      const endTag = context.element.endTag;
      return context.declaration && endTag ? hover(analysis, describeElement(context.declaration), endTag.nameStart, endTag.nameEnd) : undefined;
    }
    case 'attribute-name': {
      const declared = context.declaration?.attributes.get(context.attribute.name);
      return declared ? hover(analysis, describeAttribute(declared, context.element.name), context.attribute.nameStart, context.attribute.nameEnd) : undefined;
    }
    case 'attribute-value':
      return hoverInValue(analysis, context.attribute, context.declared, context.index, game);
    default:
      return undefined;
  }
}
