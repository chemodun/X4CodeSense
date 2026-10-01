/**
 * What calls call. `<run_script name="'order.x'">`, `<run_interrupt_script>`, `<start_script>`,
 * `<create_order id="'Attack'">`, `<run_actions ref="Lib">` and `<cue ref="md.Script.Lib">` pass
 * `<param name value>` children to the script, order or library they name, which declares them in its
 * `<params>`.
 *
 * Which elements call is the schemas' (their `param` takes a `value`); which attribute names the target
 * is said by the schemas' documentation only, so it is listed here. A target is resolved when it is
 * written literally: a script name or order id as a string (`'order.x'`), a library by its name or as
 * `md.Script.Library`. The declarations are read from the target's file as the index has it, the open
 * documents as the editor has them.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Location, Range } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { scriptSchemaOf } from '../analysis/positionContext';
import type { ScriptSchema } from '../types';
import { attributeNamed, type XmlAttribute, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import type { ScriptIndex } from './scriptIndex';

export type CallTargetKind = 'script' | 'order' | 'library';

interface CallSpec {
  attribute: string;
  kind: CallTargetKind;
}

/** The elements that call with `<param>`s, by script kind, and the attribute that names what they call. */
const calls: Record<ScriptSchema, ReadonlyMap<string, CallSpec>> = {
  aiscripts: new Map([
    ['run_script', { attribute: 'name', kind: 'script' }],
    ['run_interrupt_script', { attribute: 'name', kind: 'script' }],
    ['start_script', { attribute: 'name', kind: 'script' }],
    ['create_order', { attribute: 'id', kind: 'order' }],
  ]),
  md: new Map([
    ['run_actions', { attribute: 'ref', kind: 'library' }],
    ['cue', { attribute: 'ref', kind: 'library' }],
    ['start_script', { attribute: 'name', kind: 'script' }],
    ['create_order', { attribute: 'id', kind: 'order' }],
  ]),
};

/**
 * Elements whose `<param>`s pass values to what is not a script, order or library: the diplomacy action
 * `create_diplomacy_action_operation` names is one of the game's libraries.
 */
export const callsNotToScripts: readonly string[] = ['create_diplomacy_action_operation'];

/** The elements of a script kind that call a script, order or library with `<param>`s. */
export function callElements(schema: ScriptSchema): string[] {
  return [...calls[schema].keys()];
}

/** True when the element calls a script, order or library in a script of the kind. */
export function isCall(element: XmlElement, schema: ScriptSchema | undefined): boolean {
  const spec = schema && calls[schema].get(element.name);
  return spec !== undefined && attributeNamed(element, spec.attribute) !== undefined;
}

/** A parameter as its target declares it. */
export interface ParameterDeclaration {
  name: string;
  default?: string;
  /** An order parameter's `type`, `text`, `required`. */
  type?: string;
  text?: string;
  required?: string;
  comment?: string;
  /** Where its name is written. */
  location: Location;
}

/** What a call calls. */
export interface CallTarget {
  kind: CallTargetKind;
  /** As shown: `order.fight.attack.object`, `Attack`, `md.Setup.Reward`. */
  name: string;
  /** For an order, the script that defines it. */
  script?: string;
  parameters: ParameterDeclaration[];
  /** Where it is defined: the script's root, the order or the library. */
  location: Location;
  /** The file, and the source it belongs to. */
  file: string;
  source?: string;
}

interface Parsed {
  document: TextDocument;
  structure: XmlStructure;
}

const literalString = /^'([^'$%{}[\]]+)'$/;
const libraryReference = /^(?:md\.(\w+)\.)?(\w+)$/;

function nameOf(element: XmlElement, attribute = 'name'): string | undefined {
  const value = attributeNamed(element, attribute)?.value.trim();
  return value ? value : undefined;
}

function filePathOf(uri: string): string | undefined {
  try {
    return uri.startsWith('file:') ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

function sameFile(a: string | undefined, b: string): boolean {
  return a !== undefined && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// Per structure, which the index keeps while its file does not change: a check asks for every call of a document.
const documents = new WeakMap<XmlStructure, TextDocument>();
const libraries = new WeakMap<XmlStructure, Map<string, XmlElement>>();
/** The declared parameters by the element that declares them: a library, an order, a script's root. */
const declared = new WeakMap<XmlElement, ParameterDeclaration[]>();
const ownFiles = new WeakMap<TextDocument, string | undefined>();

/** The first library of each name in a structure. */
function librariesOf(structure: XmlStructure): Map<string, XmlElement> {
  let found = libraries.get(structure);
  if (!found) {
    found = new Map();
    for (const element of structure.elements) {
      const name = element.name === 'library' ? nameOf(element) : undefined;
      if (name !== undefined && !found.has(name)) {
        found.set(name, element);
      }
    }
    libraries.set(structure, found);
  }
  return found;
}

/** A file's text and structure: the analysed document's own when it is that file, else the index's. */
/** The file of the analysed document, worked out once per document. */
function ownFileOf(analysis: DocumentAnalysis): string | undefined {
  if (!ownFiles.has(analysis.document)) {
    ownFiles.set(analysis.document, filePathOf(analysis.document.uri));
  }
  return ownFiles.get(analysis.document);
}

function parsedFile(analysis: DocumentAnalysis, file: string, index: ScriptIndex | undefined): Parsed | undefined {
  if (analysis.structure && sameFile(ownFileOf(analysis), file)) {
    return { document: analysis.document, structure: analysis.structure };
  }
  const parsed = index?.parsedFile(file);
  if (!parsed) {
    return undefined;
  }
  let document = documents.get(parsed.structure);
  if (!document) {
    document = TextDocument.create(pathToFileURL(file).toString(), 'xml', 0, parsed.text);
    documents.set(parsed.structure, document);
  }
  return { document, structure: parsed.structure };
}

function locationOf(parsed: Parsed, start: number, end: number): Location {
  return Location.create(parsed.document.uri, Range.create(parsed.document.positionAt(start), parsed.document.positionAt(end)));
}

/** A call target with its location, worked out when first asked: the check of a whole document needs none. */
function withLocation(target: Omit<CallTarget, 'location'>, parsed: Parsed, start: number, end: number): CallTarget {
  let location: Location | undefined;
  return Object.defineProperty(target, 'location', { enumerable: true, get: () => (location ??= locationOf(parsed, start, end)) }) as CallTarget;
}

/** The trimmed value of an attribute as text offsets. */
export function valueRange(attribute: XmlAttribute): { start: number; end: number } {
  const raw = attribute.rawValue;
  const trimmed = raw.trim();
  const start = attribute.valueStart + Math.max(0, raw.indexOf(trimmed));
  return { start, end: start + trimmed.length };
}

/** The parameters an element declares, the `<param>`s `params` gives: worked out once per element. */
function declarations(parsed: Parsed, owner: XmlElement, params: () => readonly XmlElement[]): ParameterDeclaration[] {
  const known = declared.get(owner);
  if (known) {
    return known;
  }
  const result: ParameterDeclaration[] = [];
  declared.set(owner, result);
  for (const param of params()) {
    const attribute = param.name === 'param' ? attributeNamed(param, 'name') : undefined;
    const name = attribute?.value.trim();
    if (!attribute || !name) {
      continue;
    }
    const { start, end } = valueRange(attribute);
    // Worked out when asked: the check of a whole document needs the names only.
    let location: Location | undefined;
    const declaration = {
      name,
      get location(): Location {
        return (location ??= locationOf(parsed, start, end));
      },
    } as ParameterDeclaration;
    for (const key of ['default', 'type', 'text', 'required', 'comment'] as const) {
      const value = attributeNamed(param, key)?.value;
      if (value !== undefined) {
        declaration[key] = value;
      }
    }
    result.push(declaration);
  }
  return result;
}

const paramsOf = (element: XmlElement | undefined): XmlElement[] =>
  element?.children.filter((child) => child.name === 'params').flatMap((params) => params.children) ?? [];

/** The element that a `<param>` passes to, when it is a call. */
export function callOf(param: XmlElement, schema: ScriptSchema | undefined): XmlElement | undefined {
  const call = param.parent;
  return param.name === 'param' && call && isCall(call, schema) ? call : undefined;
}

/**
 * What a call calls, when it is written literally and found; undefined for other elements. A check of a
 * whole document passes `memo`: a target written the same way is found once.
 */
export function callTarget(
  analysis: DocumentAnalysis,
  call: XmlElement,
  index: ScriptIndex | undefined,
  memo?: Map<string, CallTarget | undefined>
): CallTarget | undefined {
  const schema = scriptSchemaOf(analysis);
  const spec = schema ? calls[schema].get(call.name) : undefined;
  const written = spec && nameOf(call, spec.attribute);
  if (!spec || !written) {
    return undefined;
  }
  const key = `${spec.kind}\n${written}`;
  if (memo?.has(key)) {
    return memo.get(key);
  }
  const target = resolve(analysis, spec.kind, written, index);
  memo?.set(key, target);
  return target;
}

function resolve(analysis: DocumentAnalysis, kind: CallTargetKind, written: string, index: ScriptIndex | undefined): CallTarget | undefined {
  if (kind === 'library') {
    const match = libraryReference.exec(written);
    if (!match) {
      return undefined;
    }
    const [, scriptName, libraryName] = match;
    const own = analysis.detection.script?.name;
    let parsed: Parsed | undefined;
    let library: XmlElement | undefined;
    let file: string | undefined;
    if ((scriptName === undefined || scriptName === own) && analysis.structure) {
      library = librariesOf(analysis.structure).get(libraryName);
      parsed = library && { document: analysis.document, structure: analysis.structure };
      // A document that is no file yet (untitled) still has its own libraries.
      file = ownFileOf(analysis) ?? '';
    }
    if (!library && index) {
      const found = index.cues(scriptName ?? own ?? '', libraryName).filter((cue) => cue.kind === 'library');
      const last = found[found.length - 1];
      parsed = last && parsedFile(analysis, last.position.file, index);
      library = parsed && librariesOf(parsed.structure).get(libraryName);
      file = last?.position.file;
    }
    if (!parsed || !library || file === undefined) {
      return undefined;
    }
    const { start, end } = valueRange(attributeNamed(library, 'name') as XmlAttribute);
    const source = index?.sourceOf(file);
    return withLocation(
      {
        kind: 'library',
        name: `md.${scriptName ?? own ?? '?'}.${libraryName}`,
        parameters: declarations(parsed, library, () => paramsOf(library)),
        file,
        ...(source ? { source } : {}),
      },
      parsed,
      start,
      end
    );
  }
  const match = literalString.exec(written);
  if (!match || !index) {
    return undefined;
  }
  const name = match[1];
  const scripts = kind === 'order' ? index.orderScripts(name) : index.scripts('aiscripts', name);
  // A later source replaces an earlier script of the same name.
  const script = scripts[scripts.length - 1];
  const parsed = script && parsedFile(analysis, script.file, index);
  const root = parsed?.structure.roots[0];
  if (!parsed || !root) {
    return undefined;
  }
  const source = index.sourceOf(script.file);
  if (kind === 'order') {
    const order = root.children.find((child) => child.name === 'order' && nameOf(child, 'id') === name);
    if (!order) {
      return undefined;
    }
    const { start, end } = valueRange(attributeNamed(order, 'id') as XmlAttribute);
    // An order's own parameters, else the script's.
    const params = (): XmlElement[] => (paramsOf(order).length > 0 ? paramsOf(order) : paramsOf(root));
    return withLocation(
      { kind: 'order', name, script: script.name, parameters: declarations(parsed, order, params), file: script.file, ...(source ? { source } : {}) },
      parsed,
      start,
      end
    );
  }
  // A script's parameters: its own, and those of the order it defines.
  const params = (): XmlElement[] => [...paramsOf(root), ...root.children.filter((child) => child.name === 'order').flatMap((order) => paramsOf(order))];
  const nameAttribute = attributeNamed(root, 'name');
  const at = nameAttribute ? valueRange(nameAttribute) : { start: root.start, end: root.start };
  return withLocation(
    { kind: 'script', name, parameters: declarations(parsed, root, params), file: script.file, ...(source ? { source } : {}) },
    parsed,
    at.start,
    at.end
  );
}

/** How a call target is named in a message: "order 'Attack' of 'order.fight.attack.object'". */
export function callTargetLabel(target: CallTarget, quote: (text: string) => string = (text) => `'${text}'`): string {
  switch (target.kind) {
    case 'order':
      return `order ${quote(target.name)} of ${quote(target.script ?? '?')}`;
    case 'library':
      return `library ${quote(target.name)}`;
    default:
      return `script ${quote(target.name)}`;
  }
}
