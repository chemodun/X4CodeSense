import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** One file of a catalog: where its bytes are in the `.dat` of the same name. */
export interface CatalogEntry {
  /** The path in the catalog, as written there (`md/setup.xml`). */
  readonly path: string;
  readonly size: number;
  /** Modification time, seconds since 1970. */
  readonly time: number;
  /** MD5 of the bytes, lower case hex. */
  readonly md5: string;
  /** The `.cat` file that lists it. */
  readonly catalog: string;
  /** The `.dat` file that holds it. */
  readonly data: string;
  /** Where its bytes start in the `.dat` file. */
  readonly offset: number;
}

/** A line of a catalog that is no entry: skipped, and its size not counted. */
export interface CatalogProblem {
  readonly catalog: string;
  /** 1-based line number. */
  readonly line: number;
  readonly text: string;
}

export interface CatalogOptions {
  /** Keep only the entries for which this holds; the others still count for the offsets. Saves memory: the game's catalogs list over 460,000 files. */
  keep?: (path: string) => boolean;
}

/** The direct children of a folder in the catalogs. */
export interface CatalogFolder {
  /** File names, sorted. */
  readonly files: string[];
  /** Folder names, sorted. */
  readonly folders: string[];
}

interface FolderNames {
  /** Lower case name → the name as the catalog gives it. */
  readonly files: Map<string, string>;
  readonly folders: Map<string, string>;
}

const SPACE = 0x20;
const NEWLINE = 0x0a;
const RETURN = 0x0d;
const MD5_LENGTH = 32;

/** The key of a path: case-insensitive, `/` separated, no leading `./` or `/`, no trailing `/`; the root is `''`. */
export function catalogKey(file: string): string {
  let key = file.replace(/\\/g, '/').toLowerCase();
  while (key.startsWith('./')) {
    key = key.slice(2);
  }
  while (key.startsWith('/')) {
    key = key.slice(1);
  }
  while (key.endsWith('/')) {
    key = key.slice(0, -1);
  }
  return key === '.' ? '' : key;
}

/** The decimal number in `bytes[start, end)`, or -1 when that is empty or holds anything but digits. */
function decimalIn(bytes: Buffer, start: number, end: number): number {
  if (start >= end) {
    return -1;
  }
  let value = 0;
  for (let index = start; index < end; index++) {
    const digit = bytes[index] - 0x30;
    if (digit < 0 || digit > 9) {
      return -1;
    }
    value = value * 10 + digit;
  }
  return value;
}

function isHexIn(bytes: Buffer, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    const code = bytes[index] | 0x20;
    if (!((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66))) {
      return false;
    }
  }
  return true;
}

/**
 * Catalogs opened in load order: for a path listed by several, the later catalog wins, as in the game.
 * Nothing is extracted: a file's bytes are read from its `.dat` when asked for.
 */
export class Catalogs {
  private readonly byKey = new Map<string, CatalogEntry>();
  private folderIndex: Map<string, FolderNames> | undefined;
  private readonly opened: string[] = [];
  private readonly skipped: CatalogProblem[] = [];

  private constructor() {}

  /** Opens `.cat` files in load order; a catalog without its `.dat` is skipped. */
  static open(catalogFiles: readonly string[], options: CatalogOptions = {}): Catalogs {
    const catalogs = new Catalogs();
    for (const catalog of catalogFiles) {
      const data = dataFileOf(catalog);
      if (!existsSync(data)) {
        continue;
      }
      catalogs.opened.push(catalog);
      catalogs.parse(catalog, data, readFileSync(catalog), options.keep);
    }
    return catalogs;
  }

  /** The catalogs read, in load order. */
  get catalogs(): readonly string[] {
    return this.opened;
  }

  /** The lines that are no entry. */
  get problems(): readonly CatalogProblem[] {
    return this.skipped;
  }

  /** The number of entries kept. */
  get size(): number {
    return this.byKey.size;
  }

  /** The entry of a path (case-insensitive, `/` or `\`). */
  entry(file: string): CatalogEntry | undefined {
    return this.byKey.get(catalogKey(file));
  }

  has(file: string): boolean {
    return this.byKey.has(catalogKey(file));
  }

  /** The entries kept, in the order first listed; only those under a folder when one is given. */
  *entries(folder = ''): IterableIterator<CatalogEntry> {
    const key = catalogKey(folder);
    const prefix = key === '' ? '' : `${key}/`;
    for (const [entryKey, entry] of this.byKey) {
      if (entryKey.startsWith(prefix)) {
        yield entry;
      }
    }
  }

  /** The bytes of a file, read from its `.dat`; undefined when no catalog lists it. */
  read(file: string): Buffer | undefined {
    const entry = this.entry(file);
    return entry && readEntry(entry);
  }

  /** The text of a file, as UTF-8. */
  readText(file: string): string | undefined {
    return this.read(file)?.toString('utf8');
  }

  /** Whether the bytes of a file match the MD5 its catalog gives. */
  verify(file: string): boolean {
    const entry = this.entry(file);
    return entry !== undefined && createHash('md5').update(readEntry(entry)).digest('hex') === entry.md5;
  }

  /** Whether a folder holds anything in the catalogs; `''` is the root. */
  isFolder(folder: string): boolean {
    return this.folders().has(catalogKey(folder));
  }

  /** The files and folders directly in a folder; `''` is the root. Names keep the case the catalog gives. */
  list(folder: string): CatalogFolder {
    const found = this.folders().get(catalogKey(folder));
    const sorted = (names: Map<string, string> | undefined) => [...(names?.values() ?? [])].sort();
    return { files: sorted(found?.files), folders: sorted(found?.folders) };
  }

  private folders(): Map<string, FolderNames> {
    if (this.folderIndex) {
      return this.folderIndex;
    }
    const index = new Map<string, FolderNames>();
    const namesOf = (key: string): FolderNames => {
      let found = index.get(key);
      if (!found) {
        found = { files: new Map(), folders: new Map() };
        index.set(key, found);
      }
      return found;
    };
    namesOf('');
    for (const entry of this.byKey.values()) {
      const parts = entry.path.replace(/\\/g, '/').split('/');
      let parent = '';
      for (let index = 0; index < parts.length - 1; index++) {
        const name = parts[index];
        const folders = namesOf(parent).folders;
        if (!folders.has(name.toLowerCase())) {
          folders.set(name.toLowerCase(), name);
        }
        parent = parent === '' ? name.toLowerCase() : `${parent}/${name.toLowerCase()}`;
      }
      const name = parts[parts.length - 1];
      namesOf(parent).files.set(name.toLowerCase(), name);
    }
    this.folderIndex = index;
    return index;
  }

  /** Reads the lines of a catalog from the right: `path size time md5`, where the path may hold spaces. */
  private parse(catalog: string, data: string, bytes: Buffer, keep: CatalogOptions['keep']): void {
    let offset = 0;
    let lineNumber = 0;
    let lineStart = 0;
    while (lineStart < bytes.length) {
      let lineEnd = bytes.indexOf(NEWLINE, lineStart);
      if (lineEnd < 0) {
        lineEnd = bytes.length;
      }
      lineNumber++;
      const end = lineEnd > lineStart && bytes[lineEnd - 1] === RETURN ? lineEnd - 1 : lineEnd;
      if (end > lineStart) {
        const md5Start = end - MD5_LENGTH;
        const timeSpace = md5Start - 1;
        const sizeSpace = timeSpace > lineStart && bytes[timeSpace] === SPACE ? bytes.lastIndexOf(SPACE, timeSpace - 1) : -1;
        const nameSpace = sizeSpace > lineStart ? bytes.lastIndexOf(SPACE, sizeSpace - 1) : -1;
        const size = nameSpace > lineStart ? decimalIn(bytes, nameSpace + 1, sizeSpace) : -1;
        const time = size >= 0 ? decimalIn(bytes, sizeSpace + 1, timeSpace) : -1;
        if (time >= 0 && isHexIn(bytes, md5Start, end)) {
          const file = bytes.toString('utf8', lineStart, nameSpace);
          if (!keep || keep(file)) {
            // A later catalog wins, and so does a later line of the same catalog.
            this.byKey.set(catalogKey(file), { path: file, size, time, md5: bytes.toString('latin1', md5Start, end).toLowerCase(), catalog, data, offset });
          }
          offset += size;
        } else if (bytes.toString('latin1', lineStart, end).trim() !== '') {
          this.skipped.push({ catalog, line: lineNumber, text: bytes.toString('utf8', lineStart, end) });
        }
      }
      lineStart = lineEnd + 1;
    }
  }
}

/** The `.dat` file of a `.cat` file. */
export function dataFileOf(catalog: string): string {
  return catalog.replace(/\.cat$/i, '.dat');
}

/** The bytes of an entry, read from its `.dat`. */
export function readEntry(entry: CatalogEntry): Buffer {
  const buffer = Buffer.alloc(entry.size);
  const handle = openSync(entry.data, 'r');
  try {
    let done = 0;
    while (done < entry.size) {
      const count = readSync(handle, buffer, done, entry.size - done, entry.offset + done);
      if (count === 0) {
        throw new Error(`${entry.data} ends before ${entry.path} does (offset ${entry.offset}, size ${entry.size})`);
      }
      done += count;
    }
  } finally {
    closeSync(handle);
  }
  return buffer;
}

/** The catalogs in a folder whose names match, sorted by name, without the signatures (`*_sig.cat`). */
export function catalogsIn(folder: string, pattern: RegExp): string[] {
  let names: string[];
  try {
    if (!statSync(folder).isDirectory()) {
      return [];
    }
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => pattern.test(name) && !/_sig\.cat$/i.test(name))
    .sort()
    .map((name) => path.join(folder, name));
}

/** The game's own catalogs: `01.cat`, `02.cat`, … in its folder. */
export function gameCatalogs(gameFolder: string): string[] {
  return catalogsIn(gameFolder, /^\d+\.cat$/i);
}

/** An extension's catalogs of its own files: `ext_01.cat`, `ext_02.cat`, … in its folder. */
export function extensionCatalogs(extensionFolder: string): string[] {
  return catalogsIn(extensionFolder, /^ext_\d+\.cat$/i);
}
