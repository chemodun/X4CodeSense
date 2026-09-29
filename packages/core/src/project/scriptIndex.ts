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
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { findExtensions } from '../extensions/extensions';
import type { ScriptSchema } from '../types';
import { attributeNamed, parseXml, type XmlElement, type XmlStructure } from '../xml/xmlStructure';

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

export interface IndexedLibraryItem {
  kind: IndexedLibraryKind;
  name: string;
  /** Name of the AI script that defines it. */
  script: string;
  position: IndexedPosition;
  patch?: string;
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
}

export interface IndexedPatch {
  kind: 'patch';
  file: string;
  source: string;
  schema: ScriptSchema;
  cues: IndexedCue[];
  libraryItems: IndexedLibraryItem[];
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

/** What a file contributes to the index, from its scanned structure; undefined for anything but a script or a script patch. */
export function indexStructure(file: string, text: string, structure: XmlStructure, source: string): IndexedFile | undefined {
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
  for (const element of structure.elements) {
    if (!counts(element)) {
      continue;
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
        const item: IndexedLibraryItem = { kind: element.name as IndexedLibraryKind, name, script: scriptName, position: at(element) };
        if (patch) {
          item.patch = file;
        }
        libraryItems.push(item);
      }
    } else if (schema === 'aiscripts' && !patch && element.name === 'params') {
      params.push(...paramNames(element.children));
    }
  }
  if (patch) {
    return { kind: 'patch', file, source, schema, cues, libraryItems };
  }
  return { kind: 'script', file, source, schema, name: scriptName, position: at(root), cues, libraryItems, params };
}

/** What other scripts can see of a file: when it changes, scripts that refer to it are checked again. */
function signatureOf(entry: IndexedFile | undefined): string {
  if (!entry) {
    return '';
  }
  const cues = entry.cues.map((cue) => `${cue.kind}:${cue.name}:${cue.params.join(',')}`).join(';');
  const items = entry.libraryItems.map((item) => `${item.kind}:${item.name}`).join(';');
  return entry.kind === 'script' ? `${entry.schema}|${entry.name}|${cues}|${items}|${entry.params.join(',')}` : `${entry.schema}|patch|${cues}|${items}`;
}

interface Lookups {
  scripts: Map<string, IndexedScript[]>;
  cues: Map<IndexedScript, IndexedCue[]>;
  libraryItems: Map<string, IndexedLibraryItem[]>;
}

export class ScriptIndex {
  private readonly files = new Map<string, IndexedFile>();
  /** Script folders read by `loadScriptIndex`, with the source of each. */
  private readonly folders = new Map<string, string>();
  private lookups: Lookups | undefined;

  /** Indexes a file from its text; returns true when what other scripts see of it changed. */
  setText(file: string, text: string, source: string): boolean {
    return this.setStructure(file, text, parseXml(text), source);
  }

  /** Indexes a file from its already scanned structure; returns true when what other scripts see of it changed. */
  setStructure(file: string, text: string, structure: XmlStructure, source: string): boolean {
    const key = keyOf(file);
    const before = signatureOf(this.files.get(key));
    const entry = indexStructure(file, text, structure, source);
    if (entry) {
      this.files.set(key, entry);
    } else {
      this.files.delete(key);
    }
    this.lookups = undefined;
    return signatureOf(entry) !== before;
  }

  /** Forgets a file; returns true when it was indexed. */
  removeFile(file: string): boolean {
    const removed = this.files.delete(keyOf(file));
    if (removed) {
      this.lookups = undefined;
    }
    return removed;
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
      this.lookups = { scripts, cues, libraryItems };
    }
    return this.lookups;
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
export function loadScriptIndex(gameFolder: string | undefined, extensionFolders: readonly string[] = []): ScriptIndex {
  const index = new ScriptIndex();
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
