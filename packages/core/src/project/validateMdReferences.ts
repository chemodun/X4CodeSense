import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { XsdSchema } from '../xsd/schema';
import { mdReferencesOf } from './mdReferences';
import type { ScriptIndex } from './scriptIndex';

/**
 * `md.<Script>.<Cue>` naming a script or cue that no indexed script defines (cues that extension patches
 * add count). References to the document's own script are left to the name checks of the document,
 * which see its unsaved cues; guarded references (`@md.X.Y`, `md.X.Y?`) are fine.
 */
export function validateMdReferences(
  analysis: DocumentAnalysis,
  xsd: XsdSchema | undefined,
  index: ScriptIndex,
  document: TextDocument,
  source: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const own = analysis.detection.script?.schema === 'md' ? analysis.detection.script.name : undefined;
  const report = (start: number, end: number, message: string): void => {
    diagnostics.push({
      range: Range.create(document.positionAt(start), document.positionAt(end)),
      message,
      severity: DiagnosticSeverity.Warning,
      code: 'cue-undefined',
      source,
    });
  };
  for (const reference of mdReferencesOf(analysis, xsd)) {
    if (reference.guarded || reference.script === own) {
      continue;
    }
    if (index.scripts('md', reference.script).length === 0) {
      report(reference.scriptStart, reference.scriptEnd, `No Mission Director script '${reference.script}' is known`);
    } else if (
      reference.cue !== undefined &&
      reference.cueStart !== undefined &&
      reference.cueEnd !== undefined &&
      index.cues(reference.script, reference.cue).length === 0
    ) {
      report(reference.cueStart, reference.cueEnd, `Script '${reference.script}' has no cue '${reference.cue}'`);
    }
  }
  return diagnostics;
}
