import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Location, Range } from 'vscode-languageserver-types';
import { loadScriptProperties } from './properties/loadScriptProperties';
import type { ScriptProperties } from './properties/scriptProperties';
import type { SourceLocation } from './sourceLocation';
import { loadScriptIndex, type ScriptIndex } from './project/scriptIndex';
import { loadTexts, type TextDatabase, type TextLoadOptions } from './texts/textDatabase';
import { loadSchemas, type SchemaSet } from './xsd/loadSchemas';

/** Everything the analysis reads from an unpacked game installation. */
export interface GameData {
  /** The unpacked game folder, the one holding `libraries`, `md` and `aiscripts`. */
  folder: string;
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

/** Loads the schemas, the script properties and the texts of an unpacked game folder, the texts of extension folders, and optionally the script index. Never throws. */
export function loadGameData(unpackedFolder: string, options: GameDataOptions = {}): GameData {
  const textOptions: TextLoadOptions = options;
  const libraries = path.join(unpackedFolder, 'libraries');
  const schemas = loadSchemas(libraries);
  const properties = loadScriptProperties(libraries);
  const problems = schemas.problems.map((problem) => `${problem.file}: ${problem.message}`);
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
  const gameTexts = loadTexts(unpackedFolder, textOptions);
  problems.push(...gameTexts.problems);
  const data: GameData = { folder: unpackedFolder, schemas, problems, locationOf, texts: gameTexts };
  if (properties) {
    data.properties = properties;
  }
  if (options.index) {
    data.index = loadScriptIndex(unpackedFolder, options.extensionFolders);
  }
  return data;
}

function uriOf(file: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(file) ? file : pathToFileURL(file).toString();
}
