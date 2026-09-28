#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyzeDocument, loadSchemas, scriptSchemas, schemaFolderName, type AnalysisContext, type ScriptSchema } from 'x4-script-core';

interface ScriptFolder {
  folder: string;
  schema: ScriptSchema;
}

interface Finding {
  file: string;
  /** 1-based line and column, absent for findings about the whole file. */
  line?: number;
  column?: number;
  message: string;
}

interface Counters {
  files: number;
  scripts: number;
  patches: number;
}

interface Options {
  roots: string[];
  /** The extracted game files, whose `libraries` folder holds the schemas. */
  unpacked?: string;
  /** Check the order and completeness of child elements. */
  structure: boolean;
  help: boolean;
}

const usage = `Usage: x4-script-check [options] [folder...]

Checks every *.xml file in the md and aiscripts folders found directly under each given folder
(default: the current folder) and one level deeper.

Options:
  --unpacked <folder>   extracted vanilla game files; enables validation against the game schemas
                        (also read from the X4_UNPACKED environment variable)
  --no-structure        do not check the order and completeness of child elements
  -h, --help            show this help

Exit code 1 when there are findings, 2 on a usage error.`;

function parseOptions(argv: string[]): Options {
  const options: Options = { roots: [], structure: true, help: false };
  const unpacked = process.env.X4_UNPACKED;
  if (unpacked !== undefined && unpacked !== '') {
    options.unpacked = unpacked;
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--unpacked') {
      const value = argv[++index];
      if (value === undefined) {
        throw new Error('--unpacked needs a folder');
      }
      options.unpacked = value;
    } else if (argument.startsWith('--unpacked=')) {
      options.unpacked = argument.slice('--unpacked='.length);
    } else if (argument === '--no-structure') {
      options.structure = false;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option ${argument}`);
    } else {
      options.roots.push(argument);
    }
  }
  if (options.roots.length === 0) {
    options.roots.push('.');
  }
  return options;
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

async function checkFile(file: string, schema: ScriptSchema, context: AnalysisContext, counters: Counters, findings: Finding[]): Promise<void> {
  counters.files++;
  const document = TextDocument.create(pathToFileURL(file).toString(), 'xml', 0, await readFile(file, 'utf8'));
  const analysis = analyzeDocument(document, context);
  const detection = analysis.detection;
  if (detection.script) {
    counters.scripts++;
    if (detection.script.schema !== schema) {
      findings.push({ file, message: `is a ${detection.script.schema} script but lies in the ${schemaFolderName[schema]} folder` });
    } else if (detection.script.name === '') {
      findings.push({ file, message: 'root element has no name attribute' });
    }
  } else if (detection.isDiff) {
    counters.patches++;
  } else {
    const root = detection.rootElement ? `root element <${detection.rootElement}>` : 'no root element';
    findings.push({ file, message: `not recognised as a script or a patch (${root})` });
  }
  for (const diagnostic of analysis.diagnostics) {
    const code = diagnostic.code === undefined ? '' : ` [${diagnostic.code}]`;
    findings.push({ file, line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1, message: `${diagnostic.message}${code}` });
  }
}

async function checkFolder(scriptFolder: ScriptFolder, context: AnalysisContext, counters: Counters, findings: Finding[]): Promise<void> {
  for (const entry of await readdir(scriptFolder.folder, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml')) {
      continue;
    }
    await checkFile(path.join(scriptFolder.folder, entry.name), scriptFolder.schema, context, counters, findings);
  }
}

function formatFinding(finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}:${finding.column}`;
  return `${location}: ${finding.message}`;
}

async function main(argv: string[]): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const context: AnalysisContext = { validateStructure: options.structure };
  if (options.unpacked !== undefined) {
    const libraries = path.join(path.resolve(options.unpacked), 'libraries');
    if (!(await isDirectory(libraries))) {
      console.error(`Not a folder: ${libraries}`);
      return 2;
    }
    context.schemas = loadSchemas(libraries);
    for (const problem of context.schemas.problems) {
      console.error(`${problem.file}: ${problem.message}`);
    }
    if (Object.keys(context.schemas.schemas).length === 0) {
      return 2;
    }
  }
  const findings: Finding[] = [];
  const counters: Counters = { files: 0, scripts: 0, patches: 0 };
  let folders = 0;
  for (const root of options.roots) {
    const resolved = path.resolve(root);
    if (!(await isDirectory(resolved))) {
      console.error(`Not a folder: ${resolved}`);
      return 2;
    }
    for (const scriptFolder of await collectScriptFolders(resolved)) {
      folders++;
      await checkFolder(scriptFolder, context, counters, findings);
    }
  }
  for (const finding of findings) {
    console.log(formatFinding(finding));
  }
  const validation = context.schemas ? '' : ' (no schema validation: pass --unpacked)';
  console.log(
    `${counters.files} file(s) in ${folders} folder(s): ${counters.scripts} script(s), ${counters.patches} patch(es), ${findings.length} finding(s)${validation}`
  );
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
