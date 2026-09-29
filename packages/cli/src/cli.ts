#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  analyzeDocument,
  loadGameData,
  quickFixes,
  scriptSchemas,
  schemaFolderName,
  type AnalysisContext,
  type GameData,
  type ScriptSchema,
} from 'x4-script-core';

interface ScriptFolder {
  folder: string;
  schema: ScriptSchema;
}

/** The severities of findings, the most severe first, as the text output and `--fail-on` name them. */
const severities = ['error', 'warning', 'info', 'hint'] as const;
type Severity = (typeof severities)[number];

const formats = ['text', 'json', 'github'] as const;
type Format = (typeof formats)[number];

/** An LSP range: lines and characters count from 0, characters in UTF-16 code units, the end is exclusive. */
interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface Fix {
  title: string;
  /** The fix an editor would apply on its own: the only one, or clearly the best. */
  preferred: boolean;
  edits: { range: Range; newText: string }[];
}

interface Finding {
  file: string;
  /** Absent for findings about the whole file. */
  range?: Range;
  severity: Severity;
  code: string;
  message: string;
  fixes: Fix[];
}

interface Counters {
  files: number;
  folders: number;
  scripts: number;
  patches: number;
}

interface Options {
  roots: string[];
  /** The extracted game files, whose `libraries` folder holds the schemas. */
  unpacked?: string;
  /** Folders of other extensions the checked ones depend on: read for texts and scripts, not checked. */
  extensions: string[];
  /** Check the order and completeness of child elements. */
  structure: boolean;
  format: Format;
  /** The least severe finding that fails the check. */
  failOn: Severity;
  help: boolean;
}

const usage = `Usage: x4-script-check [options] [folder...]

Checks every *.xml file in the md and aiscripts folders found directly under each given folder
(default: the current folder) and one level deeper, and in the extensions/<folder>/md and
.../aiscripts folders there, which hold patches of other extensions. With --unpacked, a patch is
applied to the file it changes: the game's, or the named extension's.

Options:
  --unpacked <folder>   extracted vanilla game files; enables validation against the game schemas
                        (also read from the X4_UNPACKED environment variable)
  --extensions <folder> other extensions the checked ones refer to: their texts and scripts are
                        read, they are not checked; may be given several times
  --no-structure        do not check the order and completeness of child elements
  --format <format>     text: a line per finding, file:line:column: severity: message [code], and
                        a line per quick fix (default)
                        json: the findings with their ranges and quick fixes, and the counts
                        github: workflow commands that annotate the files in GitHub Actions
  --fail-on <severity>  the least severe finding that fails the check: error, warning, info or
                        hint (default: hint, so any finding)
  -h, --help            show this help

Exit code 1 when there are findings as severe as --fail-on or more, 2 on a usage error.`;

/** The options that take a value, with what the value is. */
const valueOptions = new Map([
  ['--unpacked', 'a folder'],
  ['--extensions', 'a folder'],
  ['--format', `one of ${formats.join(', ')}`],
  ['--fail-on', `one of ${severities.join(', ')}`],
]);

function oneOf<T extends string>(option: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`${option} needs ${valueOptions.get(option)}, not '${value}'`);
  }
  return found;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { roots: [], extensions: [], structure: true, format: 'text', failOn: 'hint', help: false };
  const unpacked = process.env.X4_UNPACKED;
  if (unpacked !== undefined && unpacked !== '') {
    options.unpacked = unpacked;
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const needs = valueOptions.get(name);
    if (needs !== undefined) {
      const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
      if (value === undefined) {
        throw new Error(`${name} needs ${needs}`);
      }
      if (name === '--unpacked') {
        options.unpacked = value;
      } else if (name === '--extensions') {
        options.extensions.push(value);
      } else if (name === '--format') {
        options.format = oneOf(name, value, formats);
      } else {
        options.failOn = oneOf(name, value, severities);
      }
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

/** Orders names the same way on every system, so the output does too. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function subfolders(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort(byName)
      .map((entry) => path.join(folder, entry.name));
  } catch {
    return [];
  }
}

/**
 * Finds script folders under a root: `<root>/md`, `<root>/aiscripts` and the same one level deeper,
 * so a single extension and a folder full of extensions both work; also the patches of other
 * extensions an extension keeps in `extensions/<folder>/md` and `.../aiscripts`.
 */
async function collectScriptFolders(root: string): Promise<ScriptFolder[]> {
  const result: ScriptFolder[] = [];
  const candidates: string[] = [root, ...(await subfolders(root))];
  for (const candidate of [...candidates]) {
    candidates.push(...(await subfolders(path.join(candidate, 'extensions'))));
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

/** Findings about the whole file first, then by position. */
function byPosition(a: Finding, b: Finding): number {
  const first = a.range?.start ?? { line: -1, character: -1 };
  const second = b.range?.start ?? { line: -1, character: -1 };
  return first.line - second.line || first.character - second.character;
}

async function checkFile(file: string, schema: ScriptSchema, context: AnalysisContext, game: GameData | undefined, counters: Counters): Promise<Finding[]> {
  counters.files++;
  const document = TextDocument.create(pathToFileURL(file).toString(), 'xml', 0, await readFile(file, 'utf8'));
  const analysis = analyzeDocument(document, context);
  const detection = analysis.detection;
  const findings: Finding[] = [];
  const aboutFile = (code: string, message: string): void => {
    findings.push({ file, severity: 'error', code, message, fixes: [] });
  };
  if (detection.script) {
    counters.scripts++;
    if (detection.script.schema !== schema) {
      aboutFile('script-in-wrong-folder', `is a ${detection.script.schema} script but lies in the ${schemaFolderName[schema]} folder`);
    } else if (detection.script.name === '') {
      aboutFile('script-without-name', 'root element has no name attribute');
    }
  } else if (detection.isDiff) {
    counters.patches++;
  } else {
    const root = detection.rootElement ? `root element <${detection.rootElement}>` : 'no root element';
    aboutFile('not-a-script', `not recognised as a script or a patch (${root})`);
  }
  const actions = analysis.diagnostics.length === 0 ? [] : quickFixes(analysis, analysis.diagnostics, game);
  for (const diagnostic of analysis.diagnostics) {
    const fixes = actions
      .filter((action) => action.diagnostics?.includes(diagnostic))
      .map((action) => ({ title: action.title, preferred: action.isPreferred === true, edits: action.edit?.changes?.[document.uri] ?? [] }));
    findings.push({
      file,
      range: diagnostic.range,
      severity: severities[(diagnostic.severity ?? 1) - 1],
      code: diagnostic.code === undefined ? '' : String(diagnostic.code),
      message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
      fixes,
    });
  }
  return findings.sort(byPosition);
}

async function checkFolder(scriptFolder: ScriptFolder, context: AnalysisContext, game: GameData | undefined, counters: Counters): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const entry of (await readdir(scriptFolder.folder, { withFileTypes: true })).sort(byName)) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
      findings.push(...(await checkFile(path.join(scriptFolder.folder, entry.name), scriptFolder.schema, context, game, counters)));
    }
  }
  return findings;
}

function textLines(findings: readonly Finding[]): string[] {
  const lines: string[] = [];
  for (const finding of findings) {
    const start = finding.range?.start;
    const location = start ? `${finding.file}:${start.line + 1}:${start.character + 1}` : finding.file;
    const code = finding.code === '' ? '' : ` [${finding.code}]`;
    lines.push(`${location}: ${finding.severity}: ${finding.message}${code}`);
    for (const fix of finding.fixes) {
      lines.push(`  fix: ${fix.title}`);
    }
  }
  return lines;
}

/** Escapes the message of a GitHub workflow command. */
function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escapes a property value of a GitHub workflow command. */
function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

const githubCommands: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'notice', hint: 'notice' };

/**
 * A workflow command that annotates the file in GitHub Actions. The file is named relative to the
 * current folder, which is the checked-out repository in a workflow; columns only for a range on one
 * line, as GitHub takes them.
 */
function githubLine(finding: Finding): string {
  const relative = path.relative(process.cwd(), finding.file);
  const inside = relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
  const properties = [`file=${escapeProperty((inside ? relative : finding.file).split(path.sep).join('/'))}`];
  if (finding.range) {
    const { start, end } = finding.range;
    properties.push(`line=${start.line + 1}`, `endLine=${end.line + 1}`);
    if (start.line === end.line) {
      properties.push(`col=${start.character + 1}`, `endColumn=${end.character + 1}`);
    }
  }
  if (finding.code !== '') {
    properties.push(`title=${escapeProperty(finding.code)}`);
  }
  const message = [finding.message, ...finding.fixes.map((fix) => `Fix: ${fix.title}`)].join('\n');
  return `::${githubCommands[finding.severity]} ${properties.join(',')}::${escapeData(message)}`;
}

function countOf(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

const counted: Record<Severity, string> = { error: 'error(s)', warning: 'warning(s)', info: 'info', hint: 'hint(s)' };

function summaryLine(findings: readonly Finding[], counters: Counters, validated: boolean): string {
  const notes = severities.filter((severity) => countOf(findings, severity) > 0).map((severity) => `${countOf(findings, severity)} ${counted[severity]}`);
  const details = [...(notes.length > 0 ? [notes.join(', ')] : []), ...(validated ? [] : ['no schema validation: pass --unpacked'])];
  const counts = `${counters.files} file(s) in ${counters.folders} folder(s): ${counters.scripts} script(s), ${counters.patches} patch(es), ${findings.length} finding(s)`;
  return details.length === 0 ? counts : `${counts} (${details.join('; ')})`;
}

function jsonReport(findings: readonly Finding[], counters: Counters, validated: boolean, problems: readonly string[]): string {
  const report = {
    findings: findings.map((finding) => ({
      file: finding.file,
      ...(finding.range ? { line: finding.range.start.line + 1, column: finding.range.start.character + 1, range: finding.range } : {}),
      severity: finding.severity,
      code: finding.code,
      message: finding.message,
      fixes: finding.fixes,
    })),
    summary: {
      ...counters,
      findings: findings.length,
      errors: countOf(findings, 'error'),
      warnings: countOf(findings, 'warning'),
      info: countOf(findings, 'info'),
      hints: countOf(findings, 'hint'),
      schemaValidation: validated,
    },
    problems,
  };
  return JSON.stringify(report, null, 2);
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
  let game: GameData | undefined;
  if (options.unpacked !== undefined) {
    const unpacked = path.resolve(options.unpacked);
    const libraries = path.join(unpacked, 'libraries');
    if (!(await isDirectory(libraries))) {
      console.error(`Not a folder: ${libraries}`);
      return 2;
    }
    for (const folder of options.extensions) {
      if (!(await isDirectory(path.resolve(folder)))) {
        console.error(`Not a folder: ${path.resolve(folder)}`);
        return 2;
      }
    }
    // The checked folders count as well: an extension refers to its own texts and scripts.
    const extensionFolders = [...options.extensions, ...options.roots].map((folder) => path.resolve(folder));
    game = loadGameData(unpacked, { extensionFolders, index: true });
    for (const problem of game.problems) {
      console.error(problem);
    }
    if (Object.keys(game.schemas.schemas).length === 0) {
      return 2;
    }
    context.schemas = game.schemas;
    context.texts = game.texts;
    if (game.index) {
      context.index = game.index;
    }
    if (game.properties) {
      context.properties = game.properties;
    }
  }
  const findings: Finding[] = [];
  const counters: Counters = { files: 0, folders: 0, scripts: 0, patches: 0 };
  for (const root of options.roots) {
    const resolved = path.resolve(root);
    if (!(await isDirectory(resolved))) {
      console.error(`Not a folder: ${resolved}`);
      return 2;
    }
    for (const scriptFolder of await collectScriptFolders(resolved)) {
      counters.folders++;
      findings.push(...(await checkFolder(scriptFolder, context, game, counters)));
    }
  }
  const validated = context.schemas !== undefined;
  if (options.format === 'json') {
    console.log(jsonReport(findings, counters, validated, game?.problems ?? []));
  } else {
    const lines = options.format === 'github' ? findings.map(githubLine) : textLines(findings);
    for (const line of lines) {
      console.log(line);
    }
    console.log(summaryLine(findings, counters, validated));
  }
  const failing = severities.indexOf(options.failOn);
  return findings.some((finding) => severities.indexOf(finding.severity) <= failing) ? 1 : 0;
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
