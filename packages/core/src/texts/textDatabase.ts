/**
 * The game's texts. Each language has a file `t/0001-l<language>.xml` (also written `0001-L044.xml`);
 * `0001.xml` serves every language. A file holds `<page id="…">` elements with numbered `<t id="…">`
 * texts; an extension's file may instead be a `<diff>` that adds pages, which is read the same way.
 * Scripts and game data refer to a text as `{page, id}`, and some actions as `page="…" line="…"`.
 *
 * A text may contain references to other texts, resolved when the game shows it; text in round
 * brackets is a comment the game hides, `\(` and `\)` are literal brackets and `\n` is a line break.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
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
  /** Zero-based position of the `<t>` start tag. */
  line: number;
  character: number;
}

export interface TextPage {
  id: number;
  title?: string;
  description?: string;
}

interface TextFile {
  language: string;
  texts: GameText[];
  pages: TextPage[];
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

/** Zero-based line and character of offsets that are visited in increasing order. */
function positionCounter(text: string): (offset: number) => { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  let scanned = 0;
  return (offset) => {
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

function parseTextFile(file: string, text: string, language: string): TextFile {
  const structure = parseXml(text);
  const position = positionCounter(text);
  const texts: GameText[] = [];
  const pages: TextPage[] = [];
  for (const element of structure.elements) {
    if (element.name === 'page') {
      const id = Number(attributeNamed(element, 'id')?.value);
      if (Number.isInteger(id)) {
        const page: TextPage = { id };
        const title = attributeNamed(element, 'title')?.value;
        const description = attributeNamed(element, 'descr')?.value;
        if (title) {
          page.title = title;
        }
        if (description && description !== '0') {
          page.description = description;
        }
        pages.push(page);
      }
      continue;
    }
    if (element.name !== 't' || element.parent?.name !== 'page') {
      continue;
    }
    const page = Number(attributeNamed(element.parent, 'id')?.value);
    const id = Number(attributeNamed(element, 'id')?.value);
    if (!Number.isInteger(page) || !Number.isInteger(id)) {
      continue;
    }
    texts.push({ page, id, language, text: contentOf(text, element), file, ...position(element.start) });
  }
  return { language, texts, pages };
}

export interface TextLoadOptions {
  /** Extension folders: the `t` folder of each and of each folder inside is read after the game's. */
  extensionFolders?: readonly string[];
  /** Only these languages, besides `0001.xml`; all when absent. */
  languages?: ReadonlySet<string>;
}

function isDirectory(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function subfolders(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(folder, entry.name));
  } catch {
    return [];
  }
}

/** The `t` folders of the game (with its bundled extensions) and of extension folders, in reading order, each once. */
export function textFolders(gameFolder: string | undefined, extensionFolders: readonly string[] = []): string[] {
  const candidates: string[] = [];
  if (gameFolder) {
    candidates.push(path.join(gameFolder, 't'), ...subfolders(path.join(gameFolder, 'extensions')).map((folder) => path.join(folder, 't')));
  }
  for (const folder of extensionFolders) {
    candidates.push(path.join(folder, 't'), ...subfolders(folder).map((sub) => path.join(sub, 't')));
  }
  const seen = new Set<string>();
  return candidates.filter((folder) => {
    const key = path.resolve(folder).toLowerCase();
    if (seen.has(key) || !isDirectory(folder)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Texts of every language, with lookups by page and id. Files read later override earlier ones. */
export class TextDatabase {
  /** Language names by id, from the game's `libraries/languages.xml`. */
  readonly languageNames = new Map<string, string>();
  private readonly files = new Map<string, TextFile>();
  private byPage: Map<number, Map<number, GameText[]>> | undefined;
  private pagesById: Map<number, TextPage> | undefined;

  /** Adds or replaces a file; `language` defaults to the one its name tells. Returns false for a file that is no text file. */
  setFile(file: string, text: string, language = languageOfTextFile(path.basename(file))): boolean {
    if (language === undefined) {
      return false;
    }
    this.files.set(path.resolve(file), parseTextFile(file, text, language));
    this.byPage = undefined;
    this.pagesById = undefined;
    return true;
  }

  removeFile(file: string): void {
    if (this.files.delete(path.resolve(file))) {
      this.byPage = undefined;
      this.pagesById = undefined;
    }
  }

  /** True when the file was read into the database. */
  hasFile(file: string): boolean {
    return this.files.has(path.resolve(file));
  }

  get fileCount(): number {
    return this.files.size;
  }

  private lookup(): Map<number, Map<number, GameText[]>> {
    if (!this.byPage) {
      this.byPage = new Map();
      this.pagesById = new Map();
      for (const file of this.files.values()) {
        for (const page of file.pages) {
          const known = this.pagesById.get(page.id);
          this.pagesById.set(page.id, { ...known, ...page });
        }
        for (const text of file.texts) {
          let ids = this.byPage.get(text.page);
          if (!ids) {
            ids = new Map();
            this.byPage.set(text.page, ids);
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

  /** Every definition of a text, in every language, in reading order. */
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

function readLanguageNames(gameFolder: string, into: Map<string, string>): void {
  const file = path.join(gameFolder, 'libraries', 'languages.xml');
  if (!existsSync(file)) {
    return;
  }
  for (const element of parseXml(readFileSync(file, 'utf8')).elements) {
    const id = attributeNamed(element, 'id')?.value;
    const name = attributeNamed(element, 'name')?.value;
    if (element.name === 'language' && id && name) {
      into.set(String(Number(id)), name);
    }
  }
}

/** Reads the text files of the game and of extension folders. Never throws; unreadable files are skipped. */
export function loadTexts(gameFolder: string | undefined, options: TextLoadOptions = {}): TextDatabase {
  const database = new TextDatabase();
  if (gameFolder) {
    readLanguageNames(gameFolder, database.languageNames);
  }
  for (const folder of textFolders(gameFolder, options.extensionFolders)) {
    let names: string[];
    try {
      names = readdirSync(folder).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const language = languageOfTextFile(name);
      if (language === undefined || (options.languages && language !== '*' && !options.languages.has(language))) {
        continue;
      }
      try {
        database.setFile(path.join(folder, name), readFileSync(path.join(folder, name), 'utf8'), language);
      } catch {
        // A file that cannot be read is left out.
      }
    }
  }
  return database;
}
