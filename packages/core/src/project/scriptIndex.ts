/**
 * The scripts of the game and of the extensions, indexed by name, so a script can refer to another:
 * `md.<Script>.<Cue>` in Mission Director expressions, and interrupt library actions, handlers and
 * conditions, which AI scripts share by globally unique names.
 *
 * Each file is read with the tolerant scanner alone, so indexing needs no schema and costs little per
 * file. An extension's `<diff>` patches the script in the same folder kind with the same file name, as
 * the game applies extension patches; the cues and library items it adds anywhere inside `add` and
 * `replace` count for that script. Evaluating `sel` exactly is left to the patch support.
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
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { findExtensions } from '../extensions/extensions';
import type { ScriptSchema } from '../types';
import { collectVariables, receivesValue, type DocumentVariables } from '../variables/variables';
import { attributeNamed, parseXml, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import type { SchemaSet } from '../xsd/loadSchemas';
import type { XsdElement, XsdSchema } from '../xsd/schema';

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
  patch?: string;
  /** Variables it sets, which count as set in the script that uses it; empty when indexed without the schemas. */
  variables: IndexedVariable[];
}

export interface IndexedScript {
  kind: 'script';
  file: string;
  /** `game`, or the id of the extension the file belongs to. */
  source: string;
  schema: ScriptSchema;
  name: string;
  position: IndexedPosition;
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
}

export type IndexedFile = IndexedScript | IndexedPatch;

/** A script file to index, with the source it belongs to. */
export interface ScriptSource {
  file: string;
  source: string;
}

const libraryKinds: ReadonlySet<string> = new Set(['actions', 'handler', 'conditions']);

function keyOf(file: string): string {
  return path.resolve(file).toLowerCase();
}

/** Zero-based line and character of offsets; fastest when asked in increasing order. */
function positionCounter(text: string): (offset: number) => { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  let scanned = 0;
  return (offset) => {
    if (offset < scanned) {
      line = 0;
      lineStart = 0;
      scanned = 0;
    }
    for (; scanned < offset; scanned++) {
      if (text.charCodeAt(scanned) === 10) {
        line++;
        lineStart = scanned + 1;
      }
    }
    return { line, character: offset - lineStart };
  };
}

function nameOf(element: XmlElement): string | undefined {
  const name = attributeNamed(element, 'name')?.value.trim();
  return name ? name : undefined;
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

/**
 * What a file contributes to the index, from its scanned structure; undefined for anything but a script
 * or a script patch. With the schemas, the variables of AI script interrupt library items and those
 * Mission Director scripts write through values are indexed too.
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
  const at = (element: XmlElement): IndexedPosition => ({ file, ...position(element.start) });
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
  const mdXsd = schema === 'md' ? schemas.md : undefined;
  for (const element of structure.elements) {
    if (!counts(element)) {
      continue;
    }
    if (mdXsd) {
      addWritesThroughValues(element, mdXsd, writes);
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
        const item: IndexedLibraryItem = { kind: element.name as IndexedLibraryKind, name, script: scriptName, position: at(element), variables: [] };
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
  const uses = { writesThroughValues, includes: [...includes].sort(), instantiates: [...instantiates].sort() };
  if (patch) {
    return { kind: 'patch', file, source, schema, cues, libraryItems, ...uses };
  }
  return { kind: 'script', file, source, schema, name: scriptName, position: at(root), cues, libraryItems, params, ...uses };
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

interface Lookups {
  scripts: Map<string, IndexedScript[]>;
  cues: Map<IndexedScript, IndexedCue[]>;
  libraryItems: Map<string, IndexedLibraryItem[]>;
  writesThroughValues: Set<string>;
  /** Scripts that include a library, by `md.Script.Library`; a patch counts as a script without a name. */
  includers: Map<string, Set<string>>;
  /** Scripts that instantiate or run a library, the same way. */
  instantiators: Map<string, Set<string>>;
}

export class ScriptIndex {
  private readonly files = new Map<string, IndexedFile>();
  /** Script folders read by `loadScriptIndex`, with the source of each. */
  private readonly folders = new Map<string, string>();
  /** Texts of files an editor holds, which may differ from the disk. */
  private readonly texts = new Map<string, string>();
  /** Variables of script files with a way to tell positions, worked out when first asked for. */
  private readonly variables = new Map<
    string,
    { variables: DocumentVariables; position: (offset: number) => { line: number; character: number } } | undefined
  >();
  private lookups: Lookups | undefined;
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
    } else {
      this.texts.delete(key);
    }
    this.variables.delete(key);
    this.cueVariableLists.clear();
    this.lookups = undefined;
    return signatureOf(entry) !== before;
  }

  /** Forgets a file; returns true when it was indexed. */
  removeFile(file: string): boolean {
    const key = keyOf(file);
    const removed = this.files.delete(key);
    this.texts.delete(key);
    this.variables.delete(key);
    this.cueVariableLists.clear();
    if (removed) {
      this.lookups = undefined;
    }
    return removed;
  }

  /** The variables of an indexed script, from the editor's text or the disk; undefined without the schemas or the file. */
  private variablesOfScript(
    script: IndexedScript
  ): { variables: DocumentVariables; position: (offset: number) => { line: number; character: number } } | undefined {
    const key = keyOf(script.file);
    if (!this.variables.has(key)) {
      const xsd = this.schemas?.schemas[script.schema];
      let text = this.texts.get(key);
      if (text === undefined && xsd) {
        try {
          text = readFileSync(script.file, 'utf8');
        } catch {
          text = undefined;
        }
      }
      this.variables.set(
        key,
        xsd && text !== undefined ? { variables: variablesOf(parseXml(text), script.schema, xsd), position: positionCounter(text) } : undefined
      );
    }
    return this.variables.get(key);
  }

  /**
   * The variables a cue of a Mission Director script has in its own table (`md.<Script>.<Cue>.$x`),
   * each with where it is set first; for every script of that name.
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
      const known = this.variablesOfScript(script);
      const table = known?.variables.tables.find((candidate) => (candidate.kind === 'cue' || candidate.kind === 'library') && candidate.name === cueName);
      if (!known || !table) {
        continue;
      }
      const position = known.position;
      for (const variable of table.variables.values()) {
        const first = variable.definitions[0];
        if (first && !found.some((known) => known.name === variable.name)) {
          found.push({ name: variable.name, position: { file: script.file, ...position(first.start) } });
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
    return this.files.get(keyOf(file))?.source ?? this.folders.get(keyOf(path.dirname(file)));
  }

  /** Records a script folder read for a source, so files created in it later are indexed too. */
  addFolder(folder: string, source: string): void {
    this.folders.set(keyOf(folder), source);
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
      const byFileName = new Map<string, IndexedScript[]>();
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
        push(byFileName, `${entry.schema}:${path.basename(entry.file).toLowerCase()}`, entry);
        cues.set(entry, [...entry.cues]);
        for (const item of entry.libraryItems) {
          push(libraryItems, `${item.kind}:${item.name}`, item);
        }
      }
      for (const entry of this.files.values()) {
        if (entry.kind !== 'patch') {
          continue;
        }
        for (const target of byFileName.get(`${entry.schema}:${path.basename(entry.file).toLowerCase()}`) ?? []) {
          if (target.file === entry.file) {
            continue;
          }
          cues.get(target)?.push(...entry.cues);
          for (const item of entry.libraryItems) {
            push(libraryItems, `${item.kind}:${item.name}`, { ...item, script: target.name });
          }
        }
      }
      this.lookups = { scripts, cues, libraryItems, writesThroughValues, includers, instantiators };
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

/** The script folders of the game and of its and the given extensions, in load order, with their sources. */
export function scriptFolders(gameFolder: string | undefined, extensionFolders: readonly string[] = []): { folder: string; source: string }[] {
  const roots = gameFolder ? [{ folder: gameFolder, source: 'game' }] : [];
  roots.push(...findExtensions(gameFolder, extensionFolders).map((extension) => ({ folder: extension.folder, source: extension.id })));
  return roots.flatMap((root) => ['md', 'aiscripts'].map((kind) => ({ folder: path.join(root.folder, kind), source: root.source })));
}

/** Every script file of the given script folders, in order. */
export function scriptFiles(folders: readonly { folder: string; source: string }[]): ScriptSource[] {
  return folders.flatMap((folder) => xmlFiles(folder.folder).map((file) => ({ file, source: folder.source })));
}

/** Indexes the scripts of the game and of extension folders at once. Unreadable files are left out. */
export function loadScriptIndex(gameFolder: string | undefined, extensionFolders: readonly string[] = [], schemas?: SchemaSet): ScriptIndex {
  const index = new ScriptIndex(schemas);
  const folders = scriptFolders(gameFolder, extensionFolders);
  for (const folder of folders) {
    index.addFolder(folder.folder, folder.source);
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
