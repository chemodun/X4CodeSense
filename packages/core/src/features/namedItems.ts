import type { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, Location, Range, type CompletionItem } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { itemNoun } from '../names/validateNames';
import type { DocumentNames, NamedItemKind, NamedOccurrence } from '../names/namedItems';
import type { IndexedLibraryItem, ScriptIndex } from '../project/scriptIndex';
import { attributeNamed, type XmlElement } from '../xml/xmlStructure';
import { describeLines, escapeMarkdown, inlineCode, type DocumentOrigin } from './markdown';
import { describeLibraryDefinitions, describeReferencesElsewhere, indexedLocation } from './project';

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
    facts.push(`Namespace ${inlineCode(namespace)}`);
  }
  const ref = value('ref');
  if (ref) {
    facts.push(`Instance of ${inlineCode(ref)}`);
  }
  const purpose = value('purpose');
  if (purpose) {
    facts.push(`Purpose ${inlineCode(purpose)}`);
  }
  const params = element.children
    .find((child) => child.name === 'params')
    ?.children.filter((child) => child.name === 'param')
    .map((param) => attributeNamed(param, 'name')?.value)
    .filter((name): name is string => name !== undefined && name !== '');
  if (params && params.length > 0) {
    facts.push(`Parameters: ${params.map(inlineCode).join(', ')}`);
  }
  return facts;
}

/** How often other files name a cue of the script or an interrupt library item, for the hover; empty when none do or it cannot be told. */
function referencesElsewhere(occurrence: NamedOccurrence, document: TextDocument, index: ScriptIndex | undefined, scriptName: string | undefined): string {
  if (!index || occurrence.kind === 'label' || occurrence.external) {
    return '';
  }
  if (occurrence.kind === 'cue') {
    const defined = occurrence.items.some((item) => item.definitions.length > 0);
    return defined && scriptName ? describeReferencesElsewhere(index.cueReferences(scriptName, occurrence.name), document.uri) : '';
  }
  return describeReferencesElsewhere(index.libraryReferences(occurrence.kind, occurrence.name), document.uri);
}

/**
 * Hover text for a label, cue, library or interrupt library item; `scriptName` is the name of the
 * document's script, `origin` where the document's text was written when that is elsewhere.
 */
export function describeNamedItem(
  occurrence: NamedOccurrence,
  document: TextDocument,
  index?: ScriptIndex,
  scriptName?: string,
  origin?: DocumentOrigin
): string {
  const elsewhere = otherScriptDefinitions(occurrence, index);
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
    facts.push(min === undefined ? 'In an attention block' : `In the attention block for ${inlineCode(min)}`);
  }
  if (facts.length > 0) {
    lines.push('', facts.join(' · '));
  }
  let where: string;
  if (definitions.length > 0) {
    where = `Defined at ${describeLines(
      document,
      definitions.map((definition) => definition.start),
      origin
    )}`;
    if (occurrence.kind === 'label' && defined.length > 1) {
      where += ` in ${defined.length} attention blocks`;
    }
  } else if (occurrence.external) {
    where = occurrence.kind === 'label' ? 'Resolved in the script that uses this interrupt library' : 'Resolved in the script that includes this library';
  } else if (occurrence.kind === 'label' || occurrence.kind === 'cue') {
    where = 'Not defined in this script';
  } else if (index) {
    where = elsewhere.length > 0 ? 'Defined in another script' : 'Not defined in any known script';
  } else {
    where = 'Defined in another script';
  }
  const references = new Set(occurrence.items.flatMap((item) => item.references)).size;
  const inOtherFiles = referencesElsewhere(occurrence, document, index, scriptName);
  lines.push('', `${where} · Referenced ${references} time${references === 1 ? '' : 's'} here${inOtherFiles ? `, ${inOtherFiles}` : ''}`);
  if (index && elsewhere.length > 0) {
    lines.push('', describeLibraryDefinitions(index, elsewhere));
  }
  return lines.join('\n');
}

/** Interrupt library items that other scripts define, for a reference this script does not define. */
function otherScriptDefinitions(occurrence: NamedOccurrence, index: ScriptIndex | undefined): IndexedLibraryItem[] {
  if (!index || occurrence.kind === 'label' || occurrence.kind === 'cue' || occurrence.items.some((item) => item.definitions.length > 0)) {
    return [];
  }
  return index.libraryItems(occurrence.kind, occurrence.name);
}

/** The named item occurrence under a caret. */
export function namedItemAt(analysis: DocumentAnalysis, offset: number): NamedOccurrence | undefined {
  return analysis.names?.occurrenceAt(offset);
}

/** Where the items an occurrence defines or names are defined: in the document, else, for interrupt library items, in other scripts. */
export function namedItemDefinitions(occurrence: NamedOccurrence, document: TextDocument, index?: ScriptIndex): Location[] {
  const here = occurrence.items.flatMap((item) => item.definitions).map((definition) => Location.create(document.uri, rangeOf(document, definition)));
  return here.length > 0 ? here : otherScriptDefinitions(occurrence, index).map((item) => indexedLocation(item.position));
}

const completionKinds: Record<NamedItemKind, CompletionItemKind> = {
  label: CompletionItemKind.Reference,
  cue: CompletionItemKind.Event,
  actions: CompletionItemKind.Function,
  handler: CompletionItemKind.Function,
  conditions: CompletionItemKind.Function,
};

/**
 * Completion items for the items of a kind that a reference written in the element may name: those of
 * the document, and for interrupt library items also those other scripts define.
 */
export function namedItemCompletionItems(
  names: DocumentNames,
  kind: NamedItemKind,
  element: XmlElement,
  document: TextDocument,
  range: Range,
  prefix: string,
  index?: ScriptIndex,
  origin?: DocumentOrigin
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
      documentation: { kind: 'markdown', value: describeNamedItem(definition, document, undefined, undefined, origin) },
      textEdit: { range, newText: item.name },
    });
  }
  if (index && kind !== 'label' && kind !== 'cue') {
    for (const name of index.libraryItemNames(kind)) {
      if (seen.has(name) || !name.startsWith(prefix)) {
        continue;
      }
      seen.add(name);
      const definitions = index.libraryItems(kind, name);
      items.push({
        label: name,
        kind: completionKinds[kind],
        detail: `${itemNoun({ kind }).toLowerCase()} of ${definitions[0]?.script ?? 'another script'}`,
        documentation: { kind: 'markdown', value: describeLibraryDefinitions(index, definitions) },
        textEdit: { range, newText: name },
      });
    }
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}
