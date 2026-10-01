/**
 * AI script names and order ids in the editor, where a call names one (`run_script name="'move.generic'"`,
 * `create_order id="'Attack'"`) and where `<aiscript name>` or `<order id>` defines one: completion offers
 * the names the index knows, hover tells what a name is, go to definition leads to every definition in
 * load order. Find references is `rename.ts`'s, with the other names other files define.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompletionItemKind, Location, MarkupKind, Range, type CompletionItem, type Hover } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { scriptSchemaOf } from '../analysis/positionContext';
import type { GameData } from '../gameData';
import { scriptNameKindOf, scriptNameOf, type ScriptName, type ScriptNameKind } from '../project/calls';
import { scriptNameTarget } from '../project/callTargets';
import type { IndexedOrder, IndexedPosition, IndexedScript, ScriptIndex } from '../project/scriptIndex';
import { elementWithStartTagAt, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';
import { escapeMarkdown, inlineCode } from './markdown';
import { describePlace, describeReferencesElsewhere } from './project';

/** A definition of an AI script name or order id in the index. */
export interface ScriptNameDefinition {
  /** Where the name is written. */
  position: IndexedPosition;
  script: IndexedScript;
  order?: IndexedOrder;
}

/** Every definition of an AI script name or order id, in load order. */
export function scriptNameDefinitions(index: ScriptIndex, kind: ScriptNameKind, name: string): ScriptNameDefinition[] {
  if (kind === 'script') {
    return index.scripts('aiscripts', name).map((script) => ({ position: script.namePosition ?? script.position, script }));
  }
  return [...new Set(index.orderScripts(name))].flatMap((script) =>
    script.orders.filter((order) => order.id === name).map((order) => ({ position: order.position, script, order }))
  );
}

/** The AI script name or order id under the caret, where it is defined or named literally. */
export function scriptNameAt(analysis: DocumentAnalysis, offset: number): ScriptName | undefined {
  const element = analysis.structure && elementWithStartTagAt(analysis.structure, offset);
  const found = element && scriptNameOf(element, scriptSchemaOf(analysis));
  return found && offset >= found.start && offset <= found.end ? found : undefined;
}

/** A text as the game shows it, a text reference resolved; undefined when empty. */
function shown(text: string | undefined, game: GameData | undefined, language: string | undefined): string | undefined {
  const display = text !== undefined && game && game.texts.fileCount > 0 ? game.texts.display(text, language ?? '44').trim() : text?.trim();
  return display ? display : undefined;
}

/** The heading and what the index says of a definition: an order's name and description, a script's orders. */
function describeDefinition(definition: ScriptNameDefinition, game: GameData | undefined, language: string | undefined): string[] {
  const { script, order } = definition;
  if (!order) {
    const lines = [`**${escapeMarkdown(script.name)}** *(AI script)*`];
    if (script.orders.length > 0) {
      lines.push('', `${script.orders.length === 1 ? 'Order' : 'Orders'} ${script.orders.map((defined) => inlineCode(defined.id)).join(', ')}`);
    }
    return lines;
  }
  const lines = [`**${escapeMarkdown(order.id)}** *(order of ${inlineCode(script.name)})*`];
  const name = shown(order.name, game, language);
  const description = shown(order.description, game, language);
  if (name || description) {
    lines.push('', [name ? `**${escapeMarkdown(name)}**` : undefined, description ? escapeMarkdown(description) : undefined].filter(Boolean).join(': '));
  }
  if (order.category) {
    lines.push('', `Category: ${inlineCode(order.category)}`);
  }
  return lines;
}

/** Hover on an AI script name or order id: what it is, its parameters, every definition, and how often other files name it. */
export function scriptNameHover(analysis: DocumentAnalysis, offset: number, game: GameData | undefined, language?: string): Hover | undefined {
  const found = scriptNameAt(analysis, offset);
  const index = game?.index;
  if (!found || !index) {
    return undefined;
  }
  const definitions = scriptNameDefinitions(index, found.kind, found.name);
  const last = definitions[definitions.length - 1];
  // A definition the index does not have (a document that is no file yet) has nothing to tell.
  if (!last && found.defines) {
    return undefined;
  }
  const lines: string[] = [];
  if (last) {
    lines.push(...describeDefinition(last, game, language));
    // The parameters as a call finds them: the last definition's, from its file as it is now.
    const parameters = [...new Set(scriptNameTarget(analysis, found.kind, found.name, index)?.parameters.map((parameter) => parameter.name) ?? [])];
    lines.push('', parameters.length > 0 ? `Parameters: ${parameters.map(inlineCode).join(', ')}` : 'No parameters');
    lines.push('', ...definitions.map((definition) => `${describePlace(definition.position, definition.script.source)}  `));
    if (definitions.length > 1) {
      lines.push('', `Defined ${definitions.length} times`);
    }
  } else {
    lines.push(`**${escapeMarkdown(found.name)}**`, '', found.kind === 'script' ? 'No AI script of this name is known' : 'No order with this id is known');
  }
  const elsewhere = describeReferencesElsewhere(index.scriptNameReferences(found.kind === 'script' ? 'aiscript' : 'order', found.name), analysis.document.uri);
  if (elsewhere) {
    lines.push('', `Referenced ${elsewhere}`);
  }
  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n').trimEnd() },
    range: Range.create(analysis.document.positionAt(found.start), analysis.document.positionAt(found.end)),
  };
}

/** Go to definition from an AI script name or order id: every definition in load order. */
export function scriptNameDefinitionLocations(analysis: DocumentAnalysis, offset: number, game: GameData | undefined): Location[] | undefined {
  const found = scriptNameAt(analysis, offset);
  const index = game?.index;
  if (!found || !index) {
    return undefined;
  }
  return scriptNameDefinitions(index, found.kind, found.name).map(({ position }) =>
    Location.create(
      pathToFileURL(position.file).toString(),
      Range.create(position.line, position.character, position.line, position.character + found.name.length)
    )
  );
}

/**
 * Completion in an attribute that names an AI script or order (`run_script name`, `create_order id`) while
 * its value is empty or a string being typed: the names the index knows, each inserted with its quotes.
 * `caret` is the text offset of the caret. Undefined for other attributes and for values that are
 * expressions.
 */
export function scriptNameCompletions(
  analysis: DocumentAnalysis,
  element: XmlElement,
  attribute: XmlAttribute,
  caret: number,
  game: GameData | undefined,
  language?: string
): CompletionItem[] | undefined {
  const kind = scriptNameKindOf(element, attribute.name, scriptSchemaOf(analysis));
  const index = game?.index;
  if (!kind || !index || !/^\s*(?:'[^'$%{}[\]]*'?\s*)?$/.test(attribute.value)) {
    return undefined;
  }
  const document = analysis.document;
  const range = Range.create(document.positionAt(attribute.valueStart), document.positionAt(Math.max(attribute.valueEnd, caret)));
  const items: CompletionItem[] = [];
  for (const name of kind === 'script' ? index.scriptNames('aiscripts') : index.orderIds()) {
    const definitions = scriptNameDefinitions(index, kind, name);
    const last = definitions[definitions.length - 1];
    if (name === '' || !last) {
      continue;
    }
    const lines = describeDefinition(last, game, language);
    if (!last.order) {
      lines.push('', last.script.params.length > 0 ? `Parameters: ${last.script.params.map(inlineCode).join(', ')}` : 'No parameters');
    }
    lines.push('', describePlace(last.position, last.script.source));
    const orderName = last.order && shown(last.order.name, game, language);
    items.push({
      label: name,
      kind: kind === 'script' ? CompletionItemKind.Module : CompletionItemKind.Function,
      detail: last.order ? `${orderName ? `${orderName} · ` : ''}${last.script.name}` : `${path.basename(last.script.file)} (${last.script.source})`,
      documentation: { kind: MarkupKind.Markdown, value: lines.join('\n') },
      // Before keywords and variables, which an empty value offers too.
      sortText: `0${name}`,
      filterText: `'${name}'`,
      textEdit: { range, newText: `'${name}'` },
    });
  }
  return items;
}
