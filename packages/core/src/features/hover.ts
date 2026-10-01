import { Range, type Hover } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { positionContext, schemaOf, scriptSchemaOf } from '../analysis/positionContext';
import { isInsideString, tokenize } from '../expressions/lexer';
import { chainAtToken, resolveChain, type ResolvedStep } from '../expressions/propertyChain';
import type { GameData } from '../gameData';
import { offsetInValue, type XmlAttribute } from '../xml/xmlStructure';
import { enumerationsOf, isExpressionAttribute, type XsdAttribute } from '../xsd/schema';
import { describeAttribute, describeCandidates, describeElement, describeKeyword, describeProperty, escapeMarkdown } from './markdown';
import { mdReferenceAt } from '../project/mdReferences';
import { textReferenceAt } from '../texts/textDatabase';
import { describeMdReference } from './project';
import { describeNamedItem, namedItemAt } from './namedItems';
import { hoverInPatch, patchedViewAt } from './patchContent';
import { pathHoverAt } from './patchPaths';
import { describeText, type TextDisplayOptions } from './texts';
import { describeVariable, variableAt } from './variables';
import { callParameterHover } from './callParameters';

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
  // Several properties that fit: all of them, `mayattack.{$component}` and `mayattack.{$faction}`.
  if (step.candidates && step.candidates.length > 1) {
    return describeCandidates(step.candidates);
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
  const schema = scriptSchemaOf(analysis);
  if (!properties || !schema || !isExpressionAttribute(declared)) {
    return undefined;
  }
  if (isInsideString(tokenize(value), index)) {
    return undefined;
  }
  const md = game?.index ? mdReferenceAt(attribute.element, attribute, offsetInValue(attribute, index)) : undefined;
  if (game?.index && md) {
    const reference = md.reference;
    const [start, end] = md.part === 'script' ? [reference.scriptStart, reference.scriptEnd] : [reference.cueStart ?? 0, reference.cueEnd ?? 0];
    return hover(analysis, describeMdReference(game.index, reference, md.part, analysis.document.uri), start, end);
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
export function hoverAt(analysis: DocumentAnalysis, offset: number, game: GameData | undefined, options: TextDisplayOptions = {}): Hover | undefined {
  // A text reference, in any XML document, also while it does not parse.
  const reference = game && game.texts.fileCount > 0 ? textReferenceAt(analysis.document.getText(), offset) : undefined;
  if (game && reference) {
    return hover(analysis, describeText(game.texts, reference.page, reference.id, options), reference.start, reference.end);
  }
  // In what a patch brings in: as it is where it lands.
  const view = patchedViewAt(analysis, offset);
  if (view) {
    const found = hoverAt(view.analysis, view.offset, game, options);
    return found && hoverInPatch(view, found);
  }
  const inPath = game ? pathHoverAt(analysis, offset, game) : undefined;
  if (inPath) {
    return inPath;
  }
  const variable = variableAt(analysis, offset);
  if (variable) {
    return hover(
      analysis,
      describeVariable(variable.variable, analysis.document, game?.index, analysis.origin),
      variable.occurrence.start,
      variable.occurrence.end
    );
  }
  const named = namedItemAt(analysis, offset);
  if (named) {
    return hover(analysis, describeNamedItem(named, analysis.document, game?.index, analysis.detection.script?.name, analysis.origin), named.start, named.end);
  }
  // A parameter a call passes to a script, order or library of another file (those of the same file are variables).
  const parameter = callParameterHover(analysis, offset, game, options.language);
  if (parameter) {
    return parameter;
  }
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
