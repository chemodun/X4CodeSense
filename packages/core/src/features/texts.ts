import { pathToFileURL } from 'node:url';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, Location, Range, type CompletionItem } from 'vscode-languageserver-types';
import { missingTextMessage } from '../texts/validateTexts';
import type { GameText, TextDatabase } from '../texts/textDatabase';
import { escapeMarkdown } from './markdown';

/** How texts are shown: which language first, and whether the others are shown at all. */
export interface TextDisplayOptions {
  /** Preferred language id; `44` (English) when absent. */
  language?: string;
  /** Show only the preferred language, or the one the game would fall back to. */
  limitLanguage?: boolean;
}

function languageName(texts: TextDatabase, language: string): string {
  return texts.languageNames.get(language) ?? (language === '*' ? 'Any language' : `Language ${language}`);
}

/** Markdown for a shown text: escaped, with its line breaks kept. */
function markdownText(text: string): string {
  return escapeMarkdown(text).replace(/\n/g, '  \n');
}

/** The definitions to show for a text: the one the game picks for the preferred language, or the last one of every language. */
function shownTexts(texts: TextDatabase, page: number, id: number, options: TextDisplayOptions): GameText[] {
  const preferred = options.language ?? '44';
  if (options.limitLanguage) {
    const picked = texts.pick(page, id, preferred);
    return picked ? [picked] : [];
  }
  return texts.languagesOf(page, id, preferred).map((language) => texts.pick(page, id, language) as GameText);
}

/** Hover text for `{page, id}`: the text in the shown languages as the game shows it, and how it is written when that differs. */
export function describeText(texts: TextDatabase, page: number, id: number, options: TextDisplayOptions = {}): string {
  const title = texts.page(page)?.title;
  const heading = `**{${page}, ${id}}**${title ? ` · page *${escapeMarkdown(title)}*` : ''}`;
  const missing = missingTextMessage(texts, page, id);
  if (missing) {
    return `${heading}\n\n${missing}`;
  }
  const shown = shownTexts(texts, page, id, options);
  const lines = [heading, ''];
  for (const text of shown) {
    const display = texts.display(text.text, text.language);
    lines.push(
      `${shown.length > 1 || text.language !== (options.language ?? '44') ? `*${escapeMarkdown(languageName(texts, text.language))}:* ` : ''}${markdownText(display)}  `
    );
  }
  const first = shown[0];
  if (first && texts.display(first.text, first.language) !== first.text) {
    lines.push('', `Written as: ${markdownText(first.text)}`);
  }
  return lines.join('\n').trimEnd();
}

/** Where a text is defined: every definition in the language the game picks for the preferred one. */
export function textDefinitions(texts: TextDatabase, page: number, id: number, options: TextDisplayOptions = {}): Location[] {
  const picked = texts.pick(page, id, options.language ?? '44');
  if (!picked) {
    return [];
  }
  return texts
    .texts(page, id)
    .filter((text) => text.language === picked.language)
    .map((text) => Location.create(pathToFileURL(text.file).toString(), Range.create(text.line, text.character, text.line, text.character)));
}

/** A shown text on one line, shortened for a completion detail. */
function summary(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Completion items for the page of a text reference. */
export function textPageCompletionItems(texts: TextDatabase, range: Range, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const page of texts.pages()) {
    const label = String(page.id);
    if (!label.startsWith(prefix)) {
      continue;
    }
    const item: CompletionItem = { label, kind: CompletionItemKind.Folder, sortText: label.padStart(12, '0'), textEdit: { range, newText: label } };
    if (page.title) {
      item.detail = page.title;
    }
    if (page.description) {
      item.documentation = page.description;
    }
    items.push(item);
  }
  return items;
}

/**
 * Completion of a text reference in XML that is no script (wares, macros, the libraries, the text files):
 * pages after `{`, ids after `{page,`, and in `page="…" line="…"` the page and the line. Looked for on
 * the caret's line, as hover does, so it works whatever the document's structure; undefined elsewhere.
 */
export function textReferenceCompletions(
  document: TextDocument,
  offset: number,
  texts: TextDatabase,
  options: TextDisplayOptions = {}
): CompletionItem[] | undefined {
  const text = document.getText();
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', offset);
  const before = text.slice(lineStart, offset);
  const after = text.slice(offset, lineEnd < 0 ? text.length : lineEnd);
  // The digits after the caret are replaced as well.
  const digitsAfter = /^\d*/.exec(after)?.[0].length ?? 0;
  const range = (typed: string): Range => Range.create(document.positionAt(offset - typed.length), document.positionAt(offset + digitsAfter));
  const id = /\{\s*(\d+)\s*,\s*(\d*)$/.exec(before);
  if (id) {
    return textIdCompletionItems(texts, Number(id[1]), range(id[2]), id[2], options);
  }
  // Not after a dot: `$x.{…}` is a lookup.
  const page = /\{\s*(\d*)$/.exec(before);
  if (page && !/\.\s*$/.test(before.slice(0, page.index))) {
    return textPageCompletionItems(texts, range(page[1]), page[1]);
  }
  const line = /\bline\s*=\s*"(\d*)$/.exec(before);
  const linePage = line && /\bpage\s*=\s*"(\d+)"/.exec(before.slice(0, line.index));
  if (line && linePage) {
    return textIdCompletionItems(texts, Number(linePage[1]), range(line[1]), line[1], options);
  }
  // A page attribute only next to a line attribute: `page` alone may mean anything.
  const pageAttribute = /\bpage\s*=\s*"(\d*)$/.exec(before);
  if (pageAttribute && /^\d*"\s+line\s*=/.test(after)) {
    return textPageCompletionItems(texts, range(pageAttribute[1]), pageAttribute[1]);
  }
  return undefined;
}

/** Completion items for the text ids of a page, with the text as the game shows it. */
export function textIdCompletionItems(texts: TextDatabase, page: number, range: Range, prefix: string, options: TextDisplayOptions = {}): CompletionItem[] {
  const items: CompletionItem[] = [];
  const preferred = options.language ?? '44';
  for (const id of texts.ids(page)) {
    const label = String(id);
    if (!label.startsWith(prefix)) {
      continue;
    }
    const picked = texts.pick(page, id, preferred);
    const item: CompletionItem = { label, kind: CompletionItemKind.Text, sortText: label.padStart(12, '0'), textEdit: { range, newText: label } };
    if (picked) {
      item.detail = summary(texts.display(picked.text, picked.language));
    }
    items.push(item);
  }
  return items;
}
