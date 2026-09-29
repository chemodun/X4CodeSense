import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { DocumentNames, NamedItem, NamedOccurrence } from './namedItems';

export type NameDiagnosticCode = 'label-undefined' | 'name-duplicate' | 'cue-undefined';

export interface NameValidationOptions {
  /**
   * Report bare names in Mission Director expressions that are no keyword and no cue of the script.
   * Defaults to true. Names in libraries are left out, because they resolve in the including script;
   * on vanilla 9.00 the check finds 20 names, all vanilla defects (see the names corpus test).
   */
  cueReferences?: boolean;
}

/** What an item is called in messages. */
export function itemNoun(item: Pick<NamedItem, 'kind'>, definition?: NamedOccurrence): string {
  switch (item.kind) {
    case 'label':
      return 'Label';
    case 'actions':
      return 'Interrupt actions';
    case 'handler':
      return 'Interrupt handler';
    case 'conditions':
      return 'Interrupt conditions';
    case 'cue':
      return definition?.element.name === 'library' ? 'Library' : 'Cue';
  }
}

/**
 * Checks the named items of a document: a name defined twice where it must be unique, a label that no
 * reachable block defines, and a bare name that is no keyword and no cue of the script. Names resolved
 * in other scripts (labels in interrupt libraries, bare names in Mission Director libraries) are not
 * checked.
 */
export function validateNames(names: DocumentNames, document: TextDocument, source: string, options: NameValidationOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (occurrence: NamedOccurrence, code: NameDiagnosticCode, message: string): void => {
    diagnostics.push({
      range: Range.create(document.positionAt(occurrence.start), document.positionAt(occurrence.end)),
      message,
      severity: DiagnosticSeverity.Warning,
      code,
      source,
    });
  };
  for (const item of names.items) {
    const [first, ...others] = item.definitions;
    for (const duplicate of others) {
      const where = item.kind === 'label' ? ' in this attention block' : '';
      report(
        duplicate,
        'name-duplicate',
        `${itemNoun(item, first)} '${item.name}' is already defined${where} at line ${document.positionAt(first.start).line + 1}`
      );
    }
  }
  for (const occurrence of names.occurrences) {
    if (occurrence.role !== 'reference' || occurrence.external || occurrence.items.some((item) => item.definitions.length > 0)) {
      continue;
    }
    if (occurrence.kind === 'label') {
      const where = occurrence.items[0].scope.startsWith('attention#') ? 'in this attention block' : 'in any attention block';
      report(occurrence, 'label-undefined', `Label '${occurrence.name}' is not defined ${where}`);
    } else if (occurrence.kind === 'cue' && (options.cueReferences ?? true) && !occurrence.guarded) {
      report(occurrence, 'cue-undefined', `'${occurrence.name}' is no keyword and no cue of this script`);
    }
  }
  diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return diagnostics;
}
