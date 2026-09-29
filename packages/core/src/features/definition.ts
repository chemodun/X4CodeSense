import type { Location } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { positionContext, schemaOf, scriptSchemaOf } from '../analysis/positionContext';
import { isInsideString, tokenize } from '../expressions/lexer';
import { chainAtToken, resolveChain } from '../expressions/propertyChain';
import type { GameData } from '../gameData';
import type { SourceLocation } from '../sourceLocation';
import { offsetInValue, type XmlAttribute } from '../xml/xmlStructure';
import { enumerationsOf, isExpressionAttribute, type XsdAttribute } from '../xsd/schema';
import { mdReferenceAt } from '../project/mdReferences';
import { textReferenceAt } from '../texts/textDatabase';
import { namedItemAt, namedItemDefinitions } from './namedItems';
import { locationsInFiles, patchedViewAt } from './patchContent';
import { pathDefinitionsAt } from './patchPaths';
import { mdReferenceDefinitions } from './project';
import { textDefinitions, type TextDisplayOptions } from './texts';
import { variableAt, variableDefinitions } from './variables';

function locations(game: GameData, sources: (SourceLocation | undefined)[]): Location[] {
  const result: Location[] = [];
  for (const source of sources) {
    const location = source && game.locationOf(source);
    if (location) {
      result.push(location);
    }
  }
  return result;
}

function definitionInValue(analysis: DocumentAnalysis, attribute: XmlAttribute, declared: XsdAttribute | undefined, index: number, game: GameData): Location[] {
  if (!declared) {
    return [];
  }
  const value = attribute.value;
  const enumeration = enumerationsOf(declared.type).find((candidate) => candidate.value === value.trim());
  if (enumeration) {
    return locations(game, [enumeration.location]);
  }
  const properties = game.properties;
  const schema = scriptSchemaOf(analysis);
  if (!properties || !schema || !isExpressionAttribute(declared) || isInsideString(tokenize(value), index)) {
    return [];
  }
  const md = game.index ? mdReferenceAt(attribute.element, attribute, offsetInValue(attribute, index)) : undefined;
  if (game.index && md) {
    return mdReferenceDefinitions(game.index, md.reference, md.part);
  }
  const found = chainAtToken(value, index);
  if (!found) {
    return [];
  }
  const step = resolveChain(found.chain, properties, schema).steps[found.stepIndex];
  if (step.keyword) {
    return locations(game, [step.keyword.location]);
  }
  if (step.property) {
    return locations(game, [step.property.location]);
  }
  return locations(
    game,
    (step.candidates ?? []).map((candidate) => candidate.location)
  );
}

/** Where the thing at an offset is declared in the game data: an element or attribute in a schema, a keyword or property in scriptproperties.xml, an enumeration value. */
export function definitionAt(analysis: DocumentAnalysis, offset: number, game: GameData | undefined, options: TextDisplayOptions = {}): Location[] {
  const reference = game && game.texts.fileCount > 0 ? textReferenceAt(analysis.document.getText(), offset) : undefined;
  if (game && reference) {
    return textDefinitions(game.texts, reference.page, reference.id, options);
  }
  // In what a patch brings in: as it is where it lands, found in the files the target is written in.
  const view = patchedViewAt(analysis, offset);
  if (view) {
    return locationsInFiles(view, definitionAt(view.analysis, view.offset, game, options));
  }
  const inPath = game ? pathDefinitionsAt(analysis, offset, game) : undefined;
  if (inPath) {
    return inPath;
  }
  const variable = variableAt(analysis, offset);
  if (variable) {
    return variableDefinitions(variable.variable, analysis.document, game?.index);
  }
  const named = namedItemAt(analysis, offset);
  if (named) {
    return namedItemDefinitions(named, analysis.document, game?.index);
  }
  if (!game) {
    return [];
  }
  const context = positionContext(analysis, offset, schemaOf(game, analysis));
  switch (context.kind) {
    case 'element-name':
      return locations(game, [context.declaration?.location]);
    case 'end-tag-name':
      return locations(game, [context.declaration?.location]);
    case 'attribute-name':
      return locations(game, [context.declaration?.attributes.get(context.attribute.name)?.location]);
    case 'attribute-value':
      return definitionInValue(analysis, context.attribute, context.declared, context.index, game);
    default:
      return [];
  }
}
