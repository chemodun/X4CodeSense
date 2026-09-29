import type { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, Location, Range, type CompletionItem } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { itemNoun } from '../names/validateNames';
import type { DocumentNames, NamedItemKind, NamedOccurrence } from '../names/namedItems';
import { attributeNamed, type XmlElement } from '../xml/xmlStructure';
import { escapeMarkdown } from './markdown';

function lineOf(document: TextDocument, offset: number): number {
  return document.positionAt(offset).line + 1;
}

function rangeOf(document: TextDocument, occurrence: NamedOccurrence): Range {
  return Range.create(document.positionAt(occurrence.start), document.positionAt(occurrence.end));
}

/** Facts a cue or library definition states about itself. */
function cueFacts(element: XmlElement): string[] {
  const facts: string[] = [];
  const value = (name: string): string | undefined => attributeNamed(element, name)?.value;
  if (value('instantiate') === 'true') {
    facts.push('Instantiated');
  }
  const namespace = value('namespace');
  if (namespace) {
    facts.push(`Namespace \`${escapeMarkdown(namespace)}\``);
  }
  const ref = value('ref');
  if (ref) {
    facts.push(`Instance of \`${escapeMarkdown(ref)}\``);
  }
  const purpose = value('purpose');
  if (purpose) {
    facts.push(`Purpose \`${escapeMarkdown(purpose)}\``);
  }
  const params = element.children
    .find((child) => child.name === 'params')
    ?.children.filter((child) => child.name === 'param')
    .map((param) => attributeNamed(param, 'name')?.value)
    .filter((name): name is string => name !== undefined && name !== '');
  if (params && params.length > 0) {
    facts.push(`Parameters: ${params.map((name) => `\`${escapeMarkdown(name)}\``).join(', ')}`);
  }
  return facts;
}

/** Hover text for a label, cue, library or interrupt library item. */
export function describeNamedItem(occurrence: NamedOccurrence, document: TextDocument): string {
  const defined = occurrence.items.filter((item) => item.definitions.length > 0);
  const definitions = defined.flatMap((item) => item.definitions);
  const first = definitions[0];
  const lines = [`**${escapeMarkdown(occurrence.name)}** *(${itemNoun(occurrence.items[0], first).toLowerCase()})*`];
  const facts: string[] = [];
  if (first && occurrence.kind === 'cue') {
    facts.push(...cueFacts(first.element));
  }
  if (occurrence.kind === 'label' && defined.length === 1 && defined[0].owner) {
    const min = attributeNamed(defined[0].owner, 'min')?.value;
    facts.push(min === undefined ? 'In an attention block' : `In the attention block for \`${escapeMarkdown(min)}\``);
  }
  if (facts.length > 0) {
    lines.push('', facts.join(' · '));
  }
  let where: string;
  if (definitions.length > 0) {
    const at = definitions.map((definition) => lineOf(document, definition.start));
    where = `Defined at line${at.length === 1 ? '' : 's'} ${at.join(', ')}`;
    if (occurrence.kind === 'label' && defined.length > 1) {
      where += ` in ${defined.length} attention blocks`;
    }
  } else if (occurrence.external) {
    where = occurrence.kind === 'label' ? 'Resolved in the script that uses this interrupt library' : 'Resolved in the script that includes this library';
  } else if (occurrence.kind === 'label' || occurrence.kind === 'cue') {
    where = 'Not defined in this script';
  } else {
    where = 'Defined in another script';
  }
  const references = new Set(occurrence.items.flatMap((item) => item.references)).size;
  lines.push('', `${where} · Referenced ${references} time${references === 1 ? '' : 's'}`);
  return lines.join('\n');
}

/** The named item occurrence under a caret. */
export function namedItemAt(analysis: DocumentAnalysis, offset: number): NamedOccurrence | undefined {
  return analysis.names?.occurrenceAt(offset);
}

/** Where the items an occurrence defines or names are defined in the document. */
export function namedItemDefinitions(occurrence: NamedOccurrence, document: TextDocument): Location[] {
  return occurrence.items.flatMap((item) => item.definitions).map((definition) => Location.create(document.uri, rangeOf(document, definition)));
}

const completionKinds: Record<NamedItemKind, CompletionItemKind> = {
  label: CompletionItemKind.Reference,
  cue: CompletionItemKind.Event,
  actions: CompletionItemKind.Function,
  handler: CompletionItemKind.Function,
  conditions: CompletionItemKind.Function,
};

/** Completion items for the items of a kind that a reference written in the element may name. */
export function namedItemCompletionItems(
  names: DocumentNames,
  kind: NamedItemKind,
  element: XmlElement,
  document: TextDocument,
  range: Range,
  prefix: string
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const item of names.visible(kind, element)) {
    if (seen.has(item.name) || !item.name.startsWith(prefix)) {
      continue;
    }
    seen.add(item.name);
    const definition = item.definitions[0];
    items.push({
      label: item.name,
      kind: completionKinds[kind],
      detail: itemNoun(item, definition).toLowerCase(),
      documentation: { kind: 'markdown', value: describeNamedItem(definition, document) },
      textEdit: { range, newText: item.name },
    });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}
