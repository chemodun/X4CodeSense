import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import { offsetInValue, type XmlElement } from '../xml/xmlStructure';
import { isExpressionAttribute, type XsdElement } from '../xsd/schema';
import { parseExpression, walkExpression, type Expression } from './parser';

export type ExpressionDiagnosticCode = 'expression-syntax' | 'expression-null-safe-exists' | 'expression-text-reference' | 'expression-format-specifier';

/**
 * Parses every attribute value that takes an expression and reports what the game would reject:
 * syntax errors, `@` combined with `?`, text references that are not numeric literals, and `%d` in a
 * format string, which fails at run time.
 */
export function validateExpressions(declarations: ReadonlyMap<XmlElement, XsdElement>, document: TextDocument, source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (code: ExpressionDiagnosticCode, message: string, start: number, end: number, severity: DiagnosticSeverity): void => {
    diagnostics.push({ range: Range.create(document.positionAt(start), document.positionAt(end)), message, severity, code, source });
  };
  for (const [element, declaration] of declarations) {
    for (const attribute of element.attributes) {
      if (attribute.quote === '' || attribute.value.trim() === '' || !isExpressionAttribute(declaration.attributes.get(attribute.name))) {
        continue;
      }
      const parsed = parseExpression(attribute.value);
      for (const error of parsed.errors) {
        report(`expression-${error.code}`, error.message, offsetInValue(attribute, error.start), offsetInValue(attribute, error.end), DiagnosticSeverity.Error);
      }
      walkExpression(parsed.expression, (node: Expression) => {
        if (node.kind !== 'args' || node.object.kind !== 'string') {
          return;
        }
        const text = node.object.text;
        for (let index = text.indexOf('%d'); index >= 0; index = text.indexOf('%d', index + 2)) {
          const start = node.object.start + index;
          report(
            'expression-format-specifier',
            "'%d' is not a format specifier the game knows; numbers format with '%s'",
            offsetInValue(attribute, start),
            offsetInValue(attribute, start + 2),
            DiagnosticSeverity.Warning
          );
        }
      });
    }
  }
  diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return diagnostics;
}
