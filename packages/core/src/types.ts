/** The two script languages, named after their XSD schema files. */
export type ScriptSchema = 'aiscripts' | 'md';

/** Root element of a script document. */
export type ScriptRootElement = 'aiscript' | 'mdscript';

/** What the first start tag of a script document tells about it. */
export interface ScriptMetadata {
  /** Schema derived from the root element. */
  schema: ScriptSchema;
  /** Root element name, lowercased. */
  rootElement: ScriptRootElement;
  /** Value of the root element's `name` attribute, empty when absent. */
  name: string;
  /** Value of `xsi:noNamespaceSchemaLocation` on the root element, when present. */
  schemaLocation?: string;
}

/** Result of looking at the first start tag of any XML document. */
export interface DocumentDetection {
  /** Lowercased root element name, undefined when no start tag could be read. */
  rootElement?: string;
  /** Present when the document is an AI script or a Mission Director script. */
  script?: ScriptMetadata;
  /**
   * True when the root element is `diff`: a patch the game applies to another XML document.
   * Extensions keep such patches next to their scripts, in `aiscripts` and `md` folders.
   */
  isDiff: boolean;
}
