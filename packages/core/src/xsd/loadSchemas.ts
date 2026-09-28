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
  /** Problems found while reading or compiling, for logging. */
  problems: XsdProblem[];
}

/** Root element name of each script schema. */
export const rootElementName: Record<ScriptSchema, string> = {
  aiscripts: 'aiscript',
  md: 'mdscript',
};

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

/**
 * Loads `md.xsd` and `aiscripts.xsd` from a folder, following their includes (`common.xsd`).
 * Missing files are reported, not thrown; the returned set holds whatever could be loaded.
 */
export function loadSchemas(librariesFolder: string): SchemaSet {
  const set: SchemaSet = { folder: librariesFolder, schemas: {}, problems: [] };
  for (const schemaName of scriptSchemas) {
    const entry = path.join(librariesFolder, `${schemaName}.xsd`);
    if (!existsSync(entry)) {
      set.problems.push({ file: entry, message: 'file not found' });
      continue;
    }
    const files: XsdFile[] = [];
    collectFiles(entry, files, new Set(), set.problems);
    const schema = new XsdSchema(schemaName, files);
    set.problems.push(...schema.problems);
    set.schemas[schemaName] = schema;
  }
  return set;
}
