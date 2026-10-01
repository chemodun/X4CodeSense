import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { scriptSchemaOf } from '../analysis/positionContext';
import { attributeNamed, type XmlElement } from '../xml/xmlStructure';
import { isCall, valueRange } from './calls';
import { callTarget, callTargetLabel, type CallTarget } from './callTargets';
import type { ScriptIndex } from './scriptIndex';

export type CallParameterDiagnosticCode = 'param-unknown';

/**
 * Parameters a call passes that its target does not declare: a `<param name="x">` of a `run_script`,
 * `create_order`, `run_actions` or `<cue ref>` whose script, order or library has no `x` in its
 * `<params>`. The game's own scripts have such calls left behind when a library changed. Only calls whose
 * target is written literally and found are checked; a target in another file needs the index.
 * Parameters a call leaves out are not reported: the game takes them as null, and its own scripts leave
 * out parameters without a default.
 */
export function validateCallParameters(
  analysis: DocumentAnalysis,
  index: ScriptIndex | undefined,
  source: string,
  checkElement?: (element: XmlElement) => boolean
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const schema = scriptSchemaOf(analysis);
  const document = analysis.document;
  // The story scripts call the same libraries hundreds of times.
  const memo = new Map<string, CallTarget | undefined>();
  for (const call of analysis.structure?.elements ?? []) {
    if (!isCall(call, schema)) {
      continue;
    }
    const passed = call.children.flatMap((param) => {
      const attribute = param.name === 'param' ? attributeNamed(param, 'name') : undefined;
      const name = attribute?.value.trim();
      return attribute && name && (!checkElement || checkElement(param)) ? [{ name, attribute }] : [];
    });
    // Without parameters to check, the target is not looked up.
    const target = passed.length > 0 ? callTarget(analysis, call, index, memo) : undefined;
    if (!target) {
      continue;
    }
    const declared = new Set(target.parameters.map((parameter) => parameter.name));
    for (const { name, attribute } of passed) {
      if (declared.has(name)) {
        continue;
      }
      const { start, end } = valueRange(attribute);
      diagnostics.push({
        range: Range.create(document.positionAt(start), document.positionAt(end)),
        message: `'${name}' is not a parameter of ${callTargetLabel(target)}`,
        severity: DiagnosticSeverity.Warning,
        code: 'param-unknown' satisfies CallParameterDiagnosticCode,
        source,
      });
    }
  }
  return diagnostics;
}
