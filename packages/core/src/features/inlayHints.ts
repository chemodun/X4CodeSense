/**
 * Inlay hints: after a text reference, the text as the game shows it; after the definition that tells a
 * variable's type, the type. Text references are found in the text, as hover finds them, so they show in
 * any XML and also while it does not parse; variable types come from the variable model of a script.
 */
import { InlayHintKind, type InlayHint, type Range } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { tokenize } from '../expressions/lexer';
import type { GameData } from '../gameData';
import { pageLineReferencesIn, textReferencesIn, type TextDatabase } from '../texts/textDatabase';
import type { VariableOccurrence } from '../variables/variables';
import { attributeNamed } from '../xml/xmlStructure';
import type { TextDisplayOptions } from './texts';
import { variableTypeOrigin } from './variables';

export interface InlayHintOptions extends TextDisplayOptions {
  /** The text after a text reference; on when absent. */
  texts?: boolean;
  /** The type after the definition that tells a variable's type; on when absent. */
  variableTypes?: boolean;
}

/** The longest text label; VS Code shortens labels further (`editor.inlayHints.maximumLength`). */
const maximumTextLength = 100;

/** The text a reference shows, on one line, or undefined when there is none. */
function shownText(texts: TextDatabase, page: number, id: number, language: string): string | undefined {
  const picked = texts.pick(page, id, language);
  const shown = picked && texts.display(picked.text, picked.language).replace(/\s+/g, ' ').trim();
  if (!shown) {
    return undefined;
  }
  return shown.length > maximumTextLength ? `${shown.slice(0, maximumTextLength - 1)}…` : shown;
}

/** True for a value that shows its own type: a lone string or text reference, `[]` or `table[]`. */
function showsItsType(value: string): boolean {
  const kinds = tokenize(value)
    .map((token) => (token.kind === 'identifier' && token.text === 'table' ? 'table' : token.kind))
    .join(' ');
  return kinds === 'string' || kinds === 'lbrace number comma number rbrace' || kinds === 'lbracket rbracket' || kinds === 'table lbracket rbracket';
}

function textHints(analysis: DocumentAnalysis, texts: TextDatabase, start: number, end: number, language: string): InlayHint[] {
  const document = analysis.document;
  const text = document.getText();
  // Whole lines, so a reference the range cuts is found; those that touch the range count.
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const searched = text.slice(from, newline < 0 ? text.length : newline);
  const hints: InlayHint[] = [];
  for (const reference of [...textReferencesIn(searched), ...pageLineReferencesIn(searched)]) {
    if (from + reference.end < start || from + reference.start > end) {
      continue;
    }
    const label = shownText(texts, reference.page, reference.id, language);
    if (label !== undefined) {
      hints.push({ position: document.positionAt(from + reference.end), label, paddingLeft: true });
    }
  }
  return hints;
}

function variableTypeHints(analysis: DocumentAnalysis, start: number, end: number): InlayHint[] {
  const hints: InlayHint[] = [];
  const seen = new Set<VariableOccurrence>();
  for (const table of analysis.variables?.tables ?? []) {
    for (const variable of table.variables.values()) {
      const type = variable.type;
      const definition = type?.definition;
      if (!type || !definition || definition.end < start || definition.start > end || seen.has(definition)) {
        continue;
      }
      seen.add(definition);
      if (type.source === 'param type') {
        continue;
      }
      const value = attributeNamed(definition.element, 'exact') ?? attributeNamed(definition.element, 'default');
      if (type.source === 'value' && value && showsItsType(value.value)) {
        continue;
      }
      hints.push({
        position: analysis.document.positionAt(definition.end),
        label: `: ${type.name}${type.guessed ? '?' : ''}`,
        kind: InlayHintKind.Type,
        tooltip: `Type from <${definition.element.name}>: ${variableTypeOrigin(type)}`,
      });
    }
  }
  return hints;
}

/** The inlay hints of a range of an analysed document, in text order. */
export function inlayHints(analysis: DocumentAnalysis, range: Range, game: GameData | undefined, options: InlayHintOptions = {}): InlayHint[] {
  const document = analysis.document;
  const start = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
  const hints: InlayHint[] = [];
  if (options.texts !== false && game && game.texts.fileCount > 0) {
    hints.push(...textHints(analysis, game.texts, start, end, options.language ?? '44'));
  }
  if (options.variableTypes !== false) {
    hints.push(...variableTypeHints(analysis, start, end));
  }
  return hints.sort((a, b) => a.position.line - b.position.line || a.position.character - b.position.character);
}
