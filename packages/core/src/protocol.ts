import type { TextEdit } from 'vscode-languageserver-types';
import type { PatchComparison } from './patches/patchAnalysis';
import type { PatchWriteChange, PatchWriteRefusal } from './patches/patchWriter';
import type { PatchTarget } from './project/scriptIndex';
import type { ScriptMetadata } from './types';

/**
 * Custom LSP requests shared by the server and its clients.
 * Method names are namespaced with `x4codesense/` so they never collide with the protocol.
 */

/** Ask the server what it knows about an open document. */
export const DocumentInfoRequestMethod = 'x4codesense/documentInfo';

export interface DocumentInfoParams {
  /** Document URI as sent in `textDocument/didOpen`. */
  uri: string;
}

export interface DocumentInfoResult {
  /** Present when the document is an X4 script. */
  metadata?: ScriptMetadata;
  /** True when the document is a `diff` patch. */
  isDiff: boolean;
  /** Lowercased root element name, when the document is open and has one. */
  rootElement?: string;
  /** For a patch document, once the scripts are indexed: the file it changes, or why there is none. */
  patchTarget?: PatchTargetInfo;
}

export interface PatchTargetInfo extends PatchTarget {
  /** The uri the client opens the file by, when there is one: a `file:` uri, or a game document (`gameFileScheme`). */
  uri?: string;
  /** Where the file comes from: `game` or the id of an extension. */
  source?: string;
  /** The patches of the file the game applies before this one, and the merge files it merges, in load order. */
  earlier: string[];
  /** The merge files among them. */
  merged: string[];
}

/** The server tells what it is doing and what it has read, whenever that changes. */
export const StatusNotificationMethod = 'x4codesense/status';

/** Where the game files come from: extracted to a folder, or an installed game read from its catalogs. */
export type GameSource = 'extracted' | 'installed';

export interface ServerStatus {
  /** `loading` while the game's files are read, `indexing` while the scripts are, `ready` otherwise. */
  state: 'loading' | 'indexing' | 'ready';
  /**
   * The game files in use: the extracted ones (`x4CodeSense.unpackedFileLocation`), else the installed game
   * read from its catalogs (`x4CodeSense.gameFolder`); absent while neither is set.
   */
  gameFolder?: string;
  /** Which of the two the game folder is, with it. */
  gameSource?: GameSource;
  /** The installed game's version as its `version.dat` gives it, `900` for 9.00; absent for extracted files. */
  gameVersion?: string;
  /** The schemas read from its `libraries` folder, by name. */
  schemas: string[];
  /** True when `scriptproperties.xml` was read. */
  properties: boolean;
  /** The texts read, and the number of files they come from. */
  texts: number;
  textFiles: number;
  /**
   * The script files indexed, and by id in load order the extensions read: those in the game folder (its
   * DLCs) and the others. None until the index is built.
   */
  scripts: number;
  dlcs: string[];
  extensions: string[];
  /** How many problems reading the game's files met; the output lists them. */
  problems: number;
}

/**
 * The client tells the server the files of its editor tabs, whenever they change. The editor loads a
 * restored tab only when it is shown, so until then the server has not been sent it as an open document;
 * it checks such files as they are on disk, as the user sees them open.
 */
export const EditorTabsNotificationMethod = 'x4codesense/editorTabs';

export interface EditorTabsParams {
  /** The `file:` uris of the XML files in the tabs of every editor group. */
  uris: string[];
}

/** Ask for the file a patch document changes, as the game loads it before the patch and after it; null for other documents. */
export const PatchComparisonRequestMethod = 'x4codesense/patchComparison';

export type PatchComparisonParams = DocumentInfoParams;

/** With the version of the patch document the answer was worked out for. */
export type PatchComparisonResult = (PatchComparison & { version: number }) | null;

/**
 * The schemes of the two sides of a patch comparison: the file before the patch (read only), and after it
 * (editable). The patch document's uri is the `patch` parameter of the query.
 */
export const patchBeforeScheme = 'x4codesense-patch';
export const patchAfterScheme = 'x4codesense-patched';

/**
 * Ask what a patch must become so that the file it changes, with the patch applied, is the edited text of
 * the comparison's side with the patch.
 */
export const PatchWriteRequestMethod = 'x4codesense/patchWrite';

export interface PatchWriteParams {
  /** The patch document. */
  uri: string;
  /** The version of the patch document the side was last in step with. */
  version: number;
  /** The side's text. */
  edited: string;
}

export interface PatchWriteResult {
  /** The edits of the patch document; none when a change cannot be written. */
  edits: TextEdit[];
  changes: PatchWriteChange[];
  refused: PatchWriteRefusal[];
}

/**
 * The scheme of the game's files read from an installed game's catalogs, which have no file on disk: read
 * only documents whose path is the file's in the game folder, `x4codesense-game:/md/setup.xml`. The server
 * sends every place in such a file under this scheme, and gives the text.
 */
export const gameFileScheme = 'x4codesense-game';

/** Ask for the text of a game document; null when the game files read now have no such file. */
export const GameFileRequestMethod = 'x4codesense/gameFile';

export type GameFileParams = DocumentInfoParams;

export type GameFileResult = { text: string } | null;
