import type { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, Location, Range, type CompletionItem, type TextEdit } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { XmlElement } from '../xml/xmlStructure';
import type { DocumentVariables, ScriptVariable, VariableOccurrence, VariableTable } from '../variables/variables';
import { escapeMarkdown } from './markdown';

function describeTable(table: VariableTable): string {
  switch (table.kind) {
    case 'script':
      return 'this script';
    case 'global':
      return 'the global table';
    case 'remote':
      return `\`${escapeMarkdown(table.name)}\``;
    default:
      return `${table.kind} \`${escapeMarkdown(table.name)}\``;
  }
}

/** Hover text for a variable. */
export function describeVariable(variable: ScriptVariable, document: TextDocument): string {
  const lines = [`**$${escapeMarkdown(variable.name)}** *(variable of ${describeTable(variable.table)})*`];
  const facts: string[] = [];
  if (variable.types.size > 0) {
    facts.push(`Type: ${[...variable.types].map((type) => `\`${type}\``).join(', ')}`);
  }
  const definitions = variable.definitions.length;
  const references = variable.references.length;
  facts.push(definitions === 0 ? 'Never set here' : `Set ${definitions} time${definitions === 1 ? '' : 's'}`);
  facts.push(`Read ${references} time${references === 1 ? '' : 's'}`);
  lines.push('', facts.join(' · '));
  if (definitions > 0) {
    const first = variable.definitions[0];
    lines.push('', `First set in \\<${escapeMarkdown(first.element.name)}\\> at line ${document.positionAt(first.start).line + 1}`);
  }
  return lines.join('\n');
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

/** Where the variable is set. */
export function variableDefinitions(variable: ScriptVariable, document: TextDocument): Location[] {
  return variable.definitions.map((occurrence) => Location.create(document.uri, rangeOf(document, occurrence)));
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

/** Completion items for the variables of a table and the tables linked to it, labelled with `$`. */
export function variableCompletionItems(
  variables: DocumentVariables,
  table: VariableTable,
  document: TextDocument,
  range: Range,
  prefix: string
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
        documentation: { kind: 'markdown', value: describeVariable(variable, document) },
        textEdit: { range, newText: label },
      };
      if (variable.types.size > 0) {
        item.detail = [...variable.types].join(' | ');
      }
      items.push(item);
    }
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

/** The table variables written as `$name` inside an element belong to. */
export function tableAt(analysis: DocumentAnalysis, element: XmlElement): VariableTable | undefined {
  return analysis.variables?.tableOf(element);
}

/** All occurrences of the variable under the caret, or nothing when the caret is not on a variable. */
export function referencesAt(analysis: DocumentAnalysis, offset: number): Location[] {
  const found = variableAt(analysis, offset);
  return found ? variableReferences(found.variable, analysis.document) : [];
}

/** The range of the variable under the caret and its current name, for a rename prompt. */
export function prepareRenameAt(analysis: DocumentAnalysis, offset: number): { range: Range; placeholder: string } | undefined {
  const found = variableAt(analysis, offset);
  if (!found) {
    return undefined;
  }
  const written = analysis.document.getText().slice(found.occurrence.start, found.occurrence.end);
  return { range: rangeOf(analysis.document, found.occurrence), placeholder: written };
}

/** Edits that rename the variable under the caret, or nothing when the caret is not on a variable. */
export function renameAt(analysis: DocumentAnalysis, offset: number, newName: string): TextEdit[] {
  const found = variableAt(analysis, offset);
  return found ? renameVariable(found.variable, newName, analysis.document) : [];
}
