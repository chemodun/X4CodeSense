import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import { detectDocument } from '../scripts/scriptMetadata';
import type { DocumentDetection } from '../types';
import type { ScriptProperties } from '../properties/scriptProperties';
import { attributeNamed, elementAt, parseXml, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import { rootElementName, type SchemaSet } from '../xsd/loadSchemas';
import type { XsdElement } from '../xsd/schema';
import { validateStructure } from '../xsd/validateStructure';
import { reuseParsedValues, type ParsedValueCache } from '../expressions/attributeExpression';
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
import { mergeTargetOf, validateMergeFile, validatePatch } from '../patches/validatePatch';

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
   * Guess the type of what actions write into variables from their names and documentation where the
   * schema's types do not tell it (`create_ship name` a ship). Defaults to true. A variable's type is
   * used where the variables are collected anyway: with `validateVariables`, and by the features.
   */
  guessVariableTypes?: boolean;
  /**
   * With `validateVariables` and `properties`, report properties a variable's type does not have
   * (`$ship.foo` where the script sets `$ship` to a ship), also under `@` or tested with `?`: a warning
   * where the script or the schema states the type, information (`expression-unknown-property-guessed`)
   * where it is guessed. Defaults to true.
   */
  validateTypedProperties?: boolean;
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
  /**
   * The parsed values of this document's previous analysis, for an editor that analyses a document again
   * on each change: the expressions the change left as they were are not parsed or resolved again. One
   * per open document, kept while it is open; the analysis updates it. Without it every value is parsed
   * afresh. The findings are the same either way.
   */
  expressionCache?: ParsedValueCache;
  /**
   * For a text no editor shows, a patch's target as patched: where an offset of it was written (see
   * `DocumentAnalysis.origin`). Messages that name a line name that one, and the analysis keeps it.
   */
  origin?: (offset: number) => { line: number; file?: string } | undefined;
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
  /** Element structure; present for scripts, patches and merge files, absent for other documents. */
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
 * they bring in is checked as part of that script. With the index, a merge file in an extension's
 * `libraries` is scanned as well, and its root checked. Other XML documents get no diagnostics, so other
 * XML tooling stays in charge of them.
 */
export function analyzeDocument(document: TextDocument, context: AnalysisContext = {}): DocumentAnalysis {
  const text = document.getText();
  const detection = detectDocument(text);
  const analysis: DocumentAnalysis = { document, detection, declarations: new Map(), diagnostics: [], ...(context.origin ? { origin: context.origin } : {}) };
  const merge = !detection.script && !detection.isDiff && context.index ? mergeTargetOf(document.uri, context.index) : undefined;
  if (!detection.script && !detection.isDiff && !merge) {
    return analysis;
  }
  const structure = parseXml(text);
  analysis.structure = structure;
  if (context.expressionCache) {
    reuseParsedValues(structure, context.expressionCache);
  }
  for (const problem of structure.problems) {
    analysis.diagnostics.push({
      range: Range.create(document.positionAt(problem.start), document.positionAt(problem.end)),
      message: problem.message,
      severity: DiagnosticSeverity.Error,
      code: problem.code,
      source: diagnosticSource,
    });
  }
  if (merge && context.index) {
    analysis.diagnostics.push(...validateMergeFile(document, structure, merge, context.index, diagnosticSource));
    return analysis;
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
    // Collected on first use: most analyses without the index are keystrokes that never ask for variables.
    const scriptSchema = detection.script.schema;
    let variables: DocumentVariables | undefined;
    const variablesOf = (): DocumentVariables =>
      (variables ??= collectVariables(analysis, scriptSchema, schema, context.properties, context.index, { guessTypes: context.guessVariableTypes ?? true }));
    Object.defineProperty(analysis, 'variables', { enumerable: true, get: variablesOf });
    const checkVariables = context.validateVariables ?? context.index !== undefined;
    if (context.validateExpressions ?? true) {
      analysis.diagnostics.push(
        ...validateExpressions(validation.declarations, document, diagnosticSource, {
          properties: context.properties,
          ...(context.texts ? { texts: context.texts } : {}),
          formats: context.validateFormats ?? true,
          schema: detection.script.schema,
          knownHeads: cueNames(structure),
          ...(checkElement ? { checkElement } : {}),
          // The types of variables where they are collected anyway, for their own check.
          ...(checkVariables && context.properties ? { variables: variablesOf(), typedProperties: context.validateTypedProperties ?? true } : {}),
          ...(context.origin ? { origin: context.origin } : {}),
        })
      );
    }
    if (checkVariables) {
      analysis.diagnostics.push(...validateVariables(variablesOf(), document, diagnosticSource));
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
 * the elements it set values of, and their ancestors, whose children it changed. Only a script is
 * analysed so: a library file has no schema to check it against.
 */
function analyzePatchedTarget(patch: PatchAnalysis, document: TextDocument, context: AnalysisContext): Diagnostic[] {
  const target = patch.target.file;
  const root = patch.document?.children.find((child) => child.kind === 'element');
  if (
    !patch.document ||
    target === undefined ||
    !root ||
    !Object.values(rootElementName).includes(root.name) ||
    !patch.operations.some((operation) => operation.status === 'applied' && operation.kind !== 'remove')
  ) {
    return [];
  }
  const written = writePatchedTree(patch.document);
  const touched = overlapsPieceOf(written, patch.source);
  const files = new Map<PatchSource, { document: TextDocument; file?: string }>();
  const origin = (offset: number): { line: number; file?: string } | undefined => {
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
  // The target's uri with a fragment: locations in this text are told apart from those in the file.
  const patched = analyzeDocument(TextDocument.create(`${pathToFileURL(target).toString()}#patched`, 'xml', 0, written.text), {
    ...context,
    checkElement: (element) => touched(element.start, element.end),
    // The target's trees are kept apart from the patch document's, which would take their place.
    ...(context.expressionCache ? { expressionCache: (context.expressionCache.patched ??= {}) } : {}),
    origin,
  });
  patch.patched = { written, analysis: patched };
  const diagnostics: Diagnostic[] = [];
  // Text an operation holds beside what it brings in is the patch check's to report, written out or not.
  const structure = patch.source.structure;
  const inOperation = (offset: number): boolean => {
    const element = elementAt(structure, offset);
    return element !== undefined && element.parent === structure.roots[0];
  };
  // The well-formedness problems come first in every analysis.
  for (const diagnostic of patched.diagnostics.slice(patched.structure?.problems.length ?? 0)) {
    const range = sourceRange(written, patch.source, patched.document.offsetAt(diagnostic.range.start), patched.document.offsetAt(diagnostic.range.end));
    if (range && !(diagnostic.code === 'text-not-allowed' && inOperation(range.start))) {
      diagnostics.push({ ...diagnostic, range: Range.create(document.positionAt(range.start), document.positionAt(range.end)) });
    }
  }
  return diagnostics;
}

/** Analyses a text that is not backed by an editor document, for tools and tests. */
export function analyzeText(text: string, context: AnalysisContext = {}, uri = 'untitled:document.xml'): DocumentAnalysis {
  return analyzeDocument(TextDocument.create(uri, 'xml', 0, text), context);
}
