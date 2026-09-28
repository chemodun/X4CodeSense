#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { detectDocument, scriptSchemas, schemaFolderName, type ScriptSchema } from 'x4-script-core';

interface ScriptFolder {
  folder: string;
  schema: ScriptSchema;
}

interface Finding {
  file: string;
  message: string;
}

interface Counters {
  files: number;
  scripts: number;
  patches: number;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds script folders under a root: `<root>/md`, `<root>/aiscripts` and the same one level deeper,
 * so a single extension and a folder full of extensions both work.
 */
async function collectScriptFolders(root: string): Promise<ScriptFolder[]> {
  const result: ScriptFolder[] = [];
  const candidates: string[] = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      candidates.push(path.join(root, entry.name));
    }
  }
  for (const candidate of candidates) {
    for (const schema of scriptSchemas) {
      const folder = path.join(candidate, schemaFolderName[schema]);
      if (await isDirectory(folder)) {
        result.push({ folder, schema });
      }
    }
  }
  return result;
}

async function checkFolder(scriptFolder: ScriptFolder, counters: Counters, findings: Finding[]): Promise<void> {
  for (const entry of await readdir(scriptFolder.folder, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml')) {
      continue;
    }
    const file = path.join(scriptFolder.folder, entry.name);
    counters.files++;
    const detection = detectDocument(await readFile(file, 'utf8'));
    if (detection.script) {
      counters.scripts++;
      if (detection.script.schema !== scriptFolder.schema) {
        findings.push({ file, message: `is a ${detection.script.schema} script but lies in the ${schemaFolderName[scriptFolder.schema]} folder` });
      } else if (detection.script.name === '') {
        findings.push({ file, message: 'root element has no name attribute' });
      }
    } else if (detection.isDiff) {
      counters.patches++;
    } else {
      const root = detection.rootElement ? `root element <${detection.rootElement}>` : 'no root element';
      findings.push({ file, message: `not recognised as a script or a patch (${root})` });
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const roots = argv.length > 0 ? argv : ['.'];
  const findings: Finding[] = [];
  const counters: Counters = { files: 0, scripts: 0, patches: 0 };
  let folders = 0;
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (!(await isDirectory(resolved))) {
      console.error(`Not a folder: ${resolved}`);
      return 2;
    }
    for (const scriptFolder of await collectScriptFolders(resolved)) {
      folders++;
      await checkFolder(scriptFolder, counters, findings);
    }
  }
  for (const finding of findings) {
    console.log(`${finding.file}: ${finding.message}`);
  }
  console.log(`${counters.files} file(s) in ${folders} folder(s): ${counters.scripts} script(s), ${counters.patches} patch(es), ${findings.length} finding(s)`);
  return findings.length > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  }
);
