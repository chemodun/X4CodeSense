import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import type { ScriptIndex } from '../project/scriptIndex';
import { validateCallParameters } from '../project/validateCallParameters';
import { validateMdReferences } from '../project/validateMdReferences';
import { validateScriptNames } from '../project/validateScriptNames';
import type { TextDatabase } from '../texts/textDatabase';
import { validateTexts } from '../texts/validateTexts';
import type { PatchAnalysis } from '../patches/patchAnalysis';
import { overlapsPieceOf, sourceOffsetAt, sourceRange, writePatchedTree } from '../patches/patchedDocument';
import type { PatchSource } from '../patches/patchTree';
import { validatePatch } from '../patches/validatePatch';

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
   * Report variables that are read but never set. Defaults to true when `index` is given, false
   * otherwise: AI scripts use interrupt library items of other files, and Mission Director scripts
   * include each other's libraries and write into each other's cues, which a single document cannot see.
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
  /**
   * The scripts of the game and the extensions. With it, and `validateNames`, interrupt library
   * references that no script defines are reported.
   */
  index?: ScriptIndex;
  /**
   * Report `md.<Script>.<Cue>` naming a script or cue that no indexed script defines. Defaults to true;
   * needs `index`, and is only as complete as the configured extension folders.
   */
  validateRemoteCues?: boolean;
  /**
   * Report parameters a call (`run_script`, `create_order`, `run_actions`, `<cue ref>`, …) passes that
   * the script, order or library it names does not declare. Defaults to true; a target in another file
   * needs `index`.
   */
  validateCallParameters?: boolean;
  /**
   * Report AI script names and order ids a call writes literally (`run_script name="'move.generic'"`,
   * `create_order id="'Attack'"`) that no indexed script defines. Defaults to true; needs `index`, and
   * is only as complete as the configured extension folders.
   */
  validateScriptNames?: boolean;
  /**
   * Count the arguments of formats (`'%s of %s'.[$a, $b]`, `{page, id}.[…]` with `texts`): fewer than
   * the placeholders take is a warning, more is information. Defaults to true.
   */
  validateFormats?: boolean;
  /**
   * Check only the elements for which this holds: their attributes, expressions, text and `md.`
   * references, and their children. The declarations, variables and names of the whole document are
   * still worked out, and their findings reported everywhere. A patch document checks its target so,
   * for the elements its pieces touch.
   */
  checkElement?: (element: XmlElement) => boolean;
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
  /** For a patch document analysed with the index: the patch applied to the file it changes. */
  patch?: PatchAnalysis;
  /**
   * For the patched target of a patch document (`PatchAnalysis.patched`), whose text no editor shows:
   * where an offset of it was written, as a zero-based line of the patch document (no `file`) or of the
   * file `file` names. Undefined for text the write-out added.
   */
  origin?: (offset: number) => { line: number; file?: string } | undefined;
  /** Diagnostics in document order of discovery. */
  diagnostics: Diagnostic[];
}

/**
 * Analyses one document: classifies it, and for scripts and patches scans the XML structure and reports
 * well-formedness problems as diagnostics. Scripts are then validated against their schema when one is
 * available; patches against `diff.xsd`, and with the index against the file they change, where what
 * they bring in is checked as part of that script. Other XML documents get no diagnostics, so other XML
 * tooling stays in charge of them.
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
  if (detection.isDiff) {
    const validation = validatePatch(document, structure, {
      ...(context.schemas ? { schemas: context.schemas } : {}),
      ...(context.index ? { index: context.index } : {}),
      source: diagnosticSource,
    });
    analysis.declarations = validation.declarations;
    analysis.diagnostics.push(...validation.diagnostics);
    if (validation.patch) {
      analysis.patch = validation.patch;
      analysis.diagnostics.push(...analyzePatchedTarget(validation.patch, document, context));
    }
    return analysis;
  }
  const schema = detection.script && context.schemas?.schemas[detection.script.schema];
  if (detection.script && schema) {
    const checkElement = context.checkElement;
    const validation = validateStructure(structure, schema, rootElementName[detection.script.schema], document, {
      checkContent: context.validateStructure ?? true,
      source: diagnosticSource,
      ...(checkElement ? { checkElement } : {}),
    });
    analysis.declarations = validation.declarations;
    analysis.diagnostics.push(...validation.diagnostics);
    if (context.validateExpressions ?? true) {
      analysis.diagnostics.push(
        ...validateExpressions(validation.declarations, document, diagnosticSource, {
          properties: context.properties,
          ...(context.texts ? { texts: context.texts } : {}),
          formats: context.validateFormats ?? true,
          schema: detection.script.schema,
          knownHeads: cueNames(structure),
          ...(checkElement ? { checkElement } : {}),
        })
      );
    }
    // Collected on first use: most analyses are keystrokes that never ask for variables.
    const scriptSchema = detection.script.schema;
    let variables: DocumentVariables | undefined;
    Object.defineProperty(analysis, 'variables', {
      enumerable: true,
      get: () => (variables ??= collectVariables(analysis, scriptSchema, schema, context.properties, context.index)),
    });
    if (context.validateVariables ?? context.index !== undefined) {
      analysis.diagnostics.push(...validateVariables(analysis.variables as DocumentVariables, document, diagnosticSource));
    }
    let names: DocumentNames | undefined;
    Object.defineProperty(analysis, 'names', {
      enumerable: true,
      get: () => (names ??= collectNames(analysis, scriptSchema, schema, context.properties)),
    });
    if (context.validateNames ?? true) {
      analysis.diagnostics.push(
        ...validateNames(analysis.names as DocumentNames, document, diagnosticSource, {
          cueReferences: context.validateCueReferences ?? true,
          ...(context.index ? { index: context.index } : {}),
        })
      );
    }
    if (context.index && (context.validateRemoteCues ?? true)) {
      analysis.diagnostics.push(...validateMdReferences(analysis, schema, context.index, document, diagnosticSource, checkElement));
    }
    if (context.texts && (context.validateTexts ?? true)) {
      analysis.diagnostics.push(...validateTexts(structure, validation.declarations, schema, context.texts, document, diagnosticSource, checkElement));
    }
    if (context.validateCallParameters ?? true) {
      analysis.diagnostics.push(...validateCallParameters(analysis, context.index, diagnosticSource, checkElement));
    }
    if (context.index && (context.validateScriptNames ?? true)) {
      analysis.diagnostics.push(...validateScriptNames(analysis, context.index, diagnosticSource, checkElement));
    }
  }
  return analysis;
}

/**
 * Analyses the target with the patch applied, as the script the game loads, and gives the diagnostics
 * that lie in what this patch brought in, placed in the patch document. The target's own findings and
 * those in what earlier patches brought in are theirs to report, and the patch document reports its own
 * well-formedness problems. So only the elements the patch's pieces touch are checked: what it inserted,
 * the elements it set values of, and their ancestors, whose children it changed.
 */
function analyzePatchedTarget(patch: PatchAnalysis, document: TextDocument, context: AnalysisContext): Diagnostic[] {
  const target = patch.target.file;
  if (!patch.document || target === undefined || !patch.operations.some((operation) => operation.status === 'applied' && operation.kind !== 'remove')) {
    return [];
  }
  const written = writePatchedTree(patch.document);
  const touched = overlapsPieceOf(written, patch.source);
  // The target's uri with a fragment: locations in this text are told apart from those in the file.
  const patched = analyzeDocument(TextDocument.create(`${pathToFileURL(target).toString()}#patched`, 'xml', 0, written.text), {
    ...context,
    checkElement: (element) => touched(element.start, element.end),
  });
  const files = new Map<PatchSource, { document: TextDocument; file?: string }>();
  patched.origin = (offset) => {
    const at = sourceOffsetAt(written, offset);
    if (!at) {
      return undefined;
    }
    let file = files.get(at.source);
    if (!file) {
      const source = at.source;
      file =
        source === patch.source
          ? { document }
          : {
              document: TextDocument.create(pathToFileURL(source.file).toString(), 'xml', 0, source.text),
              file: source.file === target ? path.basename(target) : `the patch of ${context.index?.sourceOf(source.file) ?? path.basename(source.file)}`,
            };
      files.set(source, file);
    }
    return { line: file.document.positionAt(at.offset).line, ...(file.file === undefined ? {} : { file: file.file }) };
  };
  patch.patched = { written, analysis: patched };
  const diagnostics: Diagnostic[] = [];
  // The well-formedness problems come first in every analysis.
  for (const diagnostic of patched.diagnostics.slice(patched.structure?.problems.length ?? 0)) {
    const range = sourceRange(written, patch.source, patched.document.offsetAt(diagnostic.range.start), patched.document.offsetAt(diagnostic.range.end));
    if (range) {
      diagnostics.push({ ...diagnostic, range: Range.create(document.positionAt(range.start), document.positionAt(range.end)) });
    }
  }
  return diagnostics;
}

/** Analyses a text that is not backed by an editor document, for tools and tests. */
export function analyzeText(text: string, context: AnalysisContext = {}, uri = 'untitled:document.xml'): DocumentAnalysis {
  return analyzeDocument(TextDocument.create(uri, 'xml', 0, text), context);
}
