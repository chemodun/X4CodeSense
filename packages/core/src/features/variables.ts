import * as path from 'node:path';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, Location, Range, type CompletionItem, type TextEdit } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { ScriptIndex } from '../project/scriptIndex';
import type { XmlElement } from '../xml/xmlStructure';
import type { DocumentVariables, ElsewhereDefinition, ScriptVariable, VariableOccurrence, VariableTable } from '../variables/variables';
import { describeLines, escapeMarkdown, inlineCode, type DocumentOrigin } from './markdown';
import { indexedLocation } from './project';

function describeTable(table: VariableTable): string {
  switch (table.kind) {
    case 'script':
      return 'this script';
    case 'global':
      return 'the global table';
    case 'remote':
      return inlineCode(table.name);
    default:
      return `${table.kind} ${inlineCode(table.name)}`;
  }
}

/** The script and cue of a remote table written `md.<Script>.<Cue>`. */
export function remoteCueOf(table: VariableTable): { script: string; cue: string } | undefined {
  const match = table.kind === 'remote' ? /^md\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(table.name) : null;
  return match ? { script: match[1], cue: match[2] } : undefined;
}

/** Where other files set the variable: interrupt library items the script uses, or the cue of another script it names. */
function definitionsElsewhere(variable: ScriptVariable, index: ScriptIndex | undefined): ElsewhereDefinition[] {
  const found = [...variable.elsewhere];
  const remote = remoteCueOf(variable.table);
  if (index && remote) {
    for (const set of index.cueVariables(remote.script, remote.cue)) {
      if (set.name === variable.name) {
        found.push({ position: set.position, via: `cue ${remote.cue} of ${remote.script}` });
      }
    }
  }
  return found;
}

/**
 * Hover text for a variable; with the script index, also where other files set it. `origin` tells where
 * the document's text was written when that is elsewhere.
 */
export function describeVariable(variable: ScriptVariable, document: TextDocument, index?: ScriptIndex, origin?: DocumentOrigin): string {
  const lines = [`**$${escapeMarkdown(variable.name)}** *(variable of ${describeTable(variable.table)})*`];
  const facts: string[] = [];
  if (variable.types.size > 0) {
    facts.push(`Type: ${[...variable.types].map(inlineCode).join(', ')}`);
  }
  const elsewhere = definitionsElsewhere(variable, index);
  const definitions = variable.definitions.length;
  const references = variable.references.length;
  facts.push(definitions > 0 ? `Set ${definitions} time${definitions === 1 ? '' : 's'}` : elsewhere.length > 0 ? 'Set in another file' : 'Never set here');
  facts.push(`Read ${references} time${references === 1 ? '' : 's'}`);
  lines.push('', facts.join(' · '));
  if (definitions > 0) {
    const first = variable.definitions[0];
    lines.push('', `First set in \\<${escapeMarkdown(first.element.name)}\\> at ${describeLines(document, [first.start], origin)}`);
  }
  if (elsewhere.length > 0) {
    lines.push('');
    for (const definition of elsewhere.slice(0, 5)) {
      lines.push(
        `Set by ${escapeMarkdown(definition.via)} in ${escapeMarkdown(path.basename(definition.position.file))}, line ${definition.position.line + 1}  `
      );
    }
    if (elsewhere.length > 5) {
      lines.push(`and in ${elsewhere.length - 5} more places`);
    }
  }
  return lines.join('\n').trimEnd();
}

/** The variable under a caret, when the caret is on an occurrence. */
export function variableAt(analysis: DocumentAnalysis, offset: number): { variable: ScriptVariable; occurrence: VariableOccurrence } | undefined {
  const variables = analysis.variables;
  const occurrence = variables?.occurrenceAt(offset);
  return variables && occurrence ? { variable: variables.variableOf(occurrence), occurrence } : undefined;
}

function rangeOf(document: TextDocument, occurrence: VariableOccurrence): Range {
  return Range.create(document.positionAt(occurrence.start), document.positionAt(occurrence.end));
}

/** Where the variable is set: in the document, then, with the script index, in other files. */
export function variableDefinitions(variable: ScriptVariable, document: TextDocument, index?: ScriptIndex): Location[] {
  return [
    ...variable.definitions.map((occurrence) => Location.create(document.uri, rangeOf(document, occurrence))),
    ...definitionsElsewhere(variable, index).map((definition) => indexedLocation(definition.position)),
  ];
}

/** Every occurrence of the variable: definitions, reads and removals, in text order. */
export function variableOccurrences(variable: ScriptVariable): VariableOccurrence[] {
  return [...variable.definitions, ...variable.references, ...variable.removals].sort((a, b) => a.start - b.start);
}

/** All places the variable is written or read, as locations. */
export function variableReferences(variable: ScriptVariable, document: TextDocument): Location[] {
  return variableOccurrences(variable).map((occurrence) => Location.create(document.uri, rangeOf(document, occurrence)));
}

/** Edits that rename every occurrence of the variable in its table. `newName` may start with `$`. */
export function renameVariable(variable: ScriptVariable, newName: string, document: TextDocument): TextEdit[] {
  const name = newName.replace(/^\$/, '');
  return variableOccurrences(variable).map((occurrence) => {
    const written = document.getText().slice(occurrence.start, occurrence.end);
    return { range: rangeOf(document, occurrence), newText: written.startsWith('$') ? `$${name}` : name };
  });
}

/**
 * Completion items for the variables of a table and the tables linked to it, labelled with `$`. With
 * the script index, those that library items of other files set are among them, and for
 * `md.<Script>.<Cue>.$` the variables that cue sets in its own script.
 */
export function variableCompletionItems(
  variables: DocumentVariables,
  table: VariableTable,
  document: TextDocument,
  range: Range,
  prefix: string,
  index?: ScriptIndex,
  origin?: DocumentOrigin
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const tables = [table, ...table.links];
  for (const source of tables) {
    for (const variable of source.variables.values()) {
      const label = `$${variable.name}`;
      if (seen.has(label) || !label.startsWith(prefix) || (!variables.isDefined(variable) && variable.references.length <= 1)) {
        continue;
      }
      seen.add(label);
      const item: CompletionItem = {
        label,
        kind: CompletionItemKind.Variable,
        documentation: { kind: 'markdown', value: describeVariable(variable, document, index, origin) },
        textEdit: { range, newText: label },
      };
      if (variable.types.size > 0) {
        item.detail = [...variable.types].join(' | ');
      }
      items.push(item);
    }
  }
  const remote = remoteCueOf(table);
  if (index && remote) {
    for (const set of index.cueVariables(remote.script, remote.cue)) {
      const label = `$${set.name}`;
      if (seen.has(label) || !label.startsWith(prefix)) {
        continue;
      }
      seen.add(label);
      items.push({
        label,
        kind: CompletionItemKind.Variable,
        detail: `cue ${remote.cue} of ${remote.script}`,
        documentation: { kind: 'markdown', value: `Set in ${escapeMarkdown(path.basename(set.position.file))}, line ${set.position.line + 1}` },
        textEdit: { range, newText: label },
      });
    }
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

/** The table variables written as `$name` inside an element belong to. */
export function tableAt(analysis: DocumentAnalysis, element: XmlElement): VariableTable | undefined {
  return analysis.variables?.tableOf(element);
}
