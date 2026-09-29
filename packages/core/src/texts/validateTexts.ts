import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import { attributeNamed, offsetInValue, type XmlAttribute, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import { typeNamesOf, type XsdElement, type XsdSchema } from '../xsd/schema';
import { textReferencesIn, type TextDatabase } from './textDatabase';

export type TextDiagnosticCode = 'text-undefined';

/** Why a text reference does not resolve, or undefined when it does. */
export function missingTextMessage(texts: TextDatabase, page: number, id: number): string | undefined {
  if (texts.has(page, id)) {
    return undefined;
  }
  return texts.hasPage(page) ? `Text ${id} does not exist on page ${page}` : `Text page ${page} does not exist`;
}

/** True for an attribute of the schema type `comment`, or named `comment` when its declaration is unknown: its text is for people. */
function isComment(attribute: XmlAttribute, declaration: XsdElement | undefined): boolean {
  const declared = declaration?.attributes.get(attribute.name);
  return declared ? typeNamesOf(declared.type).has('comment') : attribute.name === 'comment';
}

/**
 * Text references of a script that no loaded text file defines: `{page, id}` in any attribute but a
 * comment, and `page="…" line="…"` pairs of an element. Vanilla writes references in comments that no
 * longer exist, so comments are left out.
 */
export function validateTexts(
  structure: XmlStructure,
  declarations: ReadonlyMap<XmlElement, XsdElement>,
  xsd: XsdSchema | undefined,
  texts: TextDatabase,
  document: TextDocument,
  source: string,
  checkElement?: (element: XmlElement) => boolean
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (start: number, end: number, message: string): void => {
    diagnostics.push({
      range: Range.create(document.positionAt(start), document.positionAt(end)),
      message,
      severity: DiagnosticSeverity.Warning,
      code: 'text-undefined' satisfies TextDiagnosticCode,
      source,
    });
  };
  for (const element of structure.elements) {
    if (checkElement && !checkElement(element)) {
      continue;
    }
    const declaration = declarations.get(element) ?? xsd?.anyDeclaration(element.name);
    for (const attribute of element.attributes) {
      if (attribute.quote === '' || !attribute.value.includes('{') || isComment(attribute, declaration)) {
        continue;
      }
      for (const reference of textReferencesIn(attribute.value)) {
        const message = missingTextMessage(texts, reference.page, reference.id);
        if (message) {
          report(offsetInValue(attribute, reference.start), offsetInValue(attribute, reference.end), message);
        }
      }
    }
    const page = attributeNamed(element, 'page');
    const line = attributeNamed(element, 'line');
    if (page && line && /^\s*\d+\s*$/.test(page.value) && /^\s*\d+\s*$/.test(line.value)) {
      const message = missingTextMessage(texts, Number(page.value), Number(line.value));
      if (message) {
        report(line.valueStart, line.valueEnd, message);
      }
    }
  }
  diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return diagnostics;
}
