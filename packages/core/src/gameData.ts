import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Location, Range } from 'vscode-languageserver-types';
import { diskFiles, type FileSource } from './files/fileSource';
import { loadScriptProperties } from './properties/loadScriptProperties';
import type { ScriptProperties } from './properties/scriptProperties';
import type { SourceLocation } from './sourceLocation';
import { loadScriptIndex, type ScriptIndex } from './project/scriptIndex';
import { loadTexts, type TextDatabase, type TextLoadOptions } from './texts/textDatabase';
import { loadSchemas, type SchemaSet } from './xsd/loadSchemas';

/** Everything the analysis reads from the game: extracted, or installed and read from its catalogs. */
export interface GameData {
  /** The game folder: the extracted one, holding `libraries`, `md` and `aiscripts`, or the installed one. */
  folder: string;
  /** Where the game's files and the extensions' are read from. */
  files: FileSource;
  schemas: SchemaSet;
  /** Absent when `libraries/scriptproperties.xml` is missing. */
  properties?: ScriptProperties;
  /** Texts of the game and of the extension folders it was loaded with; replaceable when those change. */
  texts: TextDatabase;
  /**
   * The scripts of the game and of the extension folders, for references between scripts. Absent until
   * built: `loadGameData` builds it when asked, a server may build it later without blocking.
   */
  index?: ScriptIndex;
  /** Problems found while loading, for logging. */
  problems: string[];
  /** Converts a location in a game data file into an LSP location. */
  locationOf(location: SourceLocation): Location | undefined;
}

export interface GameDataOptions extends TextLoadOptions {
  /** Also index the scripts of the game and of the extension folders. */
  index?: boolean;
}

/**
 * Loads the schemas, the script properties and the texts of a game folder, the texts of extension folders,
 * and optionally the script index; an installed game's through `options.files` (`openInstalledGame`).
 * Never throws.
 */
export function loadGameData(gameFolder: string, options: GameDataOptions = {}): GameData {
  const files = options.files ?? diskFiles;
  const textOptions: TextLoadOptions = { ...options, files };
  const libraries = path.join(gameFolder, 'libraries');
  const schemas = loadSchemas(libraries, files);
  const properties = loadScriptProperties(libraries, files);
  const problems = [...(files.problems ?? []), ...schemas.problems.map((problem) => `${problem.file}: ${problem.message}`)];
  if (properties) {
    problems.push(...properties.problems);
  } else {
    problems.push(`${path.join(libraries, 'scriptproperties.xml')}: file not found`);
  }
  const texts = new Map<string, string>();
  for (const schema of Object.values(schemas.schemas)) {
    for (const file of schema.files) {
      texts.set(file.path, file.text);
    }
  }
  for (const [file, text] of properties?.sources ?? []) {
    texts.set(file, text);
  }
  const documents = new Map<string, TextDocument>();
  const locationOf = (location: SourceLocation): Location | undefined => {
    const text = texts.get(location.file);
    if (text === undefined) {
      return undefined;
    }
    let document = documents.get(location.file);
    if (!document) {
      document = TextDocument.create(uriOf(location.file), 'xml', 0, text);
      documents.set(location.file, document);
    }
    return Location.create(document.uri, Range.create(document.positionAt(location.start), document.positionAt(location.end)));
  };
  const gameTexts = loadTexts(gameFolder, textOptions);
  problems.push(...gameTexts.problems);
  const data: GameData = { folder: gameFolder, files, schemas, problems, locationOf, texts: gameTexts };
  if (properties) {
    data.properties = properties;
  }
  if (options.index) {
    data.index = loadScriptIndex(gameFolder, options.extensionFolders, schemas, files);
  }
  return data;
}

function uriOf(file: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(file) ? file : pathToFileURL(file).toString();
}

/**
 * True when the file is one of the game's, its DLCs' included: in the game folder, and in its `extensions`
 * only in a DLC's folder (an installed game's `extensions` holds the player's mods as well).
 */
export function isGameFile(file: string, game: GameData | undefined): boolean {
  if (!game || file === '') {
    return false;
  }
  const relative = path.relative(game.folder, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  const [top, extension] = relative.split(/[\\/]+/);
  const bundled = game.files.bundledExtensions;
  if (top.toLowerCase() !== 'extensions' || !bundled) {
    return true;
  }
  return extension !== undefined && bundled.some((folder) => path.basename(folder).toLowerCase() === extension.toLowerCase());
}
