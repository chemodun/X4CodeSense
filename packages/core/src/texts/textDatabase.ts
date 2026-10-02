/**
 * The game's texts. Each language has a file `t/0001-l<language>.xml` (also written `0001-L044.xml`);
 * `0001.xml` serves every language. A file holds `<page id="…">` elements with numbered `<t id="…">`
 * texts. Scripts and game data refer to a text as `{page, id}`, and some actions as `page="…" line="…"`.
 *
 * An extension's text file is either such a file, whose pages are added, or a `<diff>` that patches the
 * texts of its language: `add` pages to the language or texts to a page (`pos="before|after"` makes
 * them siblings of the target), `replace` a page, a text or a text's `text()`, `remove` a page or a
 * text. Targets are the language, a page and a text addressed by `@id`, which is how text patches are
 * written; any other `sel` is not applied and is listed in `problems`. Extensions are read in the order
 * the game loads them (see `findExtensions`), and what is read later wins.
 *
 * A text may contain references to other texts, resolved when the game shows it; text in round
 * brackets is a comment the game hides, `\(` and `\)` are literal brackets and `\n` is a line break.
 */
import * as path from 'node:path';
import { findExtensions } from '../extensions/extensions';
import { diskFiles, fileNames, type FileSource } from '../files/fileSource';
import { attributeNamed, decodeAttributeValue, parseXml, type XmlElement } from '../xml/xmlStructure';

/** One text in one language. */
export interface GameText {
  page: number;
  id: number;
  /** Language id from the file name, such as `44`, or `*` for `0001.xml`, which serves every language. */
  language: string;
  /** The text as written, with XML entities decoded. */
  text: string;
  /** Absolute path of the file. */
  file: string;
  /** Zero-based position of the `<t>` start tag, or of the patch that set the text. */
  line: number;
  character: number;
}

export interface TextPage {
  id: number;
  title?: string;
  description?: string;
}

/** What a file does to the texts of its language, in order. */
type TextChange = { kind: 'add'; texts: GameText[]; pages: TextPage[] } | { kind: 'remove'; page: number; id?: number };

interface TextFile {
  language: string;
  changes: TextChange[];
  problems: string[];
}

/** A patch target: the language, one of its pages, or a text of a page; `node` when the patch addresses its text or an attribute. */
interface TextTarget {
  page?: number;
  id?: number;
  node?: 'text' | 'attribute';
}

/** A reference to a text, with its offsets in the searched string. */
export interface TextReference {
  page: number;
  id: number;
  start: number;
  end: number;
}

const referencePattern = /\{\s*(\d+)\s*,\s*(\d+)\s*\}/g;
/** The same, matched exactly at `lastIndex`. */
const referenceHere = /\{\s*(\d+)\s*,\s*(\d+)\s*\}/y;
const pageLinePattern = /\bpage\s*=\s*"(\d+)"\s+line\s*=\s*"(\d+)"/g;
const maximumDepth = 8;

/** The language a text file serves: `44` for `0001-l044.xml`, `*` for `0001.xml`, undefined for other files. */
export function languageOfTextFile(fileName: string): string | undefined {
  const match = /^0001(?:-[lL]?(\d+))?\.xml$/i.exec(fileName);
  if (!match) {
    return undefined;
  }
  return match[1] === undefined ? '*' : String(Number(match[1]));
}

/** Every `{page, id}` in a string, in order. */
export function textReferencesIn(value: string): TextReference[] {
  const references: TextReference[] = [];
  for (const match of value.matchAll(referencePattern)) {
    references.push({ page: Number(match[1]), id: Number(match[2]), start: match.index, end: match.index + match[0].length });
  }
  return references;
}

/**
 * The text reference under an offset of a document text, looked for on the offset's line only, so it
 * works in any XML and while the document does not parse: `{page, id}`, or `page="…" line="…"`.
 */
export function textReferenceAt(text: string, offset: number): TextReference | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const newline = text.indexOf('\n', offset);
  const line = text.slice(lineStart, newline < 0 ? text.length : newline);
  const column = offset - lineStart;
  for (const pattern of [referencePattern, pageLinePattern]) {
    for (const match of line.matchAll(pattern)) {
      if (column >= match.index && column <= match.index + match[0].length) {
        return { page: Number(match[1]), id: Number(match[2]), start: lineStart + match.index, end: lineStart + match.index + match[0].length };
      }
    }
  }
  return undefined;
}

/** A file as the database keeps it, as the script index does: an editor's `c:\…` is the `C:\…` read at the start. */
function fileKey(file: string): string {
  return path.resolve(file).toLowerCase();
}

/** Zero-based line and character of offsets; fastest when they are asked for in increasing order. */
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

/** The content of an element between its tags, entities decoded. */
function contentOf(text: string, element: XmlElement): string {
  if (element.selfClosing || !element.endTag) {
    return '';
  }
  return decodeAttributeValue(text.slice(element.startTagEnd, element.endTag.start), []);
}

function integerAttribute(element: XmlElement, name: string): number | undefined {
  const value = attributeNamed(element, name)?.value.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * The target of a patch `sel`: `/language`, `/language/page[@id='N']`, `/language/page[@id='N']/t[@id='M']`,
 * the same searched with `//`, and `/text()` or `/@attribute` after a text or a page. Undefined for others.
 */
function parseTarget(sel: string): TextTarget | undefined {
  let rest = sel.replace(/\s+/g, '');
  const language = /^\/\/?language/.exec(rest);
  if (language) {
    rest = rest.slice(language[0].length);
  } else if (!rest.startsWith('//')) {
    return undefined;
  }
  const match = /^(?:\/\/?page\[@id=(?:'(\d+)'|"(\d+)")\])?(?:\/\/?t\[@id=(?:'(\d+)'|"(\d+)")\])?(\/text\(\)|\/@[\w.-]+)?$/.exec(rest);
  if (!match) {
    return undefined;
  }
  const page = match[1] ?? match[2];
  const id = match[3] ?? match[4];
  if ((id !== undefined && page === undefined) || (!language && page === undefined)) {
    return undefined;
  }
  const target: TextTarget = {};
  if (page !== undefined) {
    target.page = Number(page);
  }
  if (id !== undefined) {
    target.id = Number(id);
  }
  if (match[5]) {
    target.node = match[5] === '/text()' ? 'text' : 'attribute';
  }
  return target;
}

class TextFileReader {
  readonly changes: TextChange[] = [];
  readonly problems: string[] = [];
  private readonly position: (offset: number) => { line: number; character: number };

  constructor(
    private readonly file: string,
    private readonly text: string,
    private readonly language: string
  ) {
    this.position = positionCounter(text);
  }

  private gameText(page: number, id: number, text: string, offset: number): GameText {
    return { page, id, language: this.language, text, file: this.file, ...this.position(offset) };
  }

  /** The texts of `<t>` elements of a page. */
  private textsOf(page: number, elements: readonly XmlElement[]): GameText[] {
    const texts: GameText[] = [];
    for (const element of elements) {
      const id = element.name === 't' ? integerAttribute(element, 'id') : undefined;
      if (id !== undefined) {
        texts.push(this.gameText(page, id, contentOf(this.text, element), element.start));
      }
    }
    return texts;
  }

  /** Adds `<page>` elements with their texts. */
  private addPages(elements: readonly XmlElement[]): void {
    const change: TextChange = { kind: 'add', texts: [], pages: [] };
    for (const element of elements) {
      const id = element.name === 'page' ? integerAttribute(element, 'id') : undefined;
      if (id === undefined) {
        continue;
      }
      const page: TextPage = { id };
      const title = attributeNamed(element, 'title')?.value;
      const description = attributeNamed(element, 'descr')?.value;
      if (title) {
        page.title = title;
      }
      if (description && description !== '0') {
        page.description = description;
      }
      change.pages.push(page);
      change.texts.push(...this.textsOf(id, element.children));
    }
    this.changes.push(change);
  }

  read(): TextFile {
    const structure = parseXml(this.text);
    const root = structure.roots[0];
    if (root?.name === 'diff') {
      for (const operation of root.children) {
        this.apply(operation);
      }
    } else {
      // A language file, or anything else that holds pages.
      this.addPages(structure.elements.filter((element) => element.name === 'page'));
    }
    return { language: this.language, changes: this.changes, problems: this.problems };
  }

  private apply(operation: XmlElement): void {
    const sel = attributeNamed(operation, 'sel')?.value ?? '';
    const where = `${this.file}:${this.position(operation.start).line + 1}`;
    const skip = (why: string): void => {
      this.problems.push(`${where}: <${operation.name} sel="${sel}"> is not applied: ${why}`);
    };
    if (operation.name !== 'add' && operation.name !== 'replace' && operation.name !== 'remove') {
      skip('not a patch operation');
      return;
    }
    const target = parseTarget(sel);
    if (!target) {
      skip('only the language, a page and a text addressed by @id are understood');
      return;
    }
    if (target.node === 'attribute' || attributeNamed(operation, 'type')) {
      // Attributes of pages and texts do not change what the texts say.
      return;
    }
    const { page, id } = target;
    switch (operation.name) {
      case 'add': {
        const pos = attributeNamed(operation, 'pos')?.value;
        const sibling = pos === 'before' || pos === 'after';
        if (target.node === 'text' || (id !== undefined && !sibling) || (page === undefined && sibling)) {
          skip('a text holds no elements');
        } else if (page === undefined || (sibling && id === undefined)) {
          this.addPages(operation.children);
        } else {
          this.changes.push({ kind: 'add', texts: this.textsOf(page, operation.children), pages: [] });
        }
        return;
      }
      case 'replace':
        if (page === undefined || (target.node === 'text' && id === undefined)) {
          skip('only a page, a text or its text() can be replaced');
        } else if (target.node === 'text' && id !== undefined) {
          this.changes.push({ kind: 'remove', page, id });
          this.changes.push({ kind: 'add', texts: [this.gameText(page, id, contentOf(this.text, operation), operation.start)], pages: [] });
        } else if (id !== undefined) {
          this.changes.push({ kind: 'remove', page, id });
          this.changes.push({ kind: 'add', texts: this.textsOf(page, operation.children), pages: [] });
        } else {
          this.changes.push({ kind: 'remove', page });
          this.addPages(operation.children);
        }
        return;
      case 'remove':
        if (page === undefined) {
          skip('only a page or a text can be removed');
        } else if (target.node === 'text' && id !== undefined) {
          this.changes.push({ kind: 'remove', page, id });
          this.changes.push({ kind: 'add', texts: [this.gameText(page, id, '', operation.start)], pages: [] });
        } else if (target.node === 'text') {
          skip('a page has no text of its own');
        } else {
          this.changes.push(id === undefined ? { kind: 'remove', page } : { kind: 'remove', page, id });
        }
        return;
    }
  }
}

export interface TextLoadOptions {
  /** Extension folders: each counts as an extension and holds extensions in its subfolders; their `t` folders are read after the game's. */
  extensionFolders?: readonly string[];
  /** Only these languages, besides `0001.xml`; all when absent. */
  languages?: ReadonlySet<string>;
  /** Where the files are read from; the disk when absent. */
  files?: FileSource;
}

/** The `t` folders of the game and of its and the given extensions, in the order the game loads them. */
export function textFolders(gameFolder: string | undefined, extensionFolders: readonly string[] = [], files: FileSource = diskFiles): string[] {
  const candidates = gameFolder ? [path.join(gameFolder, 't')] : [];
  candidates.push(...findExtensions(gameFolder, extensionFolders, files).map((extension) => path.join(extension.folder, 't')));
  return candidates.filter((folder) => files.isDirectory(folder));
}

/** Texts of every language, with lookups by page and id, built by applying the files in reading order. */
export class TextDatabase {
  /** Language names by id, from the game's `libraries/languages.xml`. */
  readonly languageNames = new Map<string, string>();
  /** The `t` folders `loadTexts` read, in order. */
  readonly folders: string[] = [];
  private readonly files = new Map<string, TextFile>();
  private byPage: Map<number, Map<number, GameText[]>> | undefined;
  private pagesById: Map<number, TextPage> | undefined;

  /**
   * Adds a file after the others, or replaces a file where it was read; `language` defaults to the one
   * its name tells. Returns false for a file that is no text file.
   */
  setFile(file: string, text: string, language = languageOfTextFile(path.basename(file))): boolean {
    if (language === undefined) {
      return false;
    }
    this.files.set(fileKey(file), new TextFileReader(file, text, language).read());
    this.byPage = undefined;
    this.pagesById = undefined;
    return true;
  }

  removeFile(file: string): void {
    if (this.files.delete(fileKey(file))) {
      this.byPage = undefined;
      this.pagesById = undefined;
    }
  }

  /** True when the file was read into the database. */
  hasFile(file: string): boolean {
    return this.files.has(fileKey(file));
  }

  get fileCount(): number {
    return this.files.size;
  }

  /** The files read, each as the key it is kept under: its resolved path in lower case. */
  fileKeys(): string[] {
    return [...this.files.keys()];
  }

  /** Patch operations that were not applied, with file and line. */
  get problems(): string[] {
    return [...this.files.values()].flatMap((file) => file.problems);
  }

  private lookup(): Map<number, Map<number, GameText[]>> {
    if (!this.byPage) {
      const byPage = new Map<number, Map<number, GameText[]>>();
      const pagesById = new Map<number, TextPage>();
      for (const file of this.files.values()) {
        for (const change of file.changes) {
          if (change.kind === 'remove') {
            removeTexts(byPage, change.page, change.id, file.language);
            continue;
          }
          for (const page of change.pages) {
            pagesById.set(page.id, { ...pagesById.get(page.id), ...page });
          }
          for (const text of change.texts) {
            let ids = byPage.get(text.page);
            if (!ids) {
              ids = new Map();
              byPage.set(text.page, ids);
            }
            const entries = ids.get(text.id);
            if (entries) {
              entries.push(text);
            } else {
              ids.set(text.id, [text]);
            }
          }
        }
      }
      this.byPage = byPage;
      this.pagesById = pagesById;
    }
    return this.byPage;
  }

  /** Number of distinct `{page, id}` pairs. */
  get textCount(): number {
    let count = 0;
    for (const ids of this.lookup().values()) {
      count += ids.size;
    }
    return count;
  }

  /** Every definition of a text, in every language, in reading order; what a patch removed or replaced is gone. */
  texts(page: number, id: number): readonly GameText[] {
    return this.lookup().get(page)?.get(id) ?? [];
  }

  has(page: number, id: number): boolean {
    return this.texts(page, id).length > 0;
  }

  hasPage(page: number): boolean {
    return this.lookup().has(page);
  }

  page(id: number): TextPage | undefined {
    this.lookup();
    return this.pagesById?.get(id);
  }

  /** Every page with at least one text, by id. */
  pages(): TextPage[] {
    return [...this.lookup().keys()].sort((a, b) => a - b).map((id) => this.pagesById?.get(id) ?? { id });
  }

  /** Text ids of a page, in order. */
  ids(page: number): number[] {
    return [...(this.lookup().get(page)?.keys() ?? [])].sort((a, b) => a - b);
  }

  /** Languages a text exists in, the preferred first, then `*`, then by id. */
  languagesOf(page: number, id: number, preferred?: string): string[] {
    const languages = [...new Set(this.texts(page, id).map((text) => text.language))];
    const rank = (language: string): number => (language === preferred ? -2 : language === '*' ? -1 : Number(language));
    return languages.sort((a, b) => rank(a) - rank(b));
  }

  /** The text the game shows for a language: that language's, else the one of `0001.xml`, else English, else any. The last definition wins. */
  pick(page: number, id: number, language: string): GameText | undefined {
    const texts = this.texts(page, id);
    for (const wanted of [language, '*', '44']) {
      const found = texts.filter((text) => text.language === wanted).pop();
      if (found) {
        return found;
      }
    }
    return texts[texts.length - 1];
  }

  /** How the game shows a text: references resolved in the same language, comments hidden, escapes applied. */
  display(text: string, language: string, depth = 0): string {
    let shown = '';
    let comment = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '\\' && index + 1 < text.length) {
        const next = text[index + 1];
        index++;
        if (comment === 0) {
          shown += next === 'n' ? '\n' : next === '(' || next === ')' || next === '\\' ? next : character + next;
        }
        continue;
      }
      if (character === '(') {
        comment++;
        continue;
      }
      if (character === ')' && comment > 0) {
        comment--;
        continue;
      }
      if (comment > 0) {
        continue;
      }
      if (character === '{' && depth < maximumDepth) {
        referenceHere.lastIndex = index;
        const found = referenceHere.exec(text);
        if (found) {
          const target = this.pick(Number(found[1]), Number(found[2]), language);
          shown += target ? this.display(target.text, language, depth + 1) : found[0];
          index += found[0].length - 1;
          continue;
        }
      }
      shown += character;
    }
    return shown;
  }
}

/** Removes the texts of one language from a page, or one text of it. */
function removeTexts(byPage: Map<number, Map<number, GameText[]>>, page: number, id: number | undefined, language: string): void {
  const ids = byPage.get(page);
  if (!ids) {
    return;
  }
  for (const textId of id === undefined ? [...ids.keys()] : [id]) {
    const kept = (ids.get(textId) ?? []).filter((text) => text.language !== language);
    if (kept.length > 0) {
      ids.set(textId, kept);
    } else {
      ids.delete(textId);
    }
  }
  if (ids.size === 0) {
    byPage.delete(page);
  }
}

function readLanguageNames(gameFolder: string, files: FileSource, into: Map<string, string>): void {
  let text: string;
  try {
    text = files.readText(path.join(gameFolder, 'libraries', 'languages.xml'));
  } catch {
    return;
  }
  for (const element of parseXml(text).elements) {
    const id = attributeNamed(element, 'id')?.value;
    const name = attributeNamed(element, 'name')?.value;
    if (element.name === 'language' && id && name) {
      into.set(String(Number(id)), name);
    }
  }
}

/** Reads the text files of the game and of extension folders, in load order. Never throws; unreadable files are skipped. */
export function loadTexts(gameFolder: string | undefined, options: TextLoadOptions = {}): TextDatabase {
  const database = new TextDatabase();
  const files = options.files ?? diskFiles;
  if (gameFolder) {
    readLanguageNames(gameFolder, files, database.languageNames);
  }
  for (const folder of textFolders(gameFolder, options.extensionFolders, files)) {
    database.folders.push(folder);
    for (const name of fileNames(files, folder).sort()) {
      const language = languageOfTextFile(name);
      if (language === undefined || (options.languages && language !== '*' && !options.languages.has(language))) {
        continue;
      }
      try {
        database.setFile(path.join(folder, name), files.readText(path.join(folder, name)), language);
      } catch {
        // A file that cannot be read is left out.
      }
    }
  }
  return database;
}
