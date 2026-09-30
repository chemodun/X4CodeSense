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
  /** Where the file comes from: `game` or the id of an extension. */
  source?: string;
  /** The patches of the file the game applies before this one, in load order. */
  earlier: string[];
}

/** The server tells what it is doing and what it has read, whenever that changes. */
export const StatusNotificationMethod = 'x4codesense/status';

export interface ServerStatus {
  /** `loading` while the game's files are read, `indexing` while the scripts are, `ready` otherwise. */
  state: 'loading' | 'indexing' | 'ready';
  /** The extracted game files in use; absent while `x4CodeSense.unpackedFileLocation` is not set. */
  gameFolder?: string;
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

/** Ask for the file a patch document changes, as the game loads it before the patch and after it; null for other documents. */
export const PatchComparisonRequestMethod = 'x4codesense/patchComparison';

export type PatchComparisonParams = DocumentInfoParams;

/** With the version of the patch document the answer was worked out for. */
export type PatchComparisonResult = (PatchComparison & { version: number }) | null;

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
