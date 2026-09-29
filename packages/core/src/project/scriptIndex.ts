/**
 * The scripts of the game and of the extensions, indexed by name, so a script can refer to another:
 * `md.<Script>.<Cue>` in Mission Director expressions, and interrupt library actions, handlers and
 * conditions, which AI scripts share by globally unique names.
 *
 * Each file is read with the tolerant scanner alone, so indexing needs no schema and costs little per
 * file. An extension's `<diff>` in its `md` or `aiscripts` patches the game's file of the same name, one
 * in its `extensions/<folder>/md` the named extension's (see `scriptFolders`); the cues and library items
 * it adds anywhere inside `add` and `replace` count for that script. What exactly a patch changes is
 * worked out by the patch support (`patches/`).
 *
 * Several definitions of a name are all kept, in load order: the game first, then the extensions in
 * the order `findExtensions` gives.
 *
 * Variables: an interrupt library item runs in the script that uses it, so the variables it sets are
 * set for that script; with the schemas at hand they are indexed with the item. The variables of a cue
 * (`md.<Script>.<Cue>.$x`) are worked out for a script file when first asked for, since doing so for
 * every file would triple the time to build the index. From the scan alone come the libraries of other
 * scripts a Mission Director script includes, instantiates or runs, and, with the schemas, the
 * variables it writes into cues it gets as values (`$Cue.$x`, `event.param.$x`).
 *
 * References: with the schemas, each file records the names it uses that other files define, with the
 * position of each: the parts of `md.<Script>.<Cue>.$x`, and interrupt library references. With where
 * each script, cue and library item has its name, that is what find references and rename need across
 * files. What a script refers to without naming the script (a cue's bare name, a variable in its cue) is
 * worked out for a file when first asked for, like the variables of a cue.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { findExtensions } from '../extensions/extensions';
import { collectNames, referenceKindOf, type DocumentNames } from '../names/namedItems';
import { detectDocument } from '../scripts/scriptMetadata';
import type { ScriptSchema } from '../types';
import { collectVariables, receivesValue, type DocumentVariables } from '../variables/variables';
import { attributeNamed, offsetInValue, parseXml, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import type { SchemaSet } from '../xsd/loadSchemas';
import { isExpressionAttribute, type XsdElement, type XsdSchema } from '../xsd/schema';
import { mdReferencesInAttribute } from './mdReferences';

/** Where something is defined: a file and a zero-based position. */
export interface IndexedPosition {
  file: string;
  line: number;
  character: number;
}

export interface IndexedCue {
  name: string;
  kind: 'cue' | 'library';
  /** Name of the cue or library it is nested in. */
  parent?: string;
  instantiate: boolean;
  namespace?: string;
  /** `purpose` of a library: `run_actions`, `include_actions`, … */
  purpose?: string;
  /** The library a cue instantiates. */
  ref?: string;
  /** `<param name>` of a library, or given to a cue that instantiates one. */
  params: string[];
  position: IndexedPosition;
  /** Where the value of its `name` attribute starts. */
  namePosition: IndexedPosition;
  /** The patch file that adds it, when it is not in the script's own file. */
  patch?: string;
}

export type IndexedLibraryKind = 'actions' | 'handler' | 'conditions';

/** A variable that something sets, with where it is set first. */
export interface IndexedVariable {
  name: string;
  position: IndexedPosition;
}

export interface IndexedLibraryItem {
  kind: IndexedLibraryKind;
  name: string;
  /** Name of the AI script that defines it. */
  script: string;
  position: IndexedPosition;
  /** Where the value of its `name` attribute starts. */
  namePosition: IndexedPosition;
  patch?: string;
  /** Variables it sets, which count as set in the script that uses it; empty when indexed without the schemas. */
  variables: IndexedVariable[];
}

/** What a reference names: a Mission Director script, a cue of one, a variable of that cue, or an interrupt library item. */
export type IndexedReferenceKind = 'script' | 'cue' | 'variable' | IndexedLibraryKind;

/** A name a file uses that may be defined in another file. */
export interface IndexedReference {
  kind: IndexedReferenceKind;
  /** The script of `md.<Script>`, `md.<Script>.<Cue>` and `md.<Script>.<Cue>.$x`. */
  script?: string;
  /** The cue of `md.<Script>.<Cue>` and `md.<Script>.<Cue>.$x`. */
  cue?: string;
  /** The name itself: of the script, the cue, the variable (without `$`) or the library item. */
  name: string;
  /** Where the name starts; for a variable, where its `$` is. */
  position: IndexedPosition;
}

export interface IndexedScript {
  kind: 'script';
  file: string;
  /** `game`, or the id of the extension the file belongs to. */
  source: string;
  schema: ScriptSchema;
  name: string;
  position: IndexedPosition;
  /** Where the value of the root's `name` attribute starts, when it has one. */
  namePosition?: IndexedPosition;
  cues: IndexedCue[];
  libraryItems: IndexedLibraryItem[];
  /** `<param name>` of an AI script or order. */
  params: string[];
  /** Variables a Mission Director script writes into cues it gets as values; empty when indexed without the schemas. */
  writesThroughValues: string[];
  /** Libraries of other scripts a Mission Director script splices in: `<include_actions ref="md.Script.Library">`. */
  includes: string[];
  /** Libraries of other scripts a Mission Director script instantiates (`<cue ref>`) or runs (`<run_actions ref>`). */
  instantiates: string[];
  /** Names it uses that other files may define; empty when indexed without the schemas. */
  references: IndexedReference[];
}

export interface IndexedPatch {
  kind: 'patch';
  file: string;
  source: string;
  schema: ScriptSchema;
  cues: IndexedCue[];
  libraryItems: IndexedLibraryItem[];
  writesThroughValues: string[];
  includes: string[];
  instantiates: string[];
  references: IndexedReference[];
}

export type IndexedFile = IndexedScript | IndexedPatch;

/** A script file to index, with the source it belongs to. */
export interface ScriptSource {
  file: string;
  source: string;
}

/** The folder whose files the patches in a script folder change. */
export interface PatchedFolder {
  /** How the patches' location names it: `md`, `extensions/<folder>/aiscripts`. */
  name: string;
  /** The folder; absent when the extension it names is not among the extensions read. */
  folder?: string;
  /** The extension folder name of `extensions/<folder>/...`. */
  extension?: string;
}

/** A folder of scripts or patches, with the source it belongs to. */
export interface ScriptFolder {
  folder: string;
  source: string;
  /** For an extension's folders: where the patches in it apply. */
  patches?: PatchedFolder;
}

/** The file a patch changes, or why there is none. */
export interface PatchTarget {
  /** The target file when it is indexed. */
  file?: string;
  /** How the patch names it: `md/setup.xml`, `extensions/other_mod/md/api.xml`. */
  name: string;
  /** Why there is no target file: the game or the extension has no such file, or the extension is not read. */
  missing?: string;
}

const libraryKinds: ReadonlySet<string> = new Set(['actions', 'handler', 'conditions']);

function keyOf(file: string): string {
  return path.resolve(file).toLowerCase();
}

/** Zero-based line and character of offsets, in any order. */
function positionCounter(text: string): (offset: number) => { line: number; character: number } {
  let starts: number[] | undefined;
  return (offset) => {
    if (!starts) {
      starts = [0];
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
        starts.push(at + 1);
      }
    }
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low, character: offset - starts[low] };
  };
}

function nameOf(element: XmlElement): string | undefined {
  const name = attributeNamed(element, 'name')?.value.trim();
  return name ? name : undefined;
}

/** Text offset where the trimmed value of the element's `name` attribute starts. */
function nameOffset(element: XmlElement): number {
  const attribute = attributeNamed(element, 'name');
  if (!attribute) {
    return element.start;
  }
  const value = attribute.value;
  return offsetInValue(attribute, value.length - value.trimStart().length);
}

/**
 * The declaration of an element of a scanned script, by its place under its parent's declaration as
 * validation finds it, else by its name; memoized in the map.
 */
function declarationIn(element: XmlElement, xsd: XsdSchema, known: Map<XmlElement, XsdElement | undefined>): XsdElement | undefined {
  if (known.has(element)) {
    return known.get(element);
  }
  const parent = element.parent ? declarationIn(element.parent, xsd, known) : undefined;
  const declaration = (element.parent ? parent?.child(element.name) : xsd.root(element.name)) ?? xsd.anyDeclaration(element.name);
  known.set(element, declaration);
  return declaration;
}

/** The declarations of every element of a scanned script, as `declarationIn` finds them. */
function declarationsOf(structure: XmlStructure, xsd: XsdSchema): Map<XmlElement, XsdElement> {
  const known = new Map<XmlElement, XsdElement | undefined>();
  const declarations = new Map<XmlElement, XsdElement>();
  for (const element of structure.elements) {
    const declaration = declarationIn(element, xsd, known);
    if (declaration) {
      declarations.set(element, declaration);
    }
  }
  return declarations;
}

function paramNames(elements: readonly XmlElement[]): string[] {
  return elements.filter((element) => element.name === 'param').flatMap((param) => nameOf(param) ?? []);
}

/** The schema of a script file by its folder, for patches, whose root says nothing about it. */
function schemaOfFolder(file: string): ScriptSchema | undefined {
  const folder = path.basename(path.dirname(file)).toLowerCase();
  return folder === 'md' ? 'md' : folder === 'aiscripts' ? 'aiscripts' : undefined;
}

/** The variables of a scanned script, with declarations taken from the schema by element name: no validation pass is needed. */
function variablesOf(structure: XmlStructure, schema: ScriptSchema, xsd: XsdSchema): DocumentVariables {
  return collectVariables({ structure, declarations: new Map() }, schema, xsd, undefined);
}

/** The variables each interrupt library item sets, by the item's start tag. */
function libraryItemVariables(file: string, text: string, structure: XmlStructure, xsd: XsdSchema): Map<XmlElement, IndexedVariable[]> {
  const result = new Map<XmlElement, IndexedVariable[]>();
  const position = positionCounter(text);
  const variables = variablesOf(structure, 'aiscripts', xsd);
  for (const occurrence of variables.occurrences) {
    if (occurrence.kind !== 'definition') {
      continue;
    }
    let item: XmlElement | undefined;
    for (let current: XmlElement | undefined = occurrence.element; current; current = current.parent) {
      if (libraryKinds.has(current.name) && current.parent?.name === 'library' && current.parent.parent?.name === 'interrupts') {
        item = current;
        break;
      }
    }
    if (!item) {
      continue;
    }
    const list = result.get(item) ?? [];
    if (!list.some((variable) => variable.name === occurrence.name)) {
      list.push({ name: occurrence.name, position: { file, ...position(occurrence.start) } });
    }
    result.set(item, list);
  }
  return result;
}

/**
 * The variable an attribute value names through a value, as `$Cue.$x`, `event.param.$x`,
 * `event.param.{1}.$x` or `md.Script.Cue.$x` do; undefined for a bare `$x` and for an object written
 * as one name (`this.$x`, `Cue.$x`), which the script itself resolves.
 */
function nameThroughValue(value: string): string | undefined {
  if (!value.includes('.$')) {
    return undefined;
  }
  const match = /^\s*([^]+?)\.\$([A-Za-z_]\w*)\s*$/.exec(value);
  return match && !/^[A-Za-z_]\w*$/.test(match[1].trim()) ? match[2] : undefined;
}

/** Adds the variables an element writes through values, going by what the schema says its attributes receive. */
function addWritesThroughValues(element: XmlElement, xsd: XsdSchema, into: Set<string>): void {
  let declaration: XsdElement | undefined | null = null;
  for (const attribute of element.attributes) {
    const name = nameThroughValue(attribute.value);
    if (name === undefined) {
      continue;
    }
    declaration = declaration === null ? xsd.anyDeclaration(element.name) : declaration;
    if (receivesValue(declaration?.attributes.get(attribute.name), element)) {
      into.add(name);
    }
  }
}

/** Adds the references of an element's attributes to other files' names, going by what the schema says each attribute is. */
function addReferences(
  element: XmlElement,
  schema: ScriptSchema,
  xsd: XsdSchema,
  declarations: Map<XmlElement, XsdElement | undefined>,
  at: (offset: number) => IndexedPosition,
  into: IndexedReference[]
): void {
  for (const attribute of element.attributes) {
    if (attribute.quote === '') {
      continue;
    }
    if (schema === 'md') {
      if (!attribute.value.includes('md.') || !isExpressionAttribute(declarationIn(element, xsd, declarations)?.attributes.get(attribute.name))) {
        continue;
      }
      for (const reference of mdReferencesInAttribute(element, attribute)) {
        const script = reference.script;
        into.push({ kind: 'script', name: script, position: at(reference.scriptStart) });
        if (reference.cue !== undefined && reference.cueStart !== undefined) {
          const cue = reference.cue;
          into.push({ kind: 'cue', script, name: cue, position: at(reference.cueStart) });
          if (reference.variable !== undefined && reference.variableStart !== undefined) {
            into.push({ kind: 'variable', script, cue, name: reference.variable, position: at(reference.variableStart) });
          }
        }
      }
      continue;
    }
    const kind = referenceKindOf(element, attribute.name, declarationIn(element, xsd, declarations)?.attributes.get(attribute.name));
    const name = attribute.value.trim();
    if (kind && kind !== 'label' && kind !== 'cue' && name !== '') {
      into.push({ kind, name, position: at(offsetInValue(attribute, attribute.value.indexOf(name))) });
    }
  }
}

/**
 * What a file contributes to the index, from its scanned structure; undefined for anything but a script
 * or a script patch. With the schemas, the variables of AI script interrupt library items and those
 * Mission Director scripts write through values are indexed too, and so are the references to names
 * other files may define.
 */
export function indexStructure(
  file: string,
  text: string,
  structure: XmlStructure,
  source: string,
  schemas: Partial<Record<ScriptSchema, XsdSchema>> = {}
): IndexedFile | undefined {
  const xsd = schemas.aiscripts;
  const root = structure.roots[0];
  if (!root) {
    return undefined;
  }
  const position = positionCounter(text);
  const atOffset = (offset: number): IndexedPosition => ({ file, ...position(offset) });
  const at = (element: XmlElement): IndexedPosition => atOffset(element.start);
  const patch = root.name === 'diff';
  const schema: ScriptSchema | undefined = patch ? schemaOfFolder(file) : root.name === 'mdscript' ? 'md' : root.name === 'aiscript' ? 'aiscripts' : undefined;
  if (!schema) {
    return undefined;
  }
  const scriptName = patch ? '' : (nameOf(root) ?? '');
  const cues: IndexedCue[] = [];
  const libraryItems: IndexedLibraryItem[] = [];
  const params: string[] = [];
  let itemVariables: Map<XmlElement, IndexedVariable[]> | undefined;
  const itemsWithElements: [IndexedLibraryItem, XmlElement][] = [];
  const variablesOfItem = (element: XmlElement): IndexedVariable[] => {
    if (!xsd) {
      return [];
    }
    itemVariables ??= libraryItemVariables(file, text, structure, xsd);
    return itemVariables.get(element) ?? [];
  };
  // In a patch only what `add` and `replace` bring counts.
  const counts = (element: XmlElement): boolean => {
    if (!patch) {
      return true;
    }
    for (let current = element.parent; current; current = current.parent) {
      if (current.parent === root) {
        return current.name === 'add' || current.name === 'replace';
      }
    }
    return false;
  };
  const writes = new Set<string>();
  const includes = new Set<string>();
  const instantiates = new Set<string>();
  const references: IndexedReference[] = [];
  const mdXsd = schema === 'md' ? schemas.md : undefined;
  const ownXsd = schemas[schema];
  const declarations = new Map<XmlElement, XsdElement | undefined>();
  for (const element of structure.elements) {
    if (!counts(element)) {
      continue;
    }
    if (mdXsd) {
      addWritesThroughValues(element, mdXsd, writes);
    }
    if (ownXsd) {
      addReferences(element, schema, ownXsd, declarations, atOffset, references);
    }
    if (schema === 'md' && (element.name === 'include_actions' || element.name === 'cue' || element.name === 'run_actions')) {
      const ref = attributeNamed(element, 'ref')?.value.trim();
      if (ref?.startsWith('md.')) {
        (element.name === 'include_actions' ? includes : instantiates).add(ref);
      }
    }
    if (schema === 'md' && (element.name === 'cue' || element.name === 'library')) {
      const name = nameOf(element);
      if (!name) {
        continue;
      }
      const cue: IndexedCue = {
        name,
        kind: element.name === 'library' ? 'library' : 'cue',
        instantiate: attributeNamed(element, 'instantiate')?.value === 'true',
        params:
          element.name === 'library' ? paramNames(element.children.find((child) => child.name === 'params')?.children ?? []) : paramNames(element.children),
        position: at(element),
        namePosition: atOffset(nameOffset(element)),
      };
      for (let current = element.parent; current; current = current.parent) {
        if ((current.name === 'cue' || current.name === 'library') && nameOf(current)) {
          cue.parent = nameOf(current);
          break;
        }
      }
      for (const [attribute, key] of [
        ['namespace', 'namespace'],
        ['purpose', 'purpose'],
        ['ref', 'ref'],
      ] as const) {
        const value = attributeNamed(element, attribute)?.value.trim();
        if (value) {
          cue[key] = value;
        }
      }
      if (patch) {
        cue.patch = file;
      }
      cues.push(cue);
    } else if (schema === 'aiscripts' && libraryKinds.has(element.name) && element.parent?.name === 'library' && element.parent.parent?.name === 'interrupts') {
      const name = nameOf(element);
      if (name) {
        const item: IndexedLibraryItem = {
          kind: element.name as IndexedLibraryKind,
          name,
          script: scriptName,
          position: at(element),
          namePosition: atOffset(nameOffset(element)),
          variables: [],
        };
        itemsWithElements.push([item, element]);
        if (patch) {
          item.patch = file;
        }
        libraryItems.push(item);
      }
    } else if (schema === 'aiscripts' && !patch && element.name === 'params') {
      params.push(...paramNames(element.children));
    }
  }
  // After the scan: the positions of variables are counted in a pass of their own.
  for (const [item, element] of itemsWithElements) {
    item.variables = variablesOfItem(element);
  }
  const writesThroughValues = [...writes].sort();
  const uses = { writesThroughValues, includes: [...includes].sort(), instantiates: [...instantiates].sort(), references };
  if (patch) {
    return { kind: 'patch', file, source, schema, cues, libraryItems, ...uses };
  }
  const script: IndexedScript = { kind: 'script', file, source, schema, name: scriptName, position: at(root), cues, libraryItems, params, ...uses };
  if (scriptName !== '') {
    script.namePosition = atOffset(nameOffset(root));
  }
  return script;
}

/** What other scripts can see of a file: when it changes, scripts that refer to it are checked again. */
function signatureOf(entry: IndexedFile | undefined): string {
  if (!entry) {
    return '';
  }
  const cues = entry.cues.map((cue) => `${cue.kind}:${cue.name}:${cue.params.join(',')}`).join(';');
  const items = entry.libraryItems.map((item) => `${item.kind}:${item.name}:${item.variables.map((variable) => variable.name).join(',')}`).join(';');
  const uses = `${entry.writesThroughValues.join(',')}|${entry.includes.join(',')}|${entry.instantiates.join(',')}`;
  return entry.kind === 'script'
    ? `${entry.schema}|${entry.name}|${cues}|${items}|${entry.params.join(',')}|${uses}`
    : `${entry.schema}|patch|${cues}|${items}|${uses}`;
}

/** A script file as the index works it out when first asked: its text, variables and named items. */
export interface IndexedFileModel {
  file: string;
  schema: ScriptSchema;
  /** The editor's text of an open file, else the text on disk when the model was made. */
  text: string;
  /** Zero-based line and character of a text offset. */
  positionAt(offset: number): { line: number; character: number };
  readonly variables: DocumentVariables;
  readonly names: DocumentNames;
}

/** The lookup key of what a reference names. */
function referenceKey(kind: IndexedReferenceKind, name: string, script = '', cue = ''): string {
  switch (kind) {
    case 'script':
      return `script:${name}`;
    case 'cue':
      return `cue:${script}.${name}`;
    case 'variable':
      return `variable:${script}.${cue}.${name}`;
    default:
      return `${kind}:${name}`;
  }
}

interface Lookups {
  scripts: Map<string, IndexedScript[]>;
  cues: Map<IndexedScript, IndexedCue[]>;
  libraryItems: Map<string, IndexedLibraryItem[]>;
  writesThroughValues: Set<string>;
  /** Scripts that include a library, by `md.Script.Library`; a patch counts as a script without a name. */
  includers: Map<string, Set<string>>;
  /** Scripts that instantiate or run a library, the same way. */
  instantiators: Map<string, Set<string>>;
  /** The patches of each script file, by its key, in load order. */
  patches: Map<string, IndexedPatch[]>;
}

export class ScriptIndex {
  private readonly files = new Map<string, IndexedFile>();
  /** Script folders read by `loadScriptIndex`, with the source of each and where their patches apply. */
  private readonly folders = new Map<string, ScriptFolder>();
  /** The load order of the sources, by the order their folders were added. */
  private readonly sourceOrder = new Map<string, number>();
  /** Texts of files an editor holds, which may differ from the disk. */
  private readonly texts = new Map<string, string>();
  /** Models of script files, worked out when first asked for. */
  private readonly models = new Map<string, IndexedFileModel | undefined>();
  /** Scanned files for the patch support, by key, until they change. */
  private readonly parsed = new Map<string, { text: string; structure: XmlStructure }>();
  private lookups: Lookups | undefined;
  /** References of every file by what they name, built when first asked for. */
  private referenceLookup: Map<string, IndexedReference[]> | undefined;
  /** Answers of `cueVariables` by `Script.Cue`, until any file changes. */
  private readonly cueVariableLists = new Map<string, IndexedVariable[]>();

  /** With the schemas, variables are indexed as well. */
  constructor(private readonly schemas?: SchemaSet) {}

  /** Indexes a file from its text; returns true when what other scripts see of it changed. */
  setText(file: string, text: string, source: string): boolean {
    return this.setStructure(file, text, parseXml(text), source);
  }

  /**
   * Indexes a file from its already scanned structure; returns true when what other scripts see of it
   * changed. `fromEditor` keeps the text, so questions about the file are answered from it and not from
   * the disk.
   */
  setStructure(file: string, text: string, structure: XmlStructure, source: string, fromEditor = false): boolean {
    const key = keyOf(file);
    const before = signatureOf(this.files.get(key));
    const entry = indexStructure(file, text, structure, source, this.schemas?.schemas);
    if (entry) {
      this.files.set(key, entry);
    } else {
      this.files.delete(key);
    }
    if (fromEditor) {
      this.texts.set(key, text);
      // Already scanned: a patch of this file can use it as it is.
      this.parsed.set(key, { text, structure });
    } else {
      this.texts.delete(key);
      this.parsed.delete(key);
    }
    this.models.delete(key);
    this.cueVariableLists.clear();
    this.lookups = undefined;
    this.referenceLookup = undefined;
    return signatureOf(entry) !== before;
  }

  /** Forgets a file; returns true when it was indexed. */
  removeFile(file: string): boolean {
    const key = keyOf(file);
    const removed = this.files.delete(key);
    this.texts.delete(key);
    this.parsed.delete(key);
    this.models.delete(key);
    this.cueVariableLists.clear();
    if (removed) {
      this.lookups = undefined;
      this.referenceLookup = undefined;
    }
    return removed;
  }

  /** The text of a file as it is now: the editor's for an open file, else read from the disk; undefined when it cannot be read. */
  currentText(file: string): string | undefined {
    const text = this.texts.get(keyOf(file));
    if (text !== undefined) {
      return text;
    }
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * The model of an indexed script file, from the editor's text or the disk, with declarations found as
   * validation finds them; undefined without the schemas, for a patch, or when the file cannot be read.
   */
  fileModel(file: string): IndexedFileModel | undefined {
    const key = keyOf(file);
    if (!this.models.has(key)) {
      this.models.set(key, this.makeModel(key));
    }
    return this.models.get(key);
  }

  private makeModel(key: string): IndexedFileModel | undefined {
    const entry = this.files.get(key);
    const xsd = entry?.kind === 'script' ? this.schemas?.schemas[entry.schema] : undefined;
    const text = entry && xsd ? this.currentText(entry.file) : undefined;
    if (!entry || !xsd || text === undefined) {
      return undefined;
    }
    const structure = parseXml(text);
    const source = { structure, declarations: declarationsOf(structure, xsd), detection: detectDocument(text) };
    const schema = entry.schema;
    let variables: DocumentVariables | undefined;
    let names: DocumentNames | undefined;
    return {
      file: entry.file,
      schema,
      text,
      positionAt: positionCounter(text),
      get variables(): DocumentVariables {
        return (variables ??= collectVariables(source, schema, xsd, undefined));
      },
      get names(): DocumentNames {
        return (names ??= collectNames(source, schema, xsd, undefined));
      },
    };
  }

  /** Names of the variables read or set in the table of a Mission Director cue or library, in every script of that name. */
  cueVariableUses(scriptName: string, cueName: string): Set<string> {
    const uses = new Set<string>();
    for (const script of this.scripts('md', scriptName)) {
      const table = this.fileModel(script.file)?.variables.tables.find(
        (candidate) => (candidate.kind === 'cue' || candidate.kind === 'library') && candidate.name === cueName
      );
      for (const name of table?.variables.keys() ?? []) {
        uses.add(name);
      }
    }
    return uses;
  }

  /** Names of the variables read or set inside an interrupt library item. */
  libraryItemUses(item: IndexedLibraryItem): Set<string> {
    const uses = new Set<string>();
    const model = this.fileModel(item.position.file);
    const element = model?.names.items.find((candidate) => candidate.kind === item.kind && candidate.name === item.name && candidate.definitions.length > 0)
      ?.definitions[0].element;
    if (!model || !element) {
      return uses;
    }
    for (const occurrence of model.variables.occurrences) {
      for (let current: XmlElement | undefined = occurrence.element; current; current = current.parent) {
        if (current === element) {
          uses.add(occurrence.name);
          break;
        }
      }
    }
    return uses;
  }

  /**
   * The variables a cue of a Mission Director script has in its own table (`md.<Script>.<Cue>.$x`),
   * each with where it is set first; for every script of that name. The libraries of the script that the
   * cue includes, and those they include, set variables in its table too.
   */
  cueVariables(scriptName: string, cueName: string): IndexedVariable[] {
    const key = `${scriptName}.${cueName}`;
    let found = this.cueVariableLists.get(key);
    if (!found) {
      found = this.findCueVariables(scriptName, cueName);
      this.cueVariableLists.set(key, found);
    }
    return found;
  }

  private findCueVariables(scriptName: string, cueName: string): IndexedVariable[] {
    const found: IndexedVariable[] = [];
    for (const script of this.scripts('md', scriptName)) {
      const model = this.fileModel(script.file);
      const table = model?.variables.tables.find((candidate) => (candidate.kind === 'cue' || candidate.kind === 'library') && candidate.name === cueName);
      if (!model || !table) {
        continue;
      }
      const position = model.positionAt;
      const tables = new Set([table]);
      for (const current of tables) {
        for (const variable of current.variables.values()) {
          const first = variable.definitions[0];
          if (first && !found.some((known) => known.name === variable.name)) {
            found.push({ name: variable.name, position: { file: script.file, ...position(first.start) } });
          }
        }
        for (const included of current.includes) {
          tables.add(included);
        }
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  hasFile(file: string): boolean {
    return this.files.has(keyOf(file));
  }

  /** The source a file belongs to: its own when indexed, else the one of the script folder it lies in. */
  sourceOf(file: string): string | undefined {
    return this.files.get(keyOf(file))?.source ?? this.folders.get(keyOf(path.dirname(file)))?.source;
  }

  /** Records a script folder read for a source, so files created in it later are indexed too; sources load in the order they are added. */
  addFolder(folder: ScriptFolder): void {
    this.folders.set(keyOf(folder.folder), folder);
    if (!this.sourceOrder.has(folder.source)) {
      this.sourceOrder.set(folder.source, this.sourceOrder.size);
    }
  }

  /**
   * The file a patch in an extension's script folder changes: the game's file of the same name, or for
   * `extensions/<folder>/...` the named extension's. Undefined for a file in no such folder, and for the
   * game's own folders.
   */
  patchTarget(file: string): PatchTarget | undefined {
    const patches = this.folders.get(keyOf(path.dirname(file)))?.patches;
    if (!patches) {
      return undefined;
    }
    const name = `${patches.name}/${path.basename(file)}`;
    if (!patches.folder) {
      return { name, missing: `the extension '${patches.extension ?? ''}' is not among the extensions read` };
    }
    const target = path.join(patches.folder, path.basename(file));
    const entry = this.files.get(keyOf(target));
    if (entry?.kind !== 'script') {
      return {
        name,
        missing: patches.extension
          ? `the extension '${patches.extension}' has no ${patches.name.split('/').pop() ?? ''}/${path.basename(file)}`
          : `the game has no ${name}`,
      };
    }
    return { file: entry.file, name };
  }

  /** The patches of a file, in load order. */
  patchesOf(target: string): IndexedPatch[] {
    return this.lookup().patches.get(keyOf(target)) ?? [];
  }

  /** The patches of the same file that the game applies before this patch: those of sources loaded earlier. */
  patchesBefore(patch: string, target: string): IndexedPatch[] {
    const order = this.orderOf(this.sourceOf(patch) ?? '');
    return this.patchesOf(target).filter((earlier) => this.orderOf(earlier.source) < order && keyOf(earlier.file) !== keyOf(patch));
  }

  /** The text and scanned structure of a file as it is now (editor or disk), kept until it changes; undefined when it cannot be read. */
  parsedFile(file: string): { text: string; structure: XmlStructure } | undefined {
    const key = keyOf(file);
    let parsed = this.parsed.get(key);
    if (!parsed) {
      const text = this.currentText(file);
      if (text === undefined) {
        return undefined;
      }
      parsed = { text, structure: parseXml(text) };
      this.parsed.set(key, parsed);
    }
    return parsed;
  }

  private orderOf(source: string): number {
    return this.sourceOrder.get(source) ?? this.sourceOrder.size;
  }

  get size(): number {
    return this.files.size;
  }

  entries(): IterableIterator<IndexedFile> {
    return this.files.values();
  }

  private lookup(): Lookups {
    if (!this.lookups) {
      const scripts = new Map<string, IndexedScript[]>();
      const cues = new Map<IndexedScript, IndexedCue[]>();
      const libraryItems = new Map<string, IndexedLibraryItem[]>();
      const patches = new Map<string, IndexedPatch[]>();
      const writesThroughValues = new Set<string>();
      const includers = new Map<string, Set<string>>();
      const instantiators = new Map<string, Set<string>>();
      const addUser = (users: Map<string, Set<string>>, ref: string, entry: IndexedFile): void => {
        const scripts = users.get(ref) ?? new Set<string>();
        scripts.add(entry.kind === 'script' ? entry.name : '');
        users.set(ref, scripts);
      };
      for (const entry of this.files.values()) {
        for (const name of entry.writesThroughValues) {
          writesThroughValues.add(name);
        }
        for (const ref of entry.includes) {
          addUser(includers, ref, entry);
        }
        for (const ref of entry.instantiates) {
          addUser(instantiators, ref, entry);
        }
      }
      const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
        const list = map.get(key);
        if (list) {
          list.push(value);
        } else {
          map.set(key, [value]);
        }
      };
      for (const entry of this.files.values()) {
        if (entry.kind !== 'script') {
          continue;
        }
        push(scripts, `${entry.schema}:${entry.name}`, entry);
        cues.set(entry, [...entry.cues]);
        for (const item of entry.libraryItems) {
          push(libraryItems, `${item.kind}:${item.name}`, item);
        }
      }
      const inLoadOrder = [...this.files.values()]
        .filter((entry): entry is IndexedPatch => entry.kind === 'patch')
        .sort((a, b) => this.orderOf(a.source) - this.orderOf(b.source) || a.file.localeCompare(b.file));
      for (const entry of inLoadOrder) {
        const targetFile = this.patchTarget(entry.file)?.file;
        const target = targetFile === undefined ? undefined : this.files.get(keyOf(targetFile));
        if (target?.kind !== 'script' || target.schema !== entry.schema) {
          continue;
        }
        push(patches, keyOf(target.file), entry);
        cues.get(target)?.push(...entry.cues);
        for (const item of entry.libraryItems) {
          push(libraryItems, `${item.kind}:${item.name}`, { ...item, script: target.name });
        }
      }
      this.lookups = { scripts, cues, libraryItems, writesThroughValues, includers, instantiators, patches };
    }
    return this.lookups;
  }

  /** True when another Mission Director script splices the library in with `<include_actions ref="md.Script.Library">`. */
  isIncludedByOtherScripts(scriptName: string, libraryName: string): boolean {
    const scripts = this.lookup().includers.get(`md.${scriptName}.${libraryName}`);
    return scripts !== undefined && [...scripts].some((name) => name !== scriptName);
  }

  /** True when another Mission Director script instantiates the library (`<cue ref>`) or runs it (`<run_actions ref>`). */
  isUsedByOtherScripts(scriptName: string, libraryName: string): boolean {
    const scripts = this.lookup().instantiators.get(`md.${scriptName}.${libraryName}`);
    return scripts !== undefined && [...scripts].some((name) => name !== scriptName);
  }

  /**
   * True when a Mission Director script writes the variable into a cue it gets as a value (`$Cue.$x`,
   * `event.param.$x`, `md.Script.Cue.$x`): any cue may then have it without setting it itself.
   */
  isWrittenThroughValues(name: string): boolean {
    return this.lookup().writesThroughValues.has(name);
  }

  /** Scripts of a kind with a name, in load order. */
  scripts(schema: ScriptSchema, name: string): IndexedScript[] {
    return this.lookup().scripts.get(`${schema}:${name}`) ?? [];
  }

  /** Names of the scripts of a kind, sorted. */
  scriptNames(schema: ScriptSchema): string[] {
    const prefix = `${schema}:`;
    return [...this.lookup().scripts.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort((a, b) => a.localeCompare(b));
  }

  /** The cues and libraries of a Mission Director script: its own, then those its patches add. */
  cuesOf(script: IndexedScript): IndexedCue[] {
    return this.lookup().cues.get(script) ?? [];
  }

  /** The cues of every script with the name that are called so. */
  cues(scriptName: string, cueName: string): IndexedCue[] {
    return this.scripts('md', scriptName).flatMap((script) => this.cuesOf(script).filter((cue) => cue.name === cueName));
  }

  /** Interrupt library items of a kind with a name, from every AI script and patch. */
  libraryItems(kind: IndexedLibraryKind, name: string): IndexedLibraryItem[] {
    return this.lookup().libraryItems.get(`${kind}:${name}`) ?? [];
  }

  /** Names of the interrupt library items of a kind, sorted. */
  libraryItemNames(kind: IndexedLibraryKind): string[] {
    const prefix = `${kind}:`;
    return [...this.lookup().libraryItems.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort((a, b) => a.localeCompare(b));
  }

  private references(key: string): IndexedReference[] {
    if (!this.referenceLookup) {
      const lookup = new Map<string, IndexedReference[]>();
      for (const entry of this.files.values()) {
        for (const reference of entry.references) {
          const referenceKeyOf = referenceKey(reference.kind, reference.name, reference.script, reference.cue);
          const list = lookup.get(referenceKeyOf);
          if (list) {
            list.push(reference);
          } else {
            lookup.set(referenceKeyOf, [reference]);
          }
        }
      }
      this.referenceLookup = lookup;
    }
    return this.referenceLookup.get(key) ?? [];
  }

  /** Every `md.<Script>` in any file, also as part of a longer reference, at the script name. */
  scriptReferences(scriptName: string): IndexedReference[] {
    return this.references(referenceKey('script', scriptName));
  }

  /** Every `md.<Script>.<Cue>` in any file, at the cue name. */
  cueReferences(scriptName: string, cueName: string): IndexedReference[] {
    return this.references(referenceKey('cue', cueName, scriptName));
  }

  /** Every `md.<Script>.<Cue>.$x` in any file, at the `$`. */
  cueVariableReferences(scriptName: string, cueName: string, variableName: string): IndexedReference[] {
    return this.references(referenceKey('variable', variableName, scriptName, cueName));
  }

  /** Every reference to an interrupt library item of a kind with a name, in any file. */
  libraryReferences(kind: IndexedLibraryKind, name: string): IndexedReference[] {
    return this.references(referenceKey(kind, name));
  }
}

function xmlFiles(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((name) => name.toLowerCase().endsWith('.xml'))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => path.join(folder, name));
  } catch {
    return [];
  }
}

function subfolderNames(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * The script folders of the game and of its and the given extensions, in load order, with their
 * sources. An extension's `md` and `aiscripts` patch the game's (a patch there changes the game's file
 * of the same name); its `extensions/<folder>/md` and `.../aiscripts` hold patches of the extension in
 * that folder, named by its folder or else its id, and are listed when they exist.
 */
export function scriptFolders(gameFolder: string | undefined, extensionFolders: readonly string[] = []): ScriptFolder[] {
  const kinds = ['md', 'aiscripts'];
  const folders: ScriptFolder[] = gameFolder ? kinds.map((kind) => ({ folder: path.join(gameFolder, kind), source: 'game' })) : [];
  const extensions = findExtensions(gameFolder, extensionFolders);
  const byName = new Map<string, string>();
  for (const extension of extensions) {
    byName.set(path.basename(extension.folder).toLowerCase(), extension.folder);
  }
  for (const extension of extensions) {
    if (!byName.has(extension.id.toLowerCase())) {
      byName.set(extension.id.toLowerCase(), extension.folder);
    }
  }
  for (const extension of extensions) {
    for (const kind of kinds) {
      const folder: ScriptFolder = { folder: path.join(extension.folder, kind), source: extension.id };
      if (gameFolder) {
        folder.patches = { name: kind, folder: path.join(gameFolder, kind) };
      }
      folders.push(folder);
    }
    for (const nested of subfolderNames(path.join(extension.folder, 'extensions'))) {
      const target = byName.get(nested.toLowerCase());
      for (const kind of kinds) {
        const folder = path.join(extension.folder, 'extensions', nested, kind);
        if (subfolderNames(path.dirname(folder)).includes(kind)) {
          folders.push({
            folder,
            source: extension.id,
            patches: { name: `extensions/${nested}/${kind}`, extension: nested, ...(target ? { folder: path.join(target, kind) } : {}) },
          });
        }
      }
    }
  }
  return folders;
}

/** Every script file of the given script folders, in order. */
export function scriptFiles(folders: readonly ScriptFolder[]): ScriptSource[] {
  return folders.flatMap((folder) => xmlFiles(folder.folder).map((file) => ({ file, source: folder.source })));
}

/** Indexes the scripts of the game and of extension folders at once. Unreadable files are left out. */
export function loadScriptIndex(gameFolder: string | undefined, extensionFolders: readonly string[] = [], schemas?: SchemaSet): ScriptIndex {
  const index = new ScriptIndex(schemas);
  const folders = scriptFolders(gameFolder, extensionFolders);
  for (const folder of folders) {
    index.addFolder(folder);
  }
  for (const source of scriptFiles(folders)) {
    try {
      index.setText(source.file, readFileSync(source.file, 'utf8'), source.source);
    } catch {
      // A file that cannot be read is left out.
    }
  }
  return index;
}
