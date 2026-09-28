import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import { detectDocument } from '../scripts/scriptMetadata';
import type { DocumentDetection } from '../types';
import { parseXml, type XmlStructure } from '../xml/xmlStructure';

/** `source` of every diagnostic this library produces. */
export const diagnosticSource = 'X4CodeSense';

/** Everything the library knows about one document after a full analysis. */
export interface DocumentAnalysis {
  document: TextDocument;
  detection: DocumentDetection;
  /** Element structure; present for scripts and patches, absent for other documents. */
  structure?: XmlStructure;
  /** Diagnostics in document order of discovery. */
  diagnostics: Diagnostic[];
}

/**
 * Analyses one document: classifies it, and for scripts and patches scans the XML structure and reports
 * well-formedness problems as diagnostics. The XSD, expression and symbol passes build on this result.
 * Other XML documents get no diagnostics, so other XML tooling stays in charge of them.
 */
export function analyzeDocument(document: TextDocument): DocumentAnalysis {
  const text = document.getText();
  const detection = detectDocument(text);
  const analysis: DocumentAnalysis = { document, detection, diagnostics: [] };
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
  return analysis;
}

/** Analyses a text that is not backed by an editor document, for tools and tests. */
export function analyzeText(text: string, uri = 'untitled:document.xml'): DocumentAnalysis {
  return analyzeDocument(TextDocument.create(uri, 'xml', 0, text));
}
