#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  analyzeDocument,
  diagnosticDescriptions,
  fixAll,
  loadGameData,
  quickFixes,
  scriptSchemas,
  schemaFolderName,
  type AnalysisContext,
  type DocumentAnalysis,
  type GameData,
  type ScriptSchema,
} from 'x4-script-core';

type Diagnostic = DocumentAnalysis['diagnostics'][number];

interface ScriptFolder {
  folder: string;
  schema: ScriptSchema;
}

/** The severities of findings, the most severe first, as the text output and `--fail-on` name them. */
const severities = ['error', 'warning', 'info', 'hint'] as const;
type Severity = (typeof severities)[number];

const formats = ['text', 'json', 'github', 'sarif'] as const;
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

/** A fix `--fix` applied, with the problem it fixed. */
interface Applied {
  file: string;
  range: Range;
  code: string;
  message: string;
  title: string;
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
  /** Apply the preferred fixes to the files before checking them. */
  fix: boolean;
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
  --fix                 apply the preferred quick fixes to the files first, as the editor's fix
                        all does, then report what is left
  --format <format>     text: a line per finding, file:line:column: severity: message [code], and
                        a line per quick fix (default)
                        json: the findings with their ranges and quick fixes, and the counts
                        github: workflow commands that annotate the files in GitHub Actions
                        sarif: SARIF 2.1.0, for GitHub code scanning and other tools
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
  const options: Options = { roots: [], extensions: [], structure: true, fix: false, format: 'text', failOn: 'hint', help: false };
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
    } else if (argument === '--fix') {
      options.fix = true;
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
      code: codeOf(diagnostic),
      message: messageOf(diagnostic),
      fixes,
    });
  }
  return findings.sort(byPosition);
}

function codeOf(diagnostic: Diagnostic): string {
  return diagnostic.code === undefined ? '' : String(diagnostic.code);
}

function messageOf(diagnostic: Diagnostic): string {
  return typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
}

/** The XML files of a script folder, in the order of their names. */
async function xmlFilesOf(folder: string): Promise<string[]> {
  return (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
    .sort(byName)
    .map((entry) => path.join(folder, entry.name));
}

async function checkFolder(scriptFolder: ScriptFolder, context: AnalysisContext, game: GameData | undefined, counters: Counters): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of await xmlFilesOf(scriptFolder.folder)) {
    findings.push(...(await checkFile(file, scriptFolder.schema, context, game, counters)));
  }
  return findings;
}

/** Fix all leaves out a fix whose edits touch an earlier one's; the next round takes it. */
const fixRounds = 10;

/**
 * Applies the preferred fixes of a file as the editor's fix all does, round after round until none is
 * left, and writes the file when it changed; the index learns the new text, so the files checked after
 * it see what it defines now. Returns the fixes applied, at the problems they fixed.
 */
async function fixFile(file: string, context: AnalysisContext, game: GameData | undefined): Promise<Applied[]> {
  const uri = pathToFileURL(file).toString();
  const original = await readFile(file, 'utf8');
  const applied: Applied[] = [];
  let text = original;
  for (let round = 0; round < fixRounds; round++) {
    const analysis = analyzeDocument(TextDocument.create(uri, 'xml', round, text), context);
    const action = fixAll(analysis, game);
    const edits = action?.edit?.changes?.[uri];
    if (!action?.diagnostics || !edits) {
      break;
    }
    // The fixes fix all took, one each, at the first problem each fixes.
    for (const fix of quickFixes(analysis, action.diagnostics, game)) {
      const diagnostic = fix.diagnostics?.[0];
      if (fix.isPreferred && diagnostic) {
        applied.push({ file, range: diagnostic.range, code: codeOf(diagnostic), message: messageOf(diagnostic), title: fix.title });
      }
    }
    const fixed = TextDocument.applyEdits(analysis.document, edits);
    if (fixed === text) {
      break;
    }
    text = fixed;
  }
  if (text !== original) {
    await writeFile(file, text, 'utf8');
    const source = game?.index?.sourceOf(file);
    if (source !== undefined) {
      game?.index?.setText(file, text, source);
    }
  }
  return applied;
}

function locationOf(file: string, range: Range | undefined): string {
  return range ? `${file}:${range.start.line + 1}:${range.start.character + 1}` : file;
}

function codeSuffix(code: string): string {
  return code === '' ? '' : ` [${code}]`;
}

function textLines(findings: readonly Finding[]): string[] {
  const lines: string[] = [];
  for (const finding of findings) {
    lines.push(`${locationOf(finding.file, finding.range)}: ${finding.severity}: ${finding.message}${codeSuffix(finding.code)}`);
    for (const fix of finding.fixes) {
      lines.push(`  fix: ${fix.title}`);
    }
  }
  return lines;
}

/** A line per fix applied, where the problem was before the fix. */
function appliedTextLines(applied: readonly Applied[]): string[] {
  return applied.map((fix) => `${locationOf(fix.file, fix.range)}: fixed: ${fix.title}${codeSuffix(fix.code)}`);
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

/** The segments of a file's path relative to the current folder when it lies inside; undefined for a file elsewhere. */
function insideCurrentFolder(file: string): string[] | undefined {
  const relative = path.relative(process.cwd(), file);
  const inside = relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
  return inside ? relative.split(path.sep) : undefined;
}

/**
 * A workflow command that annotates the file in GitHub Actions. The file is named relative to the
 * current folder, which is the checked-out repository in a workflow; columns only for a range on one
 * line, as GitHub takes them.
 */
function githubCommand(command: string, file: string, range: Range | undefined, code: string, message: string): string {
  const properties = [`file=${escapeProperty((insideCurrentFolder(file) ?? file.split(path.sep)).join('/'))}`];
  if (range) {
    const { start, end } = range;
    properties.push(`line=${start.line + 1}`, `endLine=${end.line + 1}`);
    if (start.line === end.line) {
      properties.push(`col=${start.character + 1}`, `endColumn=${end.character + 1}`);
    }
  }
  if (code !== '') {
    properties.push(`title=${escapeProperty(code)}`);
  }
  return `::${command} ${properties.join(',')}::${escapeData(message)}`;
}

function githubLine(finding: Finding): string {
  const message = [finding.message, ...finding.fixes.map((fix) => `Fix: ${fix.title}`)].join('\n');
  return githubCommand(githubCommands[finding.severity], finding.file, finding.range, finding.code, message);
}

/** A notice per fix applied, where the problem was before the fix. */
function appliedGithubLine(fix: Applied): string {
  return githubCommand('notice', fix.file, fix.range, fix.code, `Fixed: ${fix.title}`);
}

function countOf(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

const counted: Record<Severity, string> = { error: 'error(s)', warning: 'warning(s)', info: 'info', hint: 'hint(s)' };

function fixedFileCount(applied: readonly Applied[]): number {
  return new Set(applied.map((fix) => fix.file)).size;
}

/** The counts; with `--fix`, the fixes applied as well. */
function summaryLine(findings: readonly Finding[], counters: Counters, validated: boolean, applied: readonly Applied[] | undefined): string {
  const notes = severities.filter((severity) => countOf(findings, severity) > 0).map((severity) => `${countOf(findings, severity)} ${counted[severity]}`);
  const details = [...(notes.length > 0 ? [notes.join(', ')] : []), ...(validated ? [] : ['no schema validation: pass --unpacked'])];
  const counts = `${counters.files} file(s) in ${counters.folders} folder(s): ${counters.scripts} script(s), ${counters.patches} patch(es), ${findings.length} finding(s)`;
  const line = details.length === 0 ? counts : `${counts} (${details.join('; ')})`;
  return applied ? `${line}; ${applied.length} fix(es) applied to ${fixedFileCount(applied)} file(s)` : line;
}

/** A place as the JSON report gives it: 1-based line and column besides the LSP range. */
function jsonPlace(range: Range | undefined): { line: number; column: number; range: Range } | object {
  return range ? { line: range.start.line + 1, column: range.start.character + 1, range } : {};
}

function jsonReport(
  findings: readonly Finding[],
  counters: Counters,
  validated: boolean,
  problems: readonly string[],
  applied: readonly Applied[] | undefined
): string {
  const report = {
    findings: findings.map((finding) => ({
      file: finding.file,
      ...jsonPlace(finding.range),
      severity: finding.severity,
      code: finding.code,
      message: finding.message,
      fixes: finding.fixes,
    })),
    ...(applied ? { fixed: applied.map((fix) => ({ file: fix.file, ...jsonPlace(fix.range), code: fix.code, message: fix.message, fix: fix.title })) } : {}),
    summary: {
      ...counters,
      findings: findings.length,
      errors: countOf(findings, 'error'),
      warnings: countOf(findings, 'warning'),
      info: countOf(findings, 'info'),
      hints: countOf(findings, 'hint'),
      schemaValidation: validated,
      ...(applied ? { fixes: applied.length, fixedFiles: fixedFileCount(applied) } : {}),
    },
    problems,
  };
  return JSON.stringify(report, null, 2);
}

/** What the checker's own findings about whole files report. */
const checkerDescriptions: Readonly<Record<string, string>> = {
  'script-in-wrong-folder': 'A Mission Director script in an aiscripts folder, or an AI script in an md folder.',
  'script-without-name': 'A script whose root element has no name.',
  'not-a-script': 'An XML file in a script folder that is no script and no patch.',
};

const descriptions: ReadonlyMap<string, string> = new Map([...Object.entries(diagnosticDescriptions), ...Object.entries(checkerDescriptions)]);

const sarifLevels: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'note', hint: 'note' };

/** The checker's version from its package manifest, when it runs from the installed package. */
function checkerVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return manifest.name === 'x4-script-check' && typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** A file as a SARIF artifact: relative to the current folder, the checked-out repository in a workflow, when inside it. */
function sarifArtifact(file: string): { uri: string; uriBaseId?: string } {
  const inside = insideCurrentFolder(file);
  return inside ? { uri: inside.map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' } : { uri: pathToFileURL(file).toString() };
}

/** A SARIF region: lines and columns count from 1, the end column is the one after the range. */
function sarifRegion(range: Range): { startLine: number; startColumn: number; endLine: number; endColumn: number } {
  return { startLine: range.start.line + 1, startColumn: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1 };
}

/**
 * The findings as a SARIF 2.1.0 log of one run, as GitHub code scanning takes it: a rule per code found,
 * with its description; a finding about a whole file on its first line, since code scanning shows a
 * result only at a line; the quick fixes as SARIF fixes; the problems met reading the game files as
 * notifications.
 */
function sarifReport(findings: readonly Finding[], problems: readonly string[]): string {
  const ruleIds = [...new Set(findings.map((finding) => finding.code).filter((code) => code !== ''))].sort();
  const rules = ruleIds.map((id) => {
    const text = descriptions.get(id) ?? id;
    return { id, shortDescription: { text }, fullDescription: { text }, help: { text } };
  });
  const results = findings.map((finding) => {
    const artifactLocation = sarifArtifact(finding.file);
    const rule = finding.code === '' ? {} : { ruleId: finding.code, ruleIndex: ruleIds.indexOf(finding.code) };
    const result = {
      ...rule,
      level: sarifLevels[finding.severity],
      message: { text: finding.message },
      locations: [{ physicalLocation: { artifactLocation, region: finding.range ? sarifRegion(finding.range) : { startLine: 1 } } }],
    };
    if (finding.fixes.length === 0) {
      return result;
    }
    const fixes = finding.fixes.map((fix) => ({
      description: { text: fix.title },
      artifactChanges: [
        {
          artifactLocation,
          replacements: fix.edits.map((edit) => ({
            deletedRegion: sarifRegion(edit.range),
            ...(edit.newText === '' ? {} : { insertedContent: { text: edit.newText } }),
          })),
        },
      ],
    }));
    return { ...result, fixes };
  });
  const version = checkerVersion();
  const root = pathToFileURL(process.cwd()).toString();
  const log = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'x4-script-check',
            ...(version ? { version, semanticVersion: version } : {}),
            informationUri: 'https://github.com/chemodun/X4CodeSense/tree/main/packages/cli',
            rules,
          },
        },
        originalUriBaseIds: { '%SRCROOT%': { uri: root.endsWith('/') ? root : `${root}/` } },
        columnKind: 'utf16CodeUnits',
        invocations: [{ executionSuccessful: true, toolExecutionNotifications: problems.map((text) => ({ level: 'warning', message: { text } })) }],
        results,
      },
    ],
  };
  return JSON.stringify(log, null, 2);
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
  const scriptFolders: ScriptFolder[] = [];
  for (const root of options.roots) {
    const resolved = path.resolve(root);
    if (!(await isDirectory(resolved))) {
      console.error(`Not a folder: ${resolved}`);
      return 2;
    }
    scriptFolders.push(...(await collectScriptFolders(resolved)));
  }
  // Every file fixed before any is checked: a fix in one may change what another refers to.
  let applied: Applied[] | undefined;
  if (options.fix) {
    applied = [];
    for (const scriptFolder of scriptFolders) {
      for (const file of await xmlFilesOf(scriptFolder.folder)) {
        applied.push(...(await fixFile(file, context, game)));
      }
    }
  }
  const findings: Finding[] = [];
  const counters: Counters = { files: 0, folders: 0, scripts: 0, patches: 0 };
  for (const scriptFolder of scriptFolders) {
    counters.folders++;
    findings.push(...(await checkFolder(scriptFolder, context, game, counters)));
  }
  const validated = context.schemas !== undefined;
  const problems = game?.problems ?? [];
  if (options.format === 'json') {
    console.log(jsonReport(findings, counters, validated, problems, applied));
  } else if (options.format === 'sarif') {
    console.log(sarifReport(findings, problems));
  } else {
    const lines =
      options.format === 'github'
        ? [...(applied ?? []).map(appliedGithubLine), ...findings.map(githubLine)]
        : [...appliedTextLines(applied ?? []), ...textLines(findings)];
    for (const line of lines) {
      console.log(line);
    }
    console.log(summaryLine(findings, counters, validated, applied));
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
