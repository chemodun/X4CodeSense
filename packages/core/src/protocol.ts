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
}
