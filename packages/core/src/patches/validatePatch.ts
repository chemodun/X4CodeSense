/**
 * Diagnostics of a patch document (`<diff>`), worded after the messages the game logs for patches.
 *
 * - The structure from `diff.xsd`: the operations, their attributes and values. The values of `sel` and
 *   `if` (types `xpath...`) are read by the XPath parser instead of their patterns: the game evaluates
 *   them with libxml2 and accepts paths the patterns do not.
 * - `sel` and `if` that cannot be XPath (`patch-path-syntax`, error), or that X4CodeSense does not
 *   understand (`patch-path-unsupported`, information).
 * - With the index: a patch with nothing to patch (`patch-target-missing`), and per operation a path that
 *   selects nothing (`patch-no-match`, error, information with `silent="true"` or `"1"`) or several nodes
 *   (`patch-several-matches`), what the game refuses to do or could not use (`patch-invalid-operation`),
 *   and what X4CodeSense does not model, such as changing an element's text (`patch-operation-unsupported`,
 *   information).
 * - With the index and the schemas: text an `add` or `replace` holds beside the elements it brings in,
 *   which goes into an element of the script that allows none (`text-not-allowed`, warning). Text inside
 *   what it brings in is checked where it lands in the script.
 * - A merge file, a file in an extension's `libraries` that is no patch, whose root is not the root of the
 *   game's file it merges into: the game skips it (`library-root-mismatch`).
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { PatchTarget, ScriptIndex } from '../project/scriptIndex';
import type { ScriptSchema } from '../types';
import { attributeNamed, rangeInValue, type XmlAttribute, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import { parseXPath, parseXPathCondition, type XPath } from '../xml/xpath';
import { diffSchemaName, rootElementName, type SchemaSet } from '../xsd/loadSchemas';
import { typeNamesOf, type XsdAttribute, type XsdElement, type XsdSchema } from '../xsd/schema';
import { shownText, textNotAllowed, validateStructure, type StructureDiagnosticCode } from '../xsd/validateStructure';
import { afterEarlier, analyzePatch, type PatchAnalysis } from './patchAnalysis';
import type { PatchNode, PatchOperation } from './patchTree';

export type PatchDiagnosticCode =
  | 'patch-path-syntax'
  | 'patch-path-unsupported'
  | 'patch-target-missing'
  | 'patch-no-match'
  | 'patch-several-matches'
  | 'patch-invalid-operation'
  | 'patch-operation-unsupported'
  | 'library-root-mismatch';

export interface PatchValidation {
  diagnostics: Diagnostic[];
  /** The `diff.xsd` declaration of each element of the patch that has one. */
  declarations: Map<XmlElement, XsdElement>;
  /** The patch applied to its target; absent without the index or a file. */
  patch?: PatchAnalysis;
}

export interface PatchValidationOptions {
  schemas?: SchemaSet;
  index?: ScriptIndex;
  source: string;
}

/** True for `sel` and `if`: their values are XPath, read by the parser rather than by the schema's patterns. */
function isXPathAttribute(declared: XsdAttribute): boolean {
  return [...typeNamesOf(declared.type)].some((name) => name.startsWith('xpath'));
}

function fileOf(uri: string): string | undefined {
  if (!uri.startsWith('file:')) {
    return undefined;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function operationsOf(structure: XmlStructure): XmlElement[] {
  const root = structure.roots[0];
  return root?.name === diffSchemaName ? root.children.filter((child) => child.name === 'add' || child.name === 'replace' || child.name === 'remove') : [];
}

const shown = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

/** The schema of the script a patch changes, by the root element of its tree. */
function targetSchema(patch: PatchAnalysis, schemas: SchemaSet): XsdSchema | undefined {
  const root = patch.document?.children.find((child) => child.kind === 'element');
  const schema = (Object.keys(rootElementName) as ScriptSchema[]).find((name) => rootElementName[name] === root?.name);
  return schema && schemas.schemas[schema];
}

/** The declaration of an element of a script's tree, by the names from its root down. */
function declarationOf(node: PatchNode, schema: XsdSchema): XsdElement | undefined {
  const names: string[] = [];
  for (let at: PatchNode | undefined = node; at?.kind === 'element'; at = at.parent) {
    names.unshift(at.name);
  }
  let declaration = names.length > 0 ? schema.root(names[0]) : undefined;
  for (const name of names.slice(1)) {
    declaration = declaration?.child(name);
  }
  return declaration;
}

/** Validates a patch document: its structure, its paths, and with the index what it does to its target. */
export function validatePatch(document: TextDocument, structure: XmlStructure, options: PatchValidationOptions): PatchValidation {
  const diagnostics: Diagnostic[] = [];
  const report = (
    code: PatchDiagnosticCode | StructureDiagnosticCode,
    message: string,
    start: number,
    end: number,
    severity: DiagnosticSeverity = DiagnosticSeverity.Error
  ): void => {
    diagnostics.push({ range: Range.create(document.positionAt(start), document.positionAt(end)), message, severity, code, source: options.source });
  };
  const result: PatchValidation = { diagnostics, declarations: new Map() };
  const diff = options.schemas?.diff;
  if (diff) {
    // Names only: the one count diff.xsd sets, one element in `replace`, is one the game's own DLC patches
    // do not keep, and what an operation holds is checked where it lands in the target.
    const validation = validateStructure(structure, diff, diffSchemaName, document, {
      checkContent: false,
      source: options.source,
      checkedElsewhere: isXPathAttribute,
    });
    diagnostics.push(...validation.diagnostics);
    result.declarations = validation.declarations;
  }
  const file = fileOf(document.uri);
  const patch = options.index && file ? analyzePatch({ file, text: document.getText(), structure }, options.index) : undefined;
  if (patch) {
    result.patch = patch;
  }
  const reportPath = (attribute: XmlAttribute, parsed: XPath, offset = 0): void => {
    const problem = parsed.problem;
    if (problem) {
      const range = rangeInValue(attribute, problem.start + offset, problem.end + offset);
      report(
        problem.unsupported ? 'patch-path-unsupported' : 'patch-path-syntax',
        problem.message,
        range.start,
        Math.max(range.end, range.start),
        problem.unsupported ? DiagnosticSeverity.Information : DiagnosticSeverity.Error
      );
    }
  };
  const byElement = new Map<XmlElement, PatchOperation>(patch?.operations.map((operation) => [operation.element, operation]) ?? []);
  for (const element of operationsOf(structure)) {
    const sel = attributeNamed(element, 'sel');
    const condition = attributeNamed(element, 'if');
    const operation = byElement.get(element);
    if (sel && sel.quote !== '') {
      reportPath(sel, operation?.path ?? parseXPath(sel.value));
    }
    if (condition && condition.quote !== '') {
      reportPath(condition, (operation?.condition ?? parseXPathCondition(condition.value)).path);
    }
  }
  if (!patch) {
    return result;
  }
  const root = structure.roots[0];
  const target = patch.target;
  if (target.missing !== undefined && root) {
    report(
      'patch-target-missing',
      `Nothing to patch: ${target.missing}${hintFor(target.name, options.index)}`,
      root.nameStart,
      root.nameEnd,
      DiagnosticSeverity.Warning
    );
  }
  const earlier = afterEarlier(patch);
  for (const operation of patch.operations) {
    const sel = operation.sel;
    const pathOf = operation.path;
    if (operation.status === 'no-match' && sel && pathOf) {
      const step = pathOf.steps[operation.matchingSteps ?? 0] ?? pathOf.steps[pathOf.steps.length - 1];
      const range = step ? rangeInValue(sel, step.start, step.end) : { start: sel.valueStart, end: sel.valueEnd };
      // `xs:boolean`: the game's own DLC patches write `silent="1"`.
      const silent = /^\s*(true|1)\s*$/.test(attributeNamed(operation.element, 'silent')?.value ?? '');
      report(
        'patch-no-match',
        `No matching node in ${target.name}${earlier}: '${shown(pathOf.text.slice(step?.start ?? 0, step?.end ?? pathOf.text.length).replace(/^\/+/, ''))}' selects nothing${silent ? ' (silent)' : ''}`,
        range.start,
        range.end,
        silent ? DiagnosticSeverity.Information : DiagnosticSeverity.Error
      );
    } else if (operation.status === 'several-matches' && sel) {
      report(
        'patch-several-matches',
        `Multiple matching nodes in ${target.name}${earlier}: the path selects ${operation.matches}, an operation needs exactly one`,
        sel.valueStart,
        sel.valueEnd
      );
    } else if (operation.status === 'invalid' && operation.reason !== undefined) {
      report(
        'patch-invalid-operation',
        operation.refusedByGame ? `${operation.reason}: the game skips this operation` : operation.reason,
        operation.element.nameStart,
        operation.element.nameEnd
      );
    } else if (operation.status === 'unknown' && operation.reason !== undefined) {
      report(
        'patch-operation-unsupported',
        `${operation.reason}: X4CodeSense does not model this, so the comparison does not show it`,
        operation.element.nameStart,
        operation.element.nameEnd,
        DiagnosticSeverity.Information
      );
    }
  }
  // An operation that brings in nodes puts its text among them; one that sets a value has no parent. Text
  // added alone is not modelled, but where it lands is known.
  const schema = options.schemas && targetSchema(patch, options.schemas);
  const text = patch.source.text;
  for (const operation of schema ? patch.operations : []) {
    const parent = operation.status === 'applied' || operation.status === 'unknown' ? operation.parent : undefined;
    const declaration = parent && schema && declarationOf(parent, schema);
    if (!parent || !declaration || declaration.allowsText) {
      continue;
    }
    for (const run of textNotAllowed(operation.element, text, structure.comments)) {
      report(
        'text-not-allowed',
        `The text '${shownText(text.slice(run.start, run.end))}' goes into '${parent.name}', which does not allow text`,
        run.start,
        run.end,
        DiagnosticSeverity.Warning
      );
    }
  }
  return result;
}

/**
 * The game's file a document merges into: for a file in an extension's `libraries` that is no patch, the
 * game's library file of its name, when the game has it. What the game does with a file of another name is
 * not known.
 */
export function mergeTargetOf(uri: string, index: ScriptIndex): PatchTarget | undefined {
  const file = fileOf(uri);
  const target = file !== undefined && index.isLibraryFile(file) ? index.patchTarget(file) : undefined;
  return target?.file === undefined ? undefined : target;
}

/**
 * Checks a merge file: the game adds the children of its root to the root of its file when the roots have
 * the same name, and skips the file when they do not, as it logs: "Root node name … is not 'diff' for patch
 * file or … for merge file".
 */
export function validateMergeFile(document: TextDocument, structure: XmlStructure, target: PatchTarget, index: ScriptIndex, source: string): Diagnostic[] {
  const root = structure.roots[0];
  const expected = target.file === undefined ? undefined : index.parsedFile(target.file)?.structure.roots[0]?.name;
  if (!root || expected === undefined || root.name === expected) {
    return [];
  }
  return [
    {
      range: Range.create(document.positionAt(root.nameStart), document.positionAt(root.nameEnd)),
      message: `The game skips this file: its root '${root.name}' is neither 'diff' for a patch nor '${expected}' for a merge into ${target.name}`,
      severity: DiagnosticSeverity.Error,
      code: 'library-root-mismatch',
      source,
    },
  ];
}

/** For a patch of a game file the game does not have: where a patch of an extension's file of that name goes. */
function hintFor(name: string, index: ScriptIndex | undefined): string {
  if (!index || name.startsWith('extensions/')) {
    return '';
  }
  const base = path.basename(name).toLowerCase();
  const kind = path.dirname(name);
  for (const entry of index.entries()) {
    if (
      entry.kind === 'script' &&
      entry.source !== 'game' &&
      path.basename(entry.file).toLowerCase() === base &&
      path.basename(path.dirname(entry.file)).toLowerCase() === kind
    ) {
      const folder = path.basename(path.dirname(path.dirname(entry.file)));
      return `; a patch of ${folder}'s file goes to extensions/${folder}/${kind}/${path.basename(entry.file)}`;
    }
  }
  return '';
}
