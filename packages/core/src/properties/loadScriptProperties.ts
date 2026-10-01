import * as path from 'node:path';
import { diskFiles, type FileSource } from '../files/fileSource';
import { scriptPropertiesAdditions } from './additions';
import { ScriptProperties, type PropertySource } from './scriptProperties';

/** Path the additions report as their file; it does not exist on disk. */
export const additionsPath = 'x4codesense://scriptproperties.additions.xml';

/**
 * Loads `scriptproperties.xml` from a `libraries` folder together with the built-in additions; `import`
 * sources are read from the same folder. Returns undefined when the file is missing.
 */
export function loadScriptProperties(librariesFolder: string, files: FileSource = diskFiles): ScriptProperties | undefined {
  const mainPath = path.join(librariesFolder, 'scriptproperties.xml');
  if (!files.exists(mainPath)) {
    return undefined;
  }
  const readImport = (source: string): PropertySource | undefined => {
    const file = path.join(librariesFolder, source);
    try {
      return { path: file, text: files.readText(file) };
    } catch {
      return undefined;
    }
  };
  return ScriptProperties.parse({
    main: { path: mainPath, text: files.readText(mainPath) },
    additions: [{ path: additionsPath, text: scriptPropertiesAdditions }],
    readImport,
  });
}
