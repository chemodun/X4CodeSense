/**
 * The parameters of calls in the editor: completion offers what the target declares in `<param name="…">`,
 * hover and go to definition lead from a passed name to its declaration, and signature help shows the
 * target's parameters while the caret is in the call. What a call calls is `project/callTargets`.
 */
import * as path from 'node:path';
import {
  CompletionItemKind,
  MarkupKind,
  Range,
  type CompletionItem,
  type Hover,
  type Location,
  type ParameterInformation,
  type SignatureHelp,
} from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { scriptSchemaOf } from '../analysis/positionContext';
import type { GameData } from '../gameData';
import { callOf, callTarget, callTargetLabel, isCall, valueRange, type CallTarget, type ParameterDeclaration } from '../project/callTargets';
import { attributeNamed, elementAt, elementWithStartTagAt, type XmlElement } from '../xml/xmlStructure';
import { escapeMarkdown, inlineCode } from './markdown';
import { patchedViewAt } from './patchContent';

/** The longest default a signature's label shows; longer ones show as `…`. */
const shortDefault = 16;

const nameOf = (element: XmlElement): string | undefined => attributeNamed(element, 'name')?.value.trim();

/** How a call target is named in a sentence: "order `Attack` of `order.fight.attack.object`". */
export function describeCallTarget(target: CallTarget): string {
  return callTargetLabel(target, inlineCode);
}

/** A parameter's description: an order parameter's `text`, a text reference shown as the game shows it, else its `comment`. */
function descriptionOf(parameter: ParameterDeclaration, game: GameData | undefined, language: string | undefined): string | undefined {
  if (parameter.text !== undefined && game && game.texts.fileCount > 0) {
    return game.texts.display(parameter.text, language ?? '44').trim();
  }
  return parameter.text ?? parameter.comment;
}

/** Markdown for a declared parameter: its description, default, type and where it is declared. */
export function describeParameter(parameter: ParameterDeclaration, target: CallTarget, game?: GameData, language?: string): string {
  const lines = [`**${escapeMarkdown(parameter.name)}** *(parameter of ${describeCallTarget(target)})*`];
  const description = descriptionOf(parameter, game, language);
  if (description) {
    lines.push('', escapeMarkdown(description));
  }
  const facts = [
    parameter.default !== undefined ? `Default: ${inlineCode(parameter.default)}` : 'No default',
    ...(parameter.type ? [`Type: ${inlineCode(parameter.type)}`] : []),
    ...(parameter.required ? [`Required: ${inlineCode(parameter.required)}`] : []),
  ];
  lines.push('', facts.join(' · '));
  lines.push(
    '',
    `In ${escapeMarkdown(path.basename(target.file))}${target.source ? ` of ${inlineCode(target.source)}` : ''}, line ${parameter.location.range.start.line + 1}`
  );
  return lines.join('\n');
}

/** The call parameter whose name holds the offset, with what its call calls. */
export function callParameterAt(
  analysis: DocumentAnalysis,
  offset: number,
  game: GameData | undefined
): { target: CallTarget; name: string; declared?: ParameterDeclaration; start: number; end: number } | undefined {
  const structure = analysis.structure;
  const param = structure && elementWithStartTagAt(structure, offset);
  const attribute = param && attributeNamed(param, 'name');
  if (!param || !attribute || attribute.quote === '' || offset < attribute.valueStart || offset > attribute.valueEnd) {
    return undefined;
  }
  const call = callOf(param, scriptSchemaOf(analysis));
  const target = call && callTarget(analysis, call, game?.index);
  if (!target) {
    return undefined;
  }
  const name = attribute.value.trim();
  const declared = target.parameters.find((parameter) => parameter.name === name);
  const { start, end } = valueRange(attribute);
  return { target, name, ...(declared ? { declared } : {}), start, end };
}

/** Hover on the name of a parameter a call passes: its declaration, or the parameters there are. */
export function callParameterHover(analysis: DocumentAnalysis, offset: number, game: GameData | undefined, language?: string): Hover | undefined {
  const found = callParameterAt(analysis, offset, game);
  if (!found || found.name === '') {
    return undefined;
  }
  const value = found.declared
    ? describeParameter(found.declared, found.target, game, language)
    : [
        `**${escapeMarkdown(found.name)}** is no parameter of ${describeCallTarget(found.target)}.`,
        '',
        found.target.parameters.length > 0
          ? `Its parameters: ${found.target.parameters.map((parameter) => inlineCode(parameter.name)).join(', ')}`
          : 'It has no parameters.',
      ].join('\n');
  return {
    contents: { kind: MarkupKind.Markdown, value },
    range: Range.create(analysis.document.positionAt(found.start), analysis.document.positionAt(found.end)),
  };
}

/** Go to definition from the name of a parameter a call passes: where its target declares it. */
export function callParameterDefinitions(analysis: DocumentAnalysis, offset: number, game: GameData | undefined): Location[] | undefined {
  const found = callParameterAt(analysis, offset, game);
  return found?.declared ? [found.declared.location] : undefined;
}

/**
 * Completion of `<param name="…">` in a call: the parameters its target declares and the call does not
 * pass yet, those without a default first, in their order. `range` is what an item replaces.
 */
export function callParameterCompletions(
  analysis: DocumentAnalysis,
  param: XmlElement,
  game: GameData | undefined,
  range: Range,
  language?: string
): CompletionItem[] | undefined {
  const call = callOf(param, scriptSchemaOf(analysis));
  const target = call && callTarget(analysis, call, game?.index);
  if (!call || !target) {
    return undefined;
  }
  const passed = new Set(call.children.filter((child) => child !== param && child.name === 'param').map(nameOf));
  return target.parameters
    .filter((parameter) => !passed.has(parameter.name))
    .map((parameter, position) => {
      const item: CompletionItem = {
        label: parameter.name,
        kind: CompletionItemKind.Variable,
        detail: parameter.default !== undefined ? `= ${parameter.default}` : 'no default',
        documentation: { kind: MarkupKind.Markdown, value: describeParameter(parameter, target, game, language) },
        sortText: `${parameter.default === undefined ? 0 : 1}${String(position).padStart(4, '0')}`,
        textEdit: { range, newText: parameter.name },
      };
      return item;
    });
}

/**
 * Signature help in a call: its target with its parameters, the one under the caret active, or the first
 * the call does not pass yet.
 */
export function callSignatureHelp(analysis: DocumentAnalysis, offset: number, game: GameData | undefined, language?: string): SignatureHelp | undefined {
  const view = patchedViewAt(analysis, offset);
  if (view) {
    return callSignatureHelp(view.analysis, view.offset, game, language);
  }
  const structure = analysis.structure;
  // A start tag cut off by the end of the text still holds the caret after it.
  const element = structure && (elementWithStartTagAt(structure, offset) ?? elementAt(structure, offset));
  if (!element) {
    return undefined;
  }
  const schema = scriptSchemaOf(analysis);
  const call = callOf(element, schema) ?? (isCall(element, schema) ? element : undefined);
  const target = call && callTarget(analysis, call, game?.index);
  if (!call || !target) {
    return undefined;
  }
  const parameters: ParameterInformation[] = [];
  let label = `${target.name}(`;
  for (const [position, parameter] of target.parameters.entries()) {
    if (position > 0) {
      label += ', ';
    }
    const start = label.length;
    // Orders have defaults written as long expressions: the label shows short ones, each parameter's documentation all.
    const shown = parameter.default === undefined ? '' : parameter.default.length <= shortDefault ? ` = ${parameter.default}` : ' = …';
    label += `${parameter.name}${shown}`;
    const description = descriptionOf(parameter, game, language);
    const facts = [
      ...(description ? [escapeMarkdown(description)] : []),
      ...(parameter.default !== undefined ? [`Default: ${inlineCode(parameter.default)}`] : []),
      ...(parameter.type ? [`Type: ${inlineCode(parameter.type)}`] : []),
    ];
    parameters.push({
      label: [start, start + parameter.name.length],
      ...(facts.length > 0 ? { documentation: { kind: MarkupKind.Markdown, value: facts.join('\n\n') } } : {}),
    });
  }
  label += ')';
  const current = element === call ? undefined : nameOf(element);
  const passed = new Set(call.children.filter((child) => child.name === 'param').map(nameOf));
  let active = current === undefined ? -1 : target.parameters.findIndex((parameter) => parameter.name === current);
  if (active < 0) {
    active = target.parameters.findIndex((parameter) => !passed.has(parameter.name));
  }
  return {
    signatures: [{ label, documentation: { kind: MarkupKind.Markdown, value: `Parameters of ${describeCallTarget(target)}` }, parameters }],
    activeSignature: 0,
    activeParameter: Math.max(0, active),
  };
}
