import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { scriptSchemas } from '../scripts/scriptMetadata';
import type { ScriptSchema } from '../types';
import { attributeNamed, parseXml } from '../xml/xmlStructure';
import { XsdSchema, type XsdFile, type XsdProblem } from './schema';

/** The script schemas of one game installation, loaded from its `libraries` folder. */
export interface SchemaSet {
  /** The folder the schemas were read from. */
  folder: string;
  /** Loaded schemas by name; a schema whose file is missing is absent. */
  schemas: Partial<Record<ScriptSchema, XsdSchema>>;
  /** `diff.xsd`, the schema of patch documents: `<diff>` and its `add`, `replace` and `remove`. */
  diff?: XsdSchema;
  /** Problems found while reading or compiling, for logging. */
  problems: XsdProblem[];
}

/** Root element name of each script schema. */
export const rootElementName: Record<ScriptSchema, string> = {
  aiscripts: 'aiscript',
  md: 'mdscript',
};

/** The schema of patch documents, and their root element. */
export const diffSchemaName = 'diff';

/** Files an XSD file includes, resolved against its folder, in order and without duplicates. */
function collectFiles(entry: string, into: XsdFile[], seen: Set<string>, problems: XsdProblem[]): void {
  const resolved = path.resolve(entry);
  if (seen.has(resolved)) {
    return;
  }
  seen.add(resolved);
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch (error) {
    problems.push({ file: resolved, message: `cannot read: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  into.push({ path: resolved, text });
  const root = parseXml(text, { stopAfterFirstStartTag: false }).roots[0];
  for (const child of root?.children ?? []) {
    const name = child.name.slice(child.name.indexOf(':') + 1);
    if (name !== 'include' && name !== 'import') {
      continue;
    }
    const location = attributeNamed(child, 'schemaLocation')?.value;
    if (location !== undefined) {
      collectFiles(path.resolve(path.dirname(resolved), location), into, seen, problems);
    }
  }
}

/** Loads one schema file with the files it includes; undefined, with a problem, when it is missing. */
function loadSchema(librariesFolder: string, name: string, problems: XsdProblem[]): XsdSchema | undefined {
  const entry = path.join(librariesFolder, `${name}.xsd`);
  if (!existsSync(entry)) {
    problems.push({ file: entry, message: 'file not found' });
    return undefined;
  }
  const files: XsdFile[] = [];
  collectFiles(entry, files, new Set(), problems);
  const schema = new XsdSchema(name, files);
  problems.push(...schema.problems);
  return schema;
}

/**
 * Loads `md.xsd` and `aiscripts.xsd` from a folder, following their includes (`common.xsd`), and
 * `diff.xsd`. Missing files are reported, not thrown; the returned set holds whatever could be loaded.
 */
export function loadSchemas(librariesFolder: string): SchemaSet {
  const set: SchemaSet = { folder: librariesFolder, schemas: {}, problems: [] };
  for (const schemaName of scriptSchemas) {
    const schema = loadSchema(librariesFolder, schemaName, set.problems);
    if (schema) {
      set.schemas[schemaName] = schema;
    }
  }
  const diff = loadSchema(librariesFolder, diffSchemaName, set.problems);
  if (diff) {
    set.diff = diff;
  }
  return set;
}
