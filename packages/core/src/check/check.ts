/**
 * What is reported of script files outside an editor, by the command line checker and the MCP server:
 * the findings of a file with their quick fixes, and the script folders found under a folder.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic, Range, TextEdit } from 'vscode-languageserver-types';
import { analyzeDocument, type AnalysisContext } from '../analysis/analyzeDocument';
import { bundledExtensionsOf } from '../extensions/extensions';
import { quickFixes } from '../features/codeActions';
import { diskFiles, fileNames, subfolderNames, type FileSource } from '../files/fileSource';
import type { GameData } from '../gameData';
import { schemaFolderName, scriptSchemas } from '../scripts/scriptMetadata';
import type { ScriptSchema } from '../types';

/** The severities of findings, the most severe first. */
export const severities = ['error', 'warning', 'info', 'hint'] as const;
export type Severity = (typeof severities)[number];

export interface FindingFix {
  title: string;
  /** The fix an editor would apply on its own: the only one, or clearly the best. */
  preferred: boolean;
  edits: TextEdit[];
}

export interface Finding {
  file: string;
  /** Absent for findings about the whole file. */
  range?: Range;
  severity: Severity;
  code: string;
  message: string;
  fixes: FindingFix[];
}

/**
 * The folder a file was found in: a script folder (`md`, `aiscripts`), an extension's `libraries`, which
 * holds patches and merge files of the game's library files, or none known.
 */
export type FileFolder = ScriptSchema | 'libraries' | undefined;

export interface CheckedFolder {
  folder: string;
  kind: Exclude<FileFolder, undefined>;
}

export interface FileFindings {
  findings: Finding[];
  /** What the file is: a script, a patch, or neither. */
  kind: 'script' | 'patch' | 'other';
}

/** Orders names the same way on every system, so the output does too. */
export function inOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function subfolders(files: FileSource, folder: string): string[] {
  return subfolderNames(files, folder)
    .sort(inOrder)
    .map((name) => path.join(folder, name));
}

/**
 * Finds script folders under a root: `<root>/md`, `<root>/aiscripts` and the same one level deeper,
 * so a single extension and a folder full of extensions both work; also the patches of other
 * extensions an extension keeps in `extensions/<folder>/md` and `.../aiscripts`, and the `libraries`
 * of each extension. The game folder stands for the game and its DLCs: an installed game's `extensions`
 * holds the player's mods as well, and the game's own `libraries` is what the extensions' patch.
 */
export function collectScriptFolders(root: string, files: FileSource, game: GameData | undefined): CheckedFolder[] {
  const result: CheckedFolder[] = [];
  const isGame = game !== undefined && path.relative(root, path.resolve(game.folder)) === '';
  const candidates: string[] = isGame ? [root, ...[...bundledExtensionsOf(game.folder, files)].sort(inOrder)] : [root, ...subfolders(files, root)];
  // Not those in `extensions/<folder>`: nothing tells that the game reads them.
  const withLibraries = new Set(candidates.filter((candidate) => !isGame || candidate !== root));
  for (const candidate of [...candidates]) {
    if (!isGame || candidate !== root) {
      candidates.push(...subfolders(files, path.join(candidate, 'extensions')));
    }
  }
  for (const candidate of candidates) {
    for (const schema of scriptSchemas) {
      const folder = path.join(candidate, schemaFolderName[schema]);
      if (files.isDirectory(folder)) {
        result.push({ folder, kind: schema });
      }
    }
    const libraries = path.join(candidate, 'libraries');
    if (withLibraries.has(candidate) && files.isDirectory(libraries)) {
      result.push({ folder: libraries, kind: 'libraries' });
    }
  }
  return result;
}

/** The XML files of a folder, in the order of their names. */
export function xmlFilesOf(files: FileSource, folder: string): string[] {
  return fileNames(files, folder)
    .filter((name) => name.toLowerCase().endsWith('.xml'))
    .sort(inOrder)
    .map((name) => path.join(folder, name));
}

/** The folder a file lies in, as far as it tells what the file should be. */
export function folderOfFile(file: string): FileFolder {
  const name = path.basename(path.dirname(file)).toLowerCase();
  return scriptSchemas.find((schema) => schemaFolderName[schema] === name) ?? (name === 'libraries' ? 'libraries' : undefined);
}

/** Findings about the whole file first, then by position. */
function byPosition(a: Finding, b: Finding): number {
  const first = a.range?.start ?? { line: -1, character: -1 };
  const second = b.range?.start ?? { line: -1, character: -1 };
  return first.line - second.line || first.character - second.character;
}

export function codeOf(diagnostic: Diagnostic): string {
  return diagnostic.code === undefined ? '' : String(diagnostic.code);
}

export function messageOf(diagnostic: Diagnostic): string {
  return typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
}

/** What the findings about whole files report, by code. */
export const fileFindingDescriptions: Readonly<Record<string, string>> = {
  'script-in-wrong-folder': 'A Mission Director script in an aiscripts folder, or an AI script in an md folder.',
  'script-without-name': 'A script whose root element has no name.',
  'not-a-script': 'An XML file in a script folder that is no script and no patch.',
};

/**
 * The findings of a file with their quick fixes, sorted by position; besides the analysis's, those about
 * the whole file its folder tells: a script of the other kind, a script without a name, or in a script
 * folder a file that is neither a script nor a patch. The text is read from the game's files or the disk
 * unless given.
 */
export function checkFile(file: string, folder: FileFolder, context: AnalysisContext, game: GameData | undefined, text?: string): FileFindings {
  const document = TextDocument.create(pathToFileURL(file).toString(), 'xml', 0, text ?? (game?.files ?? diskFiles).readText(file));
  const analysis = analyzeDocument(document, context);
  const detection = analysis.detection;
  const findings: Finding[] = [];
  const aboutFile = (code: string, message: string): void => {
    findings.push({ file, severity: 'error', code, message, fixes: [] });
  };
  let kind: FileFindings['kind'] = 'other';
  if (detection.script) {
    kind = 'script';
    if (folder !== undefined && detection.script.schema !== folder) {
      aboutFile(
        'script-in-wrong-folder',
        `is a ${detection.script.schema} script but lies in the ${folder === 'libraries' ? folder : schemaFolderName[folder]} folder`
      );
    } else if (detection.script.name === '') {
      aboutFile('script-without-name', 'root element has no name attribute');
    }
  } else if (detection.isDiff) {
    kind = 'patch';
  } else if (folder !== undefined && folder !== 'libraries') {
    // In a script folder only: in `libraries` such a file is a merge file, which its analysis checks with the game.
    const root = detection.rootElement ? `root element <${detection.rootElement}>` : 'no root element';
    aboutFile('not-a-script', `not recognised as a script or a patch (${root})`);
  }
  // A fix that creates what is missing in another file is the editor's: a finding lists the edits of its own file.
  const actions = (analysis.diagnostics.length === 0 ? [] : quickFixes(analysis, analysis.diagnostics, game)).filter((action) =>
    Object.keys(action.edit?.changes ?? {}).every((uri) => uri === document.uri)
  );
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
  return { findings: findings.sort(byPosition), kind };
}
