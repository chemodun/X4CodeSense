/**
 * Signature help for the arguments of a format: `'%s of %s'.[$a, $b]`, and `{page, id}.[…]` whose text is
 * the format. The label is the format, its placeholders (see `expressions/formats.ts`) the parameters,
 * so the editor marks the one of the argument at the caret.
 */
import { MarkupKind, type ParameterInformation, type SignatureHelp } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { positionContext, schemaOf } from '../analysis/positionContext';
import { formatPlaceholders } from '../expressions/formats';
import { parseExpression, walkExpression, type Expression } from '../expressions/parser';
import type { GameData } from '../gameData';
import { isExpressionAttribute } from '../xsd/schema';
import { patchedViewAt } from './patchContent';
import type { TextDisplayOptions } from './texts';

type ArgsNode = Extract<Expression, { kind: 'args' }>;

/** The arguments of a format the caret is in, innermost first found last, and where their `[` is. */
function formatCallAt(expression: string, index: number): { node: ArgsNode; open: number } | undefined {
  let found: { node: ArgsNode; open: number } | undefined;
  walkExpression(parseExpression(expression).expression, (node) => {
    if (node.kind !== 'args' || (node.object.kind !== 'string' && node.object.kind !== 'textref')) {
      return;
    }
    const open = expression.indexOf('[', node.object.end);
    const closed = expression[node.end - 1] === ']';
    if (open >= 0 && index > open && (!closed || index < node.end)) {
      found = { node, open };
    }
  });
  return found;
}

/** The argument the caret is in: the commas before it at the top level of the brackets. */
function activeArgument(expression: string, open: number, index: number): number {
  let depth = 0;
  let commas = 0;
  let quote: string | undefined;
  for (let at = open + 1; at < index; at++) {
    const character = expression[at];
    if (quote) {
      quote = character === quote ? undefined : quote;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if ('([{'.includes(character)) {
      depth++;
    } else if (')]}'.includes(character)) {
      depth--;
    } else if (character === ',' && depth === 0) {
      commas++;
    }
  }
  return commas;
}

/** The format text of the object of the arguments, with what the label shows before and after it; undefined when it is not known. */
function formatOf(object: Expression, game: GameData | undefined, options: TextDisplayOptions): { prefix: string; format: string; suffix: string } | undefined {
  if (object.kind === 'string') {
    const quote = object.text[0];
    return { prefix: quote, format: object.text.slice(1, object.unterminated ? undefined : -1), suffix: object.unterminated ? '' : quote };
  }
  if (object.kind === 'textref' && object.page.kind === 'number' && object.id.kind === 'number' && game) {
    const page = Number(object.page.text);
    const id = Number(object.id.text);
    const language = options.language ?? '44';
    const picked = game.texts.pick(page, id, language);
    if (!picked) {
      return undefined;
    }
    const shown = game.texts.display(picked.text, picked.language).replace(/\s+/g, ' ');
    return { prefix: `{${page}, ${id}}: `, format: shown, suffix: '' };
  }
  return undefined;
}

/** Signature help in the arguments of a format; undefined anywhere else. */
export function formatSignatureHelp(
  analysis: DocumentAnalysis,
  offset: number,
  game: GameData | undefined,
  options: TextDisplayOptions = {}
): SignatureHelp | undefined {
  const view = patchedViewAt(analysis, offset);
  if (view) {
    return formatSignatureHelp(view.analysis, view.offset, game, options);
  }
  const context = positionContext(analysis, offset, schemaOf(game, analysis));
  if (context.kind !== 'attribute-value' || !isExpressionAttribute(context.declared)) {
    return undefined;
  }
  const call = formatCallAt(context.expression, context.index);
  const format = call && formatOf(call.node.object, game, options);
  if (!call || !format) {
    return undefined;
  }
  const placeholders = formatPlaceholders(format.format);
  const count = placeholders.reduce((most, placeholder) => Math.max(most, placeholder.argument + 1), 0);
  const label = `${format.prefix}${format.format}${format.suffix}`;
  const parameters: ParameterInformation[] = [];
  for (let argument = 0; argument < count; argument++) {
    const written = placeholders.filter((placeholder) => placeholder.argument === argument);
    const first = written[0];
    parameters.push({
      label: first ? [format.prefix.length + first.start, format.prefix.length + first.end] : [0, 0],
      documentation: {
        kind: MarkupKind.Markdown,
        value: `Argument ${argument + 1}${written.length > 1 ? `, written ${written.length} times` : written.length === 0 ? ', not used by the format' : ''}`,
      },
    });
  }
  const active = activeArgument(context.expression, call.open, context.index);
  const documentation =
    count === 0
      ? 'The format takes no argument.'
      : `The format takes ${count} argument${count === 1 ? '' : 's'}${active >= count ? `; this is argument ${active + 1}, which it does not use` : ''}.`;
  return {
    signatures: [{ label, documentation: { kind: MarkupKind.Markdown, value: documentation }, parameters }],
    activeSignature: 0,
    activeParameter: active,
  };
}
