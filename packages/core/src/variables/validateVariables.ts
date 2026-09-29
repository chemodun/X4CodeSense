import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { XmlElement } from '../xml/xmlStructure';
import type { DocumentVariables } from './variables';

export type VariableDiagnosticCode = 'variable-undefined';

/** True inside a `<patch>` block, whose actions run on saved games where older script versions set the variables. */
function insidePatch(element: XmlElement): boolean {
  for (let current: XmlElement | undefined = element; current; current = current.parent) {
    if (current.name === 'patch') {
      return true;
    }
  }
  return false;
}

/**
 * A variable read in a script or cue table that nothing in the document defines: probably a typo or a
 * missing `<param>`. Guarded reads (`@$x`, `$x?`) are fine, as are global and remote tables, which other
 * scripts fill, reads inside an AI script's interrupt library, which the scripts that use it answer
 * for, and variables that library items of other files set.
 */
export function validateVariables(variables: DocumentVariables, document: TextDocument, source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const table of variables.tables) {
    if (table.kind === 'global' || table.kind === 'remote') {
      continue;
    }
    if (table.opaque || (table.kind === 'library' && table.links.size === 0)) {
      // Filled by another script, or a library nothing includes by name (`include_actions ref="$lib"`).
      continue;
    }
    for (const variable of table.variables.values()) {
      if (variables.isDefined(variable)) {
        continue;
      }
      for (const reference of variable.references) {
        if (reference.guarded || reference.external || insidePatch(reference.element)) {
          continue;
        }
        const where = table.kind === 'script' ? 'this script' : `${table.kind} '${table.name}'`;
        diagnostics.push({
          range: Range.create(document.positionAt(reference.start), document.positionAt(reference.end)),
          message: `Variable '$${variable.name}' is never set in ${where}`,
          severity: DiagnosticSeverity.Warning,
          code: 'variable-undefined',
          source,
        });
      }
    }
  }
  diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return diagnostics;
}
