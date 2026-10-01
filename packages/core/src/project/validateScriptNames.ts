import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { scriptSchemaOf } from '../analysis/positionContext';
import type { XmlElement } from '../xml/xmlStructure';
import { scriptNameOf } from './calls';
import type { ScriptIndex } from './scriptIndex';

export type ScriptNameDiagnosticCode = 'aiscript-undefined' | 'order-undefined';

/**
 * AI script names and order ids that a call writes literally (`run_script name="'move.generic'"`,
 * `create_order id="'Attack'"`) and no indexed script defines. The document's own `<aiscript name>` and
 * `<order id>` count as they are in its text, which the index may not have yet. Only as complete as the
 * configured extension folders: an order of an extension that is not read is unknown.
 */
export function validateScriptNames(
  analysis: DocumentAnalysis,
  index: ScriptIndex,
  source: string,
  checkElement?: (element: XmlElement) => boolean
): Diagnostic[] {
  const schema = scriptSchemaOf(analysis);
  if (!analysis.structure || !schema) {
    return [];
  }
  const written = analysis.structure.elements.flatMap((element) => {
    const name = scriptNameOf(element, schema);
    return name ? [{ element, name }] : [];
  });
  const own = new Set(written.filter(({ name }) => name.defines).map(({ name }) => `${name.kind}|${name.name}`));
  const diagnostics: Diagnostic[] = [];
  const document = analysis.document;
  for (const { element, name } of written) {
    if (name.defines || own.has(`${name.kind}|${name.name}`) || (checkElement && !checkElement(element))) {
      continue;
    }
    const known = name.kind === 'script' ? index.scripts('aiscripts', name.name).length > 0 : index.orderScripts(name.name).length > 0;
    if (known) {
      continue;
    }
    diagnostics.push({
      range: Range.create(document.positionAt(name.start), document.positionAt(name.end)),
      message: name.kind === 'script' ? `No AI script '${name.name}' is known` : `No order '${name.name}' is known`,
      severity: DiagnosticSeverity.Warning,
      code: (name.kind === 'script' ? 'aiscript-undefined' : 'order-undefined') satisfies ScriptNameDiagnosticCode,
      source,
    });
  }
  return diagnostics;
}
