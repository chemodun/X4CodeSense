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
 * A variable read in a script or cue table that nothing defines: probably a typo or a missing
 * `<param>`. Guarded reads (`@$x`, `$x?`, or under such a test) are fine, as are global, remote and
 * opaque tables, which other code fills, reads inside an AI script's interrupt library, which the
 * scripts that use it answer for, variables that libraries of other files set, and variables some
 * script writes into cues it gets as values.
 */
export function validateVariables(variables: DocumentVariables, document: TextDocument, source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const table of variables.tables) {
    if (table.kind === 'global' || table.kind === 'remote') {
      continue;
    }
    if (table.opaque) {
      // Filled by another script, or a library used through a value (`include_actions ref="$lib"`).
      continue;
    }
    for (const variable of table.variables.values()) {
      if (variables.isDefined(variable) || variables.mayBeWrittenThroughValues(variable)) {
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
