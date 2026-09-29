import { pathToFileURL } from 'node:url';
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
