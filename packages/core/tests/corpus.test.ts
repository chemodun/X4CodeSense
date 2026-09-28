/**
 * Corpus gates against local data that never enters the repository.
 * - X4_EXTRACTED: an extracted game folder (the one holding `md` and `aiscripts`); every script must be recognised.
 * - X4_MODS: a folder with many extensions; every file in their `md` and `aiscripts` folders must be a script or a patch.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectDocument, getMetadata, scriptSchemas, schemaFolderName } from '../src';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

function subfolders(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(folder, entry.name));
  } catch {
    return [];
  }
}

function xmlFilesIn(folder: string): string[] {
  try {
    if (!statSync(folder).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.xml'))
    .map((name) => path.join(folder, name));
}

describe.skipIf(!extracted)('vanilla corpus', () => {
  for (const schema of scriptSchemas) {
    it(`recognises every ${schema} file`, () => {
      const files = xmlFilesIn(path.join(extracted ?? '', schemaFolderName[schema]));
      expect(files.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const file of files) {
        const metadata = getMetadata(readFileSync(file, 'utf8'));
        if (!metadata || metadata.schema !== schema || metadata.name === '') {
          failures.push(`${path.basename(file)}: ${metadata ? `${metadata.schema} '${metadata.name}'` : 'not recognised'}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('does not mistake library files for scripts', () => {
    const files = xmlFilesIn(path.join(extracted ?? '', 'libraries'));
    const recognised = files.filter((file) => getMetadata(readFileSync(file, 'utf8')) !== undefined);
    expect(recognised).toEqual([]);
  });
});

describe.skipIf(!mods)('mods corpus', () => {
  it('classifies every file in md and aiscripts folders as a script of that kind or a patch', () => {
    const failures: string[] = [];
    let files = 0;
    for (const mod of subfolders(mods ?? '')) {
      for (const schema of scriptSchemas) {
        for (const file of xmlFilesIn(path.join(mod, schemaFolderName[schema]))) {
          files++;
          const detection = detectDocument(readFileSync(file, 'utf8'));
          const relative = path.relative(mods ?? '', file);
          if (detection.script) {
            if (detection.script.schema !== schema) {
              failures.push(`${relative}: ${detection.script.schema} script in the ${schemaFolderName[schema]} folder`);
            }
          } else if (!detection.isDiff) {
            failures.push(`${relative}: root '${detection.rootElement ?? ''}'`);
          }
        }
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
