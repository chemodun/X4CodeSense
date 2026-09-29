import { Location, Range, type TextEdit } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { relatedOccurrences } from '../names/namedItems';
import { namedItemAt } from './namedItems';
import { renameVariable, variableAt, variableReferences } from './variables';

function rangeOf(analysis: DocumentAnalysis, occurrence: { start: number; end: number }): Range {
  return Range.create(analysis.document.positionAt(occurrence.start), analysis.document.positionAt(occurrence.end));
}

/** All occurrences of the variable or named item under the caret, or nothing elsewhere. */
export function referencesAt(analysis: DocumentAnalysis, offset: number): Location[] {
  const variable = variableAt(analysis, offset);
  if (variable) {
    return variableReferences(variable.variable, analysis.document);
  }
  const named = namedItemAt(analysis, offset);
  return named ? relatedOccurrences(named).map((occurrence) => Location.create(analysis.document.uri, rangeOf(analysis, occurrence))) : [];
}

/** The range and current text of the variable or named item under the caret, for a rename prompt. */
export function prepareRenameAt(analysis: DocumentAnalysis, offset: number): { range: Range; placeholder: string } | undefined {
  const found = variableAt(analysis, offset)?.occurrence ?? namedItemAt(analysis, offset);
  if (!found) {
    return undefined;
  }
  return { range: rangeOf(analysis, found), placeholder: analysis.document.getText().slice(found.start, found.end) };
}

/**
 * Edits that rename the variable or named item under the caret everywhere in the document, or nothing
 * elsewhere. A label named by a handler for several attention blocks renames all of them together, so
 * the handler keeps finding each.
 */
export function renameAt(analysis: DocumentAnalysis, offset: number, newName: string): TextEdit[] {
  const variable = variableAt(analysis, offset);
  if (variable) {
    return renameVariable(variable.variable, newName, analysis.document);
  }
  const named = namedItemAt(analysis, offset);
  const name = newName.trim();
  if (!named || name === '') {
    return [];
  }
  return relatedOccurrences(named).map((occurrence) => ({ range: rangeOf(analysis, occurrence), newText: name }));
}
