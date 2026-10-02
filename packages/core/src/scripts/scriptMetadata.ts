import type { DocumentDetection, ScriptMetadata, ScriptRootElement, ScriptSchema } from '../types';
import { attributeNamed, parseXml, type XmlElement } from '../xml/xmlStructure';

const rootElementToSchema: Record<ScriptRootElement, ScriptSchema> = {
  aiscript: 'aiscripts',
  mdscript: 'md',
};

/** All script schemas, in a stable order. */
export const scriptSchemas: readonly ScriptSchema[] = ['aiscripts', 'md'];

/** Human readable schema names for UI text. */
export const schemaDisplayName: Record<ScriptSchema, string> = {
  aiscripts: 'AI script',
  md: 'Mission Director script',
};

/** Folder name that holds scripts of a schema inside an extension or the vanilla tree. */
export const schemaFolderName: Record<ScriptSchema, string> = {
  aiscripts: 'aiscripts',
  md: 'md',
};

export function isScriptSchema(value: string): value is ScriptSchema {
  return (scriptSchemas as readonly string[]).includes(value);
}

function isScriptRootElement(value: string): value is ScriptRootElement {
  return value in rootElementToSchema;
}

const schemaLocationAttribute = 'xsi:nonamespaceschemalocation';

/**
 * Reads the first start tag of an XML text without scanning the rest.
 * Tolerant of a BOM, a prolog, comments and processing instructions before the root.
 * Returns nothing while the start tag of a new file is still being typed, so a document does not change
 * its kind before the tag is complete; a root start tag without its `>` before the rest of a file, which
 * its end tag closes, still counts (the scanner keeps it open), so the file stays what it is.
 */
function firstStartTag(text: string): XmlElement | undefined {
  const root = parseXml(text, { stopAfterFirstStartTag: true }).elements[0];
  return root && (root.startTagClosed || !root.selfClosing) ? root : undefined;
}

/** Root element of a patch document. */
const diffRootElement = 'diff';

/**
 * Classifies an XML text by its root element: script, patch or something else.
 * For scripts the root element decides the schema; `xsi:noNamespaceSchemaLocation` is only recorded
 * so a later diagnostic can flag a mismatch, it never overrides the root element.
 */
export function detectDocument(text: string): DocumentDetection {
  const root = firstStartTag(text);
  if (!root) {
    return { isDiff: false };
  }
  const rootElement = root.name.toLowerCase();
  const detection: DocumentDetection = { rootElement, isDiff: rootElement === diffRootElement };
  if (isScriptRootElement(rootElement)) {
    const script: ScriptMetadata = {
      schema: rootElementToSchema[rootElement],
      rootElement,
      name: attributeNamed(root, 'name')?.value ?? '',
    };
    const schemaLocation = root.attributes.find((attribute) => attribute.name.toLowerCase() === schemaLocationAttribute);
    if (schemaLocation !== undefined) {
      script.schemaLocation = schemaLocation.value;
    }
    detection.script = script;
  }
  return detection;
}

/** Script metadata of an XML text, or undefined when it is not an AI script or a Mission Director script. */
export function getMetadata(text: string): ScriptMetadata | undefined {
  return detectDocument(text).script;
}

/**
 * Schema name taken from a `xsi:noNamespaceSchemaLocation` value such as `../libraries/md.xsd`,
 * or undefined when the value does not point at a known script schema.
 */
export function schemaFromLocation(schemaLocation: string): ScriptSchema | undefined {
  const fileName = schemaLocation.replace(/\\/g, '/').split('/').pop() ?? '';
  const schema = fileName.replace(/\.xsd$/i, '').toLowerCase();
  return isScriptSchema(schema) ? schema : undefined;
}
