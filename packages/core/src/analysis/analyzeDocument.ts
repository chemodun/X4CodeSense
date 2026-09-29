import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import { detectDocument } from '../scripts/scriptMetadata';
import type { DocumentDetection } from '../types';
import type { ScriptProperties } from '../properties/scriptProperties';
import { attributeNamed, parseXml, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import { rootElementName, type SchemaSet } from '../xsd/loadSchemas';
import type { XsdElement } from '../xsd/schema';
import { validateStructure } from '../xsd/validateStructure';
import { validateExpressions } from '../expressions/validateExpressions';
import { collectVariables, type DocumentVariables } from '../variables/variables';
import { validateVariables } from '../variables/validateVariables';
import { collectNames, type DocumentNames } from '../names/namedItems';
import { validateNames } from '../names/validateNames';
import type { TextDatabase } from '../texts/textDatabase';
import { validateTexts } from '../texts/validateTexts';

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
  /** Script properties; with them expressions are also checked for unknown keywords and properties. */
  properties?: ScriptProperties;
  /**
   * Report variables that are read but never set in the document. Off by default: AI scripts include
   * named actions of library scripts and Mission Director scripts write into each other's cues, so a
   * single document cannot tell until scripts are indexed across files.
   */
  validateVariables?: boolean;
  /**
   * Check labels, cues and interrupt library items: names defined twice where they must be unique, and
   * labels no reachable attention block defines. Defaults to true; needs the schemas.
   */
  validateNames?: boolean;
  /**
   * With `validateNames`, also report bare names in Mission Director expressions that are no keyword and
   * no cue of the script. Defaults to true; see `NameValidationOptions.cueReferences`.
   */
  validateCueReferences?: boolean;
  /** The game's texts; with them `{page, id}` references are checked. */
  texts?: TextDatabase;
  /** Report text references that no loaded text file defines. Defaults to true; needs `texts`. */
  validateTexts?: boolean;
}

/** Names of the cues and libraries of a script: they may start a chain like a keyword. */
function cueNames(structure: XmlStructure): Set<string> {
  const names = new Set<string>();
  for (const element of structure.elements) {
    if (element.name === 'cue' || element.name === 'library') {
      const name = attributeNamed(element, 'name')?.value;
      if (name !== undefined && name !== '') {
        names.add(name);
      }
    }
  }
  return names;
}

/** Everything the library knows about one document after a full analysis. */
export interface DocumentAnalysis {
  document: TextDocument;
  detection: DocumentDetection;
  /** Element structure; present for scripts and patches, absent for other documents. */
  structure?: XmlStructure;
  /** Schema declaration of each element that could be resolved; empty without schemas. */
  declarations: Map<XmlElement, XsdElement>;
  /** The script's variables and their tables; present for scripts analysed with schemas, collected on first access. */
  readonly variables?: DocumentVariables;
  /** Labels, cues and interrupt library items with their references; present for scripts analysed with schemas. */
  readonly names?: DocumentNames;
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
      analysis.diagnostics.push(
        ...validateExpressions(validation.declarations, document, diagnosticSource, {
          properties: context.properties,
          schema: detection.script.schema,
          knownHeads: cueNames(structure),
        })
      );
    }
    // Collected on first use: most analyses are keystrokes that never ask for variables.
    const scriptSchema = detection.script.schema;
    let variables: DocumentVariables | undefined;
    Object.defineProperty(analysis, 'variables', {
      enumerable: true,
      get: () => (variables ??= collectVariables(analysis, scriptSchema, schema, context.properties)),
    });
    if (context.validateVariables ?? false) {
      analysis.diagnostics.push(...validateVariables(analysis.variables as DocumentVariables, document, diagnosticSource));
    }
    let names: DocumentNames | undefined;
    Object.defineProperty(analysis, 'names', {
      enumerable: true,
      get: () => (names ??= collectNames(analysis, scriptSchema, schema, context.properties)),
    });
    if (context.validateNames ?? true) {
      analysis.diagnostics.push(
        ...validateNames(analysis.names as DocumentNames, document, diagnosticSource, { cueReferences: context.validateCueReferences ?? true })
      );
    }
    if (context.texts && (context.validateTexts ?? true)) {
      analysis.diagnostics.push(...validateTexts(structure, validation.declarations, schema, context.texts, document, diagnosticSource));
    }
  }
  return analysis;
}

/** Analyses a text that is not backed by an editor document, for tools and tests. */
export function analyzeText(text: string, context: AnalysisContext = {}, uri = 'untitled:document.xml'): DocumentAnalysis {
  return analyzeDocument(TextDocument.create(uri, 'xml', 0, text), context);
}
