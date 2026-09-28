import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import { detectDocument } from '../scripts/scriptMetadata';
import type { DocumentDetection } from '../types';
import { parseXml, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import { rootElementName, type SchemaSet } from '../xsd/loadSchemas';
import type { XsdElement } from '../xsd/schema';
import { validateStructure } from '../xsd/validateStructure';
import { validateExpressions } from '../expressions/validateExpressions';

/** `source` of every diagnostic this library produces. */
export const diagnosticSource = 'X4CodeSense';

/** What an analysis may use besides the document itself. */
export interface AnalysisContext {
  /** Game schemas; without them no structure validation takes place. */
  schemas?: SchemaSet;
  /** Check the order and completeness of child elements, not only their names. Defaults to true. */
  validateStructure?: boolean;
  /** Parse expression attributes and report syntax problems. Defaults to true; needs the schemas. */
  validateExpressions?: boolean;
}

/** Everything the library knows about one document after a full analysis. */
export interface DocumentAnalysis {
  document: TextDocument;
  detection: DocumentDetection;
  /** Element structure; present for scripts and patches, absent for other documents. */
  structure?: XmlStructure;
  /** Schema declaration of each element that could be resolved; empty without schemas. */
  declarations: Map<XmlElement, XsdElement>;
  /** Diagnostics in document order of discovery. */
  diagnostics: Diagnostic[];
}

/**
 * Analyses one document: classifies it, and for scripts and patches scans the XML structure and reports
 * well-formedness problems as diagnostics. Scripts are then validated against their schema when one is
 * available. Other XML documents get no diagnostics, so other XML tooling stays in charge of them.
 */
export function analyzeDocument(document: TextDocument, context: AnalysisContext = {}): DocumentAnalysis {
  const text = document.getText();
  const detection = detectDocument(text);
  const analysis: DocumentAnalysis = { document, detection, declarations: new Map(), diagnostics: [] };
  if (!detection.script && !detection.isDiff) {
    return analysis;
  }
  const structure = parseXml(text);
  analysis.structure = structure;
  for (const problem of structure.problems) {
    analysis.diagnostics.push({
      range: Range.create(document.positionAt(problem.start), document.positionAt(problem.end)),
      message: problem.message,
      severity: DiagnosticSeverity.Error,
      code: problem.code,
      source: diagnosticSource,
    });
  }
  const schema = detection.script && context.schemas?.schemas[detection.script.schema];
  if (detection.script && schema) {
    const validation = validateStructure(structure, schema, rootElementName[detection.script.schema], document, {
      checkContent: context.validateStructure ?? true,
      source: diagnosticSource,
    });
    analysis.declarations = validation.declarations;
    analysis.diagnostics.push(...validation.diagnostics);
    if (context.validateExpressions ?? true) {
      analysis.diagnostics.push(...validateExpressions(validation.declarations, document, diagnosticSource));
    }
  }
  return analysis;
}

/** Analyses a text that is not backed by an editor document, for tools and tests. */
export function analyzeText(text: string, context: AnalysisContext = {}, uri = 'untitled:document.xml'): DocumentAnalysis {
  return analyzeDocument(TextDocument.create(uri, 'xml', 0, text), context);
}
