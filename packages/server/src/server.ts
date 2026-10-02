#!/usr/bin/env node
import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  ErrorCodes,
  FileChangeType,
  ProposedFeatures,
  ResponseError,
  SemanticTokensBuilder,
  TextDocuments,
  TextDocumentSyncKind,
  type CodeAction,
  type CompletionItem,
  type CompletionList,
  type DocumentSymbol,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type Range,
  type SemanticTokens,
  type SemanticTokensDelta,
  type SignatureHelp,
  type WorkDoneProgressServerReporter,
  type WorkspaceEdit,
  type WorkspaceSymbol,
} from 'vscode-languageserver/node';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  analyzeComparisonSide,
  analyzeDocument,
  callSignatureHelp,
  formatSignatureHelp,
  comparePatch,
  comparisonSideOf,
  completionAt,
  definitionAt,
  DocumentInfoRequestMethod,
  documentSymbols,
  EditorTabsNotificationMethod,
  fixAll,
  gameFileOf,
  GameFileRequestMethod,
  gameFileUri,
  hoverAt,
  isInside,
  languageOfTextFile,
  loadGameData,
  loadTexts,
  newProblems,
  openInstalledGame,
  parseXml,
  PatchComparisonRequestMethod,
  PatchWriteRequestMethod,
  positionTokens,
  prepareRenameAt,
  quickFixes,
  readTextCalls,
  readTextHover,
  referencesAt,
  renameAt,
  ScriptIndex,
  scriptFiles,
  scriptFolders,
  semanticTokens,
  semanticTokensLegend,
  sourcesOf,
  StatusNotificationMethod,
  workspaceSymbols,
  writePatch,
  type AnalysisContext,
  type DocumentAnalysis,
  type DocumentInfoParams,
  type DocumentInfoResult,
  type EditorTabsParams,
  type GameData,
  type GameFileParams,
  type GameFileResult,
  type GameSource,
  type PatchComparisonParams,
  type PatchComparisonResult,
  type PatchWriteParams,
  type PatchWriteResult,
  type ReadTextCall,
  type ServerStatus,
  type TextDisplayOptions,
  type TextLoadOptions,
  type XmlStructure,
} from 'x4-script-core';

/** Settings under the `x4CodeSense` section, mirrored from the client's package.json. */
interface X4CodeSenseSettings {
  unpackedFileLocation: string;
  /** The installed game, read from its catalogs when `unpackedFileLocation` is empty. */
  gameFolder: string;
  extensionsFolder: string;
  languageNumber: string;
  limitLanguageOutput: boolean;
  validateXmlStructure: boolean;
  /** Guess what actions write into variables from their names and documentation (`create_ship` a ship). */
  guessVariableTypes: boolean;
  /** Problems of the open documents only, or also of every other script in the workspace folders. */
  diagnosticMode: 'openFilesOnly' | 'workspace';
  debug: boolean;
}

const defaultSettings: X4CodeSenseSettings = {
  unpackedFileLocation: '',
  gameFolder: '',
  extensionsFolder: '',
  languageNumber: '44',
  limitLanguageOutput: false,
  validateXmlStructure: true,
  guessVariableTypes: true,
  diagnosticMode: 'openFilesOnly',
  debug: false,
};

/** Characters after which the client asks for completion without being told to. */
// `/`, `@` and `'` for the paths of patch documents.
const completionTriggerCharacters = ['<', '.', '"', ' ', '$', '{', ',', '/', '@', "'"];

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: X4CodeSenseSettings = defaultSettings;
let hasConfigurationCapability = false;
let snippetSupport = false;
let workspaceFolderSupport = false;
let semanticTokensRefreshSupport = false;
let game: GameData | undefined;
/** What the game data was loaded as: its key (see `gameKey`), where it comes from, and an installed game's version. */
let loadedGame: { key: string; source: GameSource; version?: string } | undefined;
/** Workspace folders on disk: extensions themselves or holders of extensions, and the base of a relative `extensionsFolder`. */
let workspaceFolders: string[] = [];
/** What the loaded texts were read with, so they are read again only when that changes. */
let textSources: string | undefined;
/** What the script index is built from, so it is built again only when that changes. */
let indexSources: string | undefined;
/** Counts index builds: a build that is no longer the latest stops. */
let indexGeneration = 0;
/** The key of the game being read, while it is. */
let loadingGame: string | undefined;
/** True while the latest index build runs. */
let indexing = false;
/** What the latest complete index was built from: script files, and by id in load order the game's DLCs and the other extensions. */
let indexed = { scripts: 0, dlcs: [] as string[], extensions: [] as string[] };
/** The status last sent, so that only a change is sent. */
let sentStatus: string | undefined;

/** The latest analysis of each open document. */
const analysisByUri = new Map<string, DocumentAnalysis>();
/** The semantic tokens builder of each open document: it keeps the last result, which a delta request refers to. */
const tokenBuilders = new Map<string, SemanticTokensBuilder>();
/** The `ReadText` calls of each open Lua document, found at the first hover after a change. */
const readTextCallsByUri = new Map<string, { version: number; calls: ReadTextCall[] }>();
/** The sides of patch comparisons whose analysis is not of their current text or context: a request analyses them at once. */
const staleSides = new Set<string>();
/** The timer of each side of a patch comparison that publishes its problems, analysing it first when it is still stale. */
const sideTimers = new Map<string, NodeJS.Timeout>();
/** How long a side of a patch comparison waits after its last change: a side is a whole script, which typing in the patch changes too. */
const sideDelay = 250;
/** Why a side of a patch comparison is not renamed in: its edits would land in the comparison. */
const sideRenameRefusal = 'Rename in the patch or in the script, not in a side of their comparison';
/** Why a game document is not renamed in, nor its patch written. */
const gameFileRefusal = "The game's files are read only";

/**
 * The checked scripts that are no open documents, by file key: the uri of their problems, how many, and as
 * sent (nothing is sent for a first check without any). They are those of the client's editor tabs that
 * the editor has not loaded yet, and with `diagnosticMode` `workspace` every script of the workspace.
 */
const workspaceProblems = new Map<string, { uri: string; count: number; sent: string }>();
/** The files of the client's editor tabs, by file key. */
let tabFiles = new Map<string, string>();
/** The uri the client used for a file while it was open, by file key: its problems go there once it is closed. */
const clientUris = new Map<string, string>();
/** Counts checks of the workspace's scripts: a check that is no longer the latest stops. */
let workspaceGeneration = 0;
/** The timer of the check after a change, and what it is to check: every closed script, or these files by key. */
let workspaceTimer: NodeJS.Timeout | undefined;
let workspacePending: { all: boolean; files: Map<string, string> } = { all: false, files: new Map() };
/** How long the check of the closed scripts waits after the last change of what scripts see of each other. */
const workspaceDelay = 1000;

/** Lua documents only get the hover of `ReadText`: they are never analysed as XML. */
function isLua(document: TextDocument): boolean {
  return document.languageId === 'lua';
}

function log(message: string): void {
  connection.console.log(`[X4CodeSense] ${message}`);
}

function warn(message: string): void {
  connection.console.warn(`[X4CodeSense] ${message}`);
}

function debug(message: string): void {
  if (settings.debug) {
    log(message);
  }
}

/** Sends the client what the server is doing and what it has read, when that changed since it was last sent. */
function sendStatus(): void {
  const status: ServerStatus = {
    state: loadingGame !== undefined ? 'loading' : indexing ? 'indexing' : 'ready',
    schemas: game ? [...Object.keys(game.schemas.schemas), ...(game.schemas.diff ? ['diff'] : [])].sort() : [],
    properties: game?.properties !== undefined,
    texts: game?.texts.textCount ?? 0,
    textFiles: game?.texts.fileCount ?? 0,
    scripts: game?.index ? indexed.scripts : 0,
    dlcs: game?.index ? indexed.dlcs : [],
    extensions: game?.index ? indexed.extensions : [],
    problems: game?.problems.length ?? 0,
  };
  if (game && loadedGame) {
    status.gameFolder = game.folder;
    status.gameSource = loadedGame.source;
    if (loadedGame.version !== undefined) {
      status.gameVersion = loadedGame.version;
    }
  }
  const sent = JSON.stringify(status);
  if (sent !== sentStatus) {
    sentStatus = sent;
    void connection.sendNotification(StatusNotificationMethod, status);
  }
}

/** Lets the messages sent so far go out before synchronous work holds the event loop. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The file system path of a `file:` uri; its plain path when the platform rejects it (no drive letter on Windows). */
function filePathOf(uri: string): string | undefined {
  if (!uri.startsWith('file:')) {
    return undefined;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return undefined;
    }
  }
}

/** The file of the game a game document stands for; undefined for other uris. */
function gameFileOfUri(uri: string): string | undefined {
  return game ? gameFileOf(game.folder, uri) : undefined;
}

/**
 * The uri the client knows a file by: a file of an installed game's catalogs has no file on disk, so the
 * client reads it as a game document.
 */
function clientUriOf(uri: string): string {
  const file = game?.files.inCatalogs ? filePathOf(uri) : undefined;
  return (game && file && game.files.inCatalogs?.(file) && gameFileUri(game.folder, file)) || uri;
}

/** The document an open one is analysed as: a game document as its file, as any of the game's files is. */
function analysedDocument(document: TextDocument): TextDocument {
  const file = gameFileOfUri(document.uri);
  return file === undefined ? document : TextDocument.create(pathToFileURL(file).toString(), document.languageId, document.version, document.getText());
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = params.capabilities.workspace?.configuration === true;
  snippetSupport = params.capabilities.textDocument?.completion?.completionItem?.snippetSupport === true;
  workspaceFolderSupport = params.capabilities.workspace?.workspaceFolders === true;
  semanticTokensRefreshSupport = params.capabilities.workspace?.semanticTokens?.refreshSupport === true;
  const folders = params.workspaceFolders?.map((folder) => folder.uri) ?? (params.rootUri ? [params.rootUri] : []);
  workspaceFolders = folders.map(filePathOf).filter((folder): folder is string => folder !== undefined);
  return {
    capabilities: {
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: completionTriggerCharacters },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ['<', '"', ' ', '[', ','] },
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: { label: 'X4CodeSense' },
      workspaceSymbolProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll] },
      semanticTokensProvider: { legend: semanticTokensLegend, full: { delta: true }, range: true },
    },
    serverInfo: {
      name: 'X4CodeSense language server',
    },
  };
});

/** The game the settings ask for: the extracted files when they are set, else the installed game. */
function wantedGame(): { folder: string; source: GameSource } | undefined {
  if (settings.unpackedFileLocation.trim() !== '') {
    return { folder: settings.unpackedFileLocation, source: 'extracted' };
  }
  return settings.gameFolder.trim() === '' ? undefined : { folder: settings.gameFolder, source: 'installed' };
}

/** What tells one wanted game from another. */
function gameKey(wanted: { folder: string; source: GameSource } | undefined): string | undefined {
  return wanted && `${wanted.source} ${wanted.folder}`;
}

/**
 * Loads the schemas and script properties of the game files, once per folder: the extracted ones, or an
 * installed game's read from its catalogs. The client shows progress meanwhile; a game the settings no
 * longer ask for when its turn comes is not read.
 */
async function refreshGameData(): Promise<void> {
  const wanted = wantedGame();
  const key = gameKey(wanted);
  if (key === loadedGame?.key || (key !== undefined && key === loadingGame)) {
    return;
  }
  indexSources = undefined;
  if (wanted === undefined || key === undefined) {
    game = undefined;
    loadedGame = undefined;
    warn(
      'neither x4CodeSense.unpackedFileLocation nor x4CodeSense.gameFolder is set: scripts are not validated against the game schemas and have no property completion'
    );
    return;
  }
  loadingGame = key;
  sendStatus();
  const progress = await connection.window.createWorkDoneProgress();
  progress.begin('X4CodeSense', undefined, 'reading the game files');
  await flush();
  try {
    if (gameKey(wantedGame()) !== key) {
      return;
    }
    const started = performance.now();
    const options = textOptions();
    const installed = wanted.source === 'installed' ? openInstalledGame(wanted.folder) : undefined;
    game = loadGameData(wanted.folder, installed ? { ...options, files: installed } : options);
    loadedGame = { key, source: wanted.source, ...(installed?.version !== undefined ? { version: installed.version } : {}) };
    textSources = JSON.stringify(options, (_key, value: unknown) => (value instanceof Set ? [...(value as Set<string>)] : value));
    overlayOpenTextFiles();
    const schemas = Object.keys(game.schemas.schemas);
    const properties = game.properties;
    const from = installed ? `the catalogs of the installed game${installed.version ? ` ${installed.version}` : ''} in ${wanted.folder}` : wanted.folder;
    log(
      `loaded ${schemas.length > 0 ? `schemas ${schemas.join(', ')}` : 'no schemas'}${properties ? `, ${properties.datatypes.size} datatypes and ${properties.keywords.length} keywords` : ', no script properties'}, ${game.texts.textCount} texts from ${game.texts.fileCount} files, from ${from} in ${(performance.now() - started).toFixed(0)} ms`
    );
    for (const problem of game.problems.slice(0, 50)) {
      warn(problem);
    }
    if (game.problems.length > 50) {
      warn(`${game.problems.length - 50} more problems not shown`);
    }
  } finally {
    if (loadingGame === key) {
      loadingGame = undefined;
    }
    progress.done();
  }
}

/**
 * The folders that hold the extensions scripts and texts may refer to, besides the game's own. The
 * `extensionsFolder` setting is resolved against each workspace folder: empty or `.` is the workspace
 * folder itself (a workspace of several mods, or of one), `..` the folder above it (one workspace per
 * mod, the mods side by side); an absolute path is taken as is. The workspace folders always count.
 * Each folder may be an extension or hold extensions; see `findExtensions`.
 */
function extensionFolders(): string[] {
  const setting = settings.extensionsFolder.trim();
  const folders: string[] = [];
  if (path.isAbsolute(setting)) {
    folders.push(setting);
  } else if (setting !== '' && setting !== '.') {
    folders.push(...workspaceFolders.map((folder) => path.resolve(folder, setting)));
  }
  folders.push(...workspaceFolders);
  return folders;
}

/** Which text files to read: the game's and those of the extension folders, in the configured languages. */
function textOptions(): TextLoadOptions {
  const options: TextLoadOptions = { extensionFolders: extensionFolders() };
  if (settings.limitLanguageOutput) {
    options.languages = new Set([settings.languageNumber || '44', '44']);
  }
  return options;
}

/** Reads the texts again when the folders or languages they come from changed. */
function refreshTexts(): void {
  if (!game) {
    return;
  }
  const options = textOptions();
  const sources = JSON.stringify(options, (_key, value: unknown) => (value instanceof Set ? [...(value as Set<string>)] : value));
  if (sources === textSources) {
    return;
  }
  const started = performance.now();
  game.texts = loadTexts(game.folder, { ...options, files: game.files });
  textSources = sources;
  overlayOpenTextFiles();
  log(`loaded ${game.texts.textCount} texts from ${game.texts.fileCount} files in ${(performance.now() - started).toFixed(0)} ms`);
  debug(`text folders, in load order: ${game.texts.folders.join(', ')}`);
  for (const problem of game.texts.problems.slice(0, 50)) {
    warn(problem);
  }
}

/**
 * Builds the script index again when the folders it comes from changed. It is built in slices, so
 * requests are answered meanwhile; until it is complete, what needs it is left out, then every open
 * document is analysed again, and the closed scripts of the workspace when their problems are asked
 * for. A newer build stops an older one.
 */
async function refreshIndex(): Promise<void> {
  if (!game) {
    return;
  }
  const folders = scriptFolders(game.folder, extensionFolders(), game.files);
  const sources = JSON.stringify(folders);
  if (sources === indexSources) {
    return;
  }
  indexSources = sources;
  const generation = ++indexGeneration;
  const target = game;
  const current = (): boolean => generation === indexGeneration && target === game;
  indexing = true;
  sendStatus();
  // The build starts at once; progress shows once the client has made room for it, if it still runs then.
  let finished = false;
  let progress: WorkDoneProgressServerReporter | undefined;
  void connection.window.createWorkDoneProgress().then((reporter) => {
    if (finished) {
      reporter.done();
    } else {
      progress = reporter;
      reporter.begin('X4CodeSense', 0, 'indexing scripts');
    }
  });
  try {
    const started = performance.now();
    const index = new ScriptIndex(target.schemas, target.files);
    for (const folder of folders) {
      index.addFolder(folder);
    }
    const files = scriptFiles(folders, target.files);
    let slice = performance.now();
    let reported = slice;
    for (const [done, source] of files.entries()) {
      if (!current()) {
        return;
      }
      try {
        index.setText(source.file, target.files.readText(source.file), source.source);
      } catch {
        // A file that cannot be read is left out.
      }
      if (performance.now() - slice > 25) {
        if (slice - reported > 250) {
          progress?.report(Math.floor((100 * done) / files.length), `indexing scripts: ${done} of ${files.length}`);
          reported = slice;
        }
        await new Promise((resolve) => setImmediate(resolve));
        slice = performance.now();
      }
    }
    if (!current()) {
      return;
    }
    for (const document of documents.all()) {
      indexOpenDocument(document, index);
    }
    target.index = index;
    const { dlcs, extensions } = sourcesOf(folders);
    indexed = { scripts: files.length, dlcs, extensions };
    log(
      `indexed ${files.length} script files of the game, ${dlcs.length} DLC(s) and ${extensions.length} extension(s) in ${(performance.now() - started).toFixed(0)} ms`
    );
    debug(`DLCs and extensions, in load order: ${[...dlcs, ...extensions].join(', ')}`);
    reanalyzeAll();
  } finally {
    finished = true;
    progress?.done();
    if (generation === indexGeneration) {
      indexing = false;
      sendStatus();
    }
  }
  // Only a build that completed gets here.
  void checkWorkspace(true);
}

/**
 * Indexes an open script as it is in the editor, when it lies in an indexed script folder. Returns true
 * when what other scripts see of it changed.
 */
function indexOpenDocument(document: TextDocument, index: ScriptIndex, structure?: XmlStructure): boolean {
  const file = filePathOf(document.uri);
  const source = file ? index.sourceOf(file) : undefined;
  if (!file || !source) {
    return false;
  }
  const text = document.getText();
  return index.setStructure(file, text, structure ?? parseXml(text), source, true);
}

/** Reads a file of the index or the texts again from disk, or forgets it; returns true when that changed something. */
function rereadFromDisk(file: string): boolean {
  if (!game) {
    return false;
  }
  let changed = false;
  const exists = existsSync(file);
  if (isTextFile(file)) {
    const inReadFolder = game.texts.folders.some((folder) => path.resolve(folder).toLowerCase() === path.resolve(path.dirname(file)).toLowerCase());
    const language = languageOfTextFile(path.basename(file));
    const wanted = !textOptions().languages || language === '*' || (language !== undefined && textOptions().languages?.has(language));
    if (!exists) {
      changed = game.texts.hasFile(file);
      game.texts.removeFile(file);
    } else if (wanted && (inReadFolder || game.texts.hasFile(file))) {
      game.texts.setFile(file, readFileSync(file, 'utf8'));
      changed = true;
    }
  }
  const source = game.index?.sourceOf(file);
  if (game.index && source) {
    changed = (exists ? game.index.setText(file, readFileSync(file, 'utf8'), source) : game.index.removeFile(file)) || changed;
  }
  return changed;
}

/** How hover, definition and completion show texts. */
function textDisplay(): TextDisplayOptions {
  return { language: settings.languageNumber || '44', limitLanguage: settings.limitLanguageOutput };
}

/** True for a text file: `0001-l044.xml` or another language in a `t` folder. */
function isTextFile(file: string): boolean {
  return languageOfTextFile(path.basename(file)) !== undefined && path.basename(path.dirname(file)).toLowerCase() === 't';
}

/** The path of a document that is a text file, or undefined. */
function textFileOf(uri: string): string | undefined {
  const file = filePathOf(uri);
  return file && isTextFile(file) ? file : undefined;
}

/** Open text files count as they are in the editor, not as they are on disk. */
function overlayOpenTextFiles(): void {
  for (const document of documents.all()) {
    const file = textFileOf(document.uri);
    if (file && game) {
      game.texts.setFile(file, document.getText());
    }
  }
}

async function refreshSettings(): Promise<void> {
  if (!hasConfigurationCapability) {
    return;
  }
  const received = (await connection.workspace.getConfiguration('x4CodeSense')) as Partial<X4CodeSenseSettings> | null;
  settings = { ...defaultSettings, ...(received ?? {}) };
  log(
    `settings: unpackedFileLocation='${settings.unpackedFileLocation}' gameFolder='${settings.gameFolder}' extensionsFolder='${settings.extensionsFolder}' languageNumber=${settings.languageNumber} limitLanguageOutput=${settings.limitLanguageOutput} validateXmlStructure=${settings.validateXmlStructure} guessVariableTypes=${settings.guessVariableTypes} diagnosticMode=${settings.diagnosticMode} debug=${settings.debug}`
  );
  await refreshGameData();
  refreshTexts();
  void refreshIndex();
  sendStatus();
}

connection.onInitialized(async () => {
  // Followed from the start: a folder added while the game's files are read counts once they are.
  if (workspaceFolderSupport) {
    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      const removed = new Set(event.removed.map((folder) => filePathOf(folder.uri)));
      const added = event.added.map((folder) => filePathOf(folder.uri)).filter((folder): folder is string => folder !== undefined);
      workspaceFolders = [...workspaceFolders.filter((folder) => !removed.has(folder)), ...added];
      refreshTexts();
      reanalyzeAll();
      void refreshIndex();
      sendStatus();
      void checkWorkspace(true);
    });
  }
  if (hasConfigurationCapability) {
    await connection.client.register(DidChangeConfigurationNotification.type, { section: 'x4CodeSense' });
    await refreshSettings();
  } else {
    await refreshGameData();
    void refreshIndex();
    sendStatus();
  }
  log('server initialized');
});

connection.onDidChangeWatchedFiles((params) => {
  let changed = false;
  for (const change of params.changes) {
    const file = filePathOf(change.uri);
    // An open document counts as it is in the editor.
    if (!file || documents.get(change.uri)) {
      continue;
    }
    changed = rereadFromDisk(file) || changed;
    debug(`${change.uri}: ${change.type === FileChangeType.Deleted ? 'deleted' : 'changed'} on disk`);
    reanalyzePatchesOf(file);
    scheduleWorkspaceCheck([file, ...patchFilesOf(file)]);
  }
  if (changed) {
    reanalyzeAll();
    scheduleWorkspaceCheck();
    sendStatus();
  }
});

// The files of the editor tabs: those the editor has not loaded yet get their problems from the disk.
connection.onNotification(EditorTabsNotificationMethod, (params: EditorTabsParams) => {
  const files = new Map<string, string>();
  for (const uri of params.uris) {
    const file = filePathOf(uri);
    if (file !== undefined) {
      files.set(fileKey(file), file);
      clientUris.set(fileKey(file), uri);
    }
  }
  const added = new Map([...files].filter(([key]) => !tabFiles.has(key)));
  const removed = [...tabFiles].filter(([key]) => !files.has(key));
  tabFiles = files;
  for (const [key, file] of removed) {
    if (!isChecked(file)) {
      clearWorkspaceProblems(key);
    }
  }
  debug(`editor tabs: ${files.size} XML file(s), ${added.size} new, ${removed.length} closed`);
  // While the game files are read or the index is built, the build checks them when it is done.
  if (!indexing && loadingGame === undefined) {
    checkWorkspaceFiles(added);
  }
});

connection.onDidChangeConfiguration(async () => {
  await refreshSettings();
  reanalyzeAll();
  void checkWorkspace(true);
});

function reanalyzeAll(except?: string): void {
  for (const document of documents.all()) {
    if (document.uri !== except) {
      analyze(document);
    }
  }
  refreshSemanticTokens();
}

/** Asks the client for the semantic tokens of the open documents again: their analyses changed, not only their text. */
function refreshSemanticTokens(): void {
  if (semanticTokensRefreshSupport) {
    connection.languages.semanticTokens.refresh().catch((error: unknown) => debug(`semantic tokens refresh: ${String(error)}`));
  }
}

function analysisContext(): AnalysisContext {
  const context: AnalysisContext = { validateStructure: settings.validateXmlStructure, guessVariableTypes: settings.guessVariableTypes };
  if (game) {
    context.schemas = game.schemas;
    context.texts = game.texts;
    if (game.properties) {
      context.properties = game.properties;
    }
    if (game.index) {
      context.index = game.index;
    }
  }
  return context;
}

/** Analyses one document and publishes its diagnostics; when other scripts see it differently now, they are analysed again. */
function analyze(document: TextDocument): void {
  if (isLua(document)) {
    return;
  }
  if (comparisonSideOf(document.uri)) {
    scheduleSide(document.uri);
    return;
  }
  const started = performance.now();
  const analysis = analyzeDocument(analysedDocument(document), analysisContext());
  analysisByUri.set(document.uri, analysis);
  if (game?.index && analysis.structure && indexOpenDocument(document, game.index, analysis.structure)) {
    debug(`${document.uri}: names seen by other scripts changed`);
    reanalyzeAll(document.uri);
    scheduleWorkspaceCheck();
  }
  const detection = analysis.detection;
  const description = detection.script
    ? `${detection.script.schema} '${detection.script.name}'`
    : detection.isDiff
      ? 'patch'
      : `not a script (root '${detection.rootElement ?? ''}')`;
  debug(`${document.uri}: ${description}, ${analysis.diagnostics.length} diagnostic(s), ${(performance.now() - started).toFixed(1)} ms`);
  void connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: analysis.diagnostics });
  const file = filePathOf(document.uri);
  if (file) {
    reanalyzePatchesOf(file, document.uri);
    scheduleWorkspaceCheck(patchFilesOf(file, analysis.patch?.target.file));
  }
}

/** Marks a side of a patch comparison as not analysed as it is, and publishes its problems after a pause. */
function scheduleSide(uri: string): void {
  staleSides.add(uri);
  clearTimeout(sideTimers.get(uri));
  sideTimers.set(
    uri,
    setTimeout(() => {
      sideTimers.delete(uri);
      publishSides(uri);
    }, sideDelay)
  );
}

/**
 * Analyses a side of a patch comparison now, as the script it shows: as the file the patch changes, once
 * the index knows that file.
 */
function analyzeSide(document: TextDocument): DocumentAnalysis | undefined {
  staleSides.delete(document.uri);
  const side = comparisonSideOf(document.uri);
  if (!side) {
    return undefined;
  }
  const patch = filePathOf(side.patch) ?? gameFileOfUri(side.patch);
  const target = patch === undefined ? undefined : game?.index?.patchTarget(patch)?.file;
  const started = performance.now();
  const analysis = analyzeComparisonSide(document, side.side, target, analysisContext());
  analysisByUri.set(document.uri, analysis);
  debug(`${document.uri}: the side ${side.side} the patch, ${target ? `as ${target}` : 'target not known'}, ${(performance.now() - started).toFixed(1)} ms`);
  return analysis;
}

/**
 * Publishes the problems of both sides of the comparison a side belongs to: in the side with the patch,
 * those the side before it does not have; none in that side, since they are the target's.
 */
function publishSides(uri: string): void {
  const patch = comparisonSideOf(uri)?.patch;
  const sides = documents.all().flatMap((document) => {
    const side = comparisonSideOf(document.uri);
    return side && side.patch === patch ? [{ document, side: side.side }] : [];
  });
  const before = sides.find((side) => side.side === 'before');
  const beforeAnalysis = before && currentAnalysis(before.document.uri);
  for (const { document, side } of sides) {
    const analysis = side === 'after' ? currentAnalysis(document.uri) : undefined;
    const diagnostics = analysis ? newProblems(analysis, beforeAnalysis) : [];
    void connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
  }
}

/** The analysis of an open document; a side of a patch comparison not analysed as it is now is analysed at once. */
function currentAnalysis(uri: string): DocumentAnalysis | undefined {
  const document = documents.get(uri);
  return document && staleSides.has(uri) ? analyzeSide(document) : analysisByUri.get(uri);
}

/**
 * Locations as the client knows them: those in the document analysed for a side of a patch comparison or
 * a game document under the uri the client sent, those in an installed game's catalogs as game documents.
 */
function locationsInClient(uri: string, analysis: DocumentAnalysis, locations: Location[]): Location[] {
  const analysed = analysis.document.uri;
  return locations.map((location) => {
    const shown = location.uri === analysed ? uri : clientUriOf(location.uri);
    return shown === location.uri ? location : { ...location, uri: shown };
  });
}

/** Analyses the open patch documents again that a file affects: it is their target, or a patch applied before them. */
function reanalyzePatchesOf(file: string, except?: string): void {
  const key = path.resolve(file).toLowerCase();
  const affected = (candidate: string | undefined): boolean => candidate !== undefined && path.resolve(candidate).toLowerCase() === key;
  let reanalyzed = false;
  for (const document of documents.all()) {
    const patch = document.uri === except ? undefined : analysisByUri.get(document.uri)?.patch;
    if (patch && (affected(patch.target.file) || patch.earlier.some(affected))) {
      analyze(document);
      reanalyzed = true;
    }
  }
  if (reanalyzed) {
    refreshSemanticTokens();
  }
}

/** A file's key for the bookkeeping: its full path without case, as Windows compares names. */
function fileKey(file: string): string {
  return path.resolve(file).toLowerCase();
}

/** The keys of the files open in the editor. */
function openFiles(): Set<string> {
  return new Set(
    documents.all().flatMap((document) => {
      const file = filePathOf(document.uri);
      return file === undefined ? [] : [fileKey(file)];
    })
  );
}

/**
 * The patches of a file, and of the file a patch or a merge file changes, without the file itself: what
 * they find depends on its text.
 */
function patchFilesOf(file: string, target?: string): string[] {
  const index = game?.index;
  if (!index) {
    return [];
  }
  const own = fileKey(file);
  target ??= index.isLibraryFile(file) ? index.patchTarget(file)?.file : undefined;
  return [file, ...(target ? [target] : [])]
    .flatMap((patched) => index.patchesOf(patched).map((patch) => patch.file))
    .filter((patch) => fileKey(patch) !== own);
}

/**
 * True when the workspace's problems are asked for and the file is an indexed script or patch, or a file
 * of an extension's `libraries`, in a workspace folder.
 */
function isCheckedInWorkspace(file: string): boolean {
  const index = game?.index;
  return (
    settings.diagnosticMode === 'workspace' &&
    index !== undefined &&
    (index.hasFile(file) || index.isLibraryFile(file)) &&
    workspaceFolders.some((folder) => isInside(file, folder))
  );
}

/** True when the file's problems are shown while it is no open document: it is in an editor tab, or checked in the workspace. */
function isChecked(file: string): boolean {
  return tabFiles.has(fileKey(file)) || isCheckedInWorkspace(file);
}

/**
 * Analyses a closed script of the workspace as it is on disk and publishes its problems when they
 * changed, under the uri the client knows the file by. `shown` when the client shows other problems for
 * it: those of the document just closed.
 */
function checkClosedFile(key: string, file: string, shown = false): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    clearWorkspaceProblems(key);
    return;
  }
  const uri = clientUris.get(key) ?? pathToFileURL(file).toString();
  const diagnostics = analyzeDocument(TextDocument.create(uri, 'xml', 0, text), analysisContext()).diagnostics;
  const sent = JSON.stringify(diagnostics);
  const published = workspaceProblems.get(key);
  if (!shown && (published ? published.uri === uri && published.sent === sent : diagnostics.length === 0)) {
    workspaceProblems.set(key, { uri, count: diagnostics.length, sent });
    return;
  }
  if (published && published.uri !== uri && published.count > 0) {
    void connection.sendDiagnostics({ uri: published.uri, diagnostics: [] });
  }
  workspaceProblems.set(key, { uri, count: diagnostics.length, sent });
  void connection.sendDiagnostics({ uri, diagnostics });
}

/** Drops the problems published for a closed script. */
function clearWorkspaceProblems(key: string): void {
  const published = workspaceProblems.get(key);
  workspaceProblems.delete(key);
  if (published && published.count > 0) {
    void connection.sendDiagnostics({ uri: published.uri, diagnostics: [] });
  }
}

/**
 * Checks the scripts that are no open documents again once changes pause: every one when no files are
 * given, else those. Only when there are such scripts: editor tabs, or the workspace's when asked for.
 */
function scheduleWorkspaceCheck(files?: readonly string[]): void {
  if ((tabFiles.size === 0 && (settings.diagnosticMode !== 'workspace' || !game?.index)) || files?.length === 0) {
    return;
  }
  if (files) {
    for (const file of files) {
      workspacePending.files.set(fileKey(file), file);
    }
  } else {
    workspacePending.all = true;
  }
  clearTimeout(workspaceTimer);
  workspaceTimer = setTimeout(() => {
    workspaceTimer = undefined;
    const pending = workspacePending;
    workspacePending = { all: false, files: new Map() };
    if (pending.all) {
      void checkWorkspace(false);
    } else {
      checkWorkspaceFiles(pending.files);
    }
  }, workspaceDelay);
}

/** Checks some scripts that are no open documents again; for files that are open or no longer checked, nothing is published or it is cleared. */
function checkWorkspaceFiles(files: ReadonlyMap<string, string>): void {
  const open = openFiles();
  for (const [key, file] of files) {
    if (open.has(key)) {
      continue;
    }
    if (isChecked(file)) {
      checkClosedFile(key, file);
    } else {
      clearWorkspaceProblems(key);
    }
  }
}

/**
 * Checks every script that is no open document, as it is on disk, and publishes the problems that
 * changed: the files of the editor tabs the editor has not loaded yet, and when the workspace's problems
 * are asked for, the indexed scripts and patches and the files of extensions' `libraries` in a workspace
 * folder. Clears those of files no longer checked. In slices, so requests are answered meanwhile; a newer
 * check stops this one, and while the game files are read or the index is built, the build checks them
 * when it is done. Announced with
 * progress and in the log after the index was built or the settings changed, silent after an edit.
 */
async function checkWorkspace(announce: boolean): Promise<void> {
  const generation = ++workspaceGeneration;
  clearTimeout(workspaceTimer);
  workspaceTimer = undefined;
  workspacePending = { all: false, files: new Map() };
  if (indexing || loadingGame !== undefined) {
    return;
  }
  const index = settings.diagnosticMode === 'workspace' ? game?.index : undefined;
  const wanted = new Map(tabFiles);
  for (const entry of [...(index?.entries() ?? []), ...(index?.libraryFiles() ?? [])]) {
    if (workspaceFolders.some((folder) => isInside(entry.file, folder))) {
      wanted.set(fileKey(entry.file), entry.file);
    }
  }
  for (const key of [...workspaceProblems.keys()]) {
    if (!wanted.has(key)) {
      clearWorkspaceProblems(key);
    }
  }
  let open = openFiles();
  const files = [...wanted].filter(([key]) => !open.has(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (files.length === 0) {
    return;
  }
  let finished = false;
  let progress: WorkDoneProgressServerReporter | undefined;
  if (announce) {
    void connection.window.createWorkDoneProgress().then((reporter) => {
      if (finished) {
        reporter.done();
      } else {
        progress = reporter;
        reporter.begin('X4CodeSense', 0, 'checking scripts on disk');
      }
    });
  }
  try {
    const started = performance.now();
    let slice = started;
    let reported = started;
    for (const [done, [key, file]] of files.entries()) {
      if (generation !== workspaceGeneration) {
        return;
      }
      if (!open.has(key)) {
        checkClosedFile(key, file);
      }
      if (performance.now() - slice > 25) {
        if (slice - reported > 250) {
          progress?.report(Math.floor((100 * done) / files.length), `checking scripts on disk: ${done} of ${files.length}`);
          reported = slice;
        }
        await new Promise((resolve) => setImmediate(resolve));
        slice = performance.now();
        open = openFiles();
      }
    }
    const counts = files.map(([key]) => workspaceProblems.get(key)?.count ?? 0);
    const problems = counts.reduce((sum, count) => sum + count, 0);
    (announce ? log : debug)(
      `checked ${files.length} script(s) on disk in ${(performance.now() - started).toFixed(0)} ms: ${problems} problem(s) in ${counts.filter((count) => count > 0).length} of them`
    );
  } finally {
    finished = true;
    progress?.done();
  }
}

// An open document's problems are its analysis's from now on: those of the file on disk are dropped.
documents.onDidOpen((event) => {
  const file = filePathOf(event.document.uri);
  if (!file) {
    return;
  }
  const key = fileKey(file);
  clientUris.set(key, event.document.uri);
  const published = workspaceProblems.get(key);
  workspaceProblems.delete(key);
  if (published && published.uri !== event.document.uri && published.count > 0) {
    void connection.sendDiagnostics({ uri: published.uri, diagnostics: [] });
  }
});

documents.onDidChangeContent((event) => {
  const textFile = textFileOf(event.document.uri);
  if (textFile && game) {
    // A text being written: scripts that refer to it are checked against the editor's content.
    game.texts.setFile(textFile, event.document.getText());
    reanalyzeAll();
    scheduleWorkspaceCheck();
    return;
  }
  analyze(event.document);
});

documents.onDidClose((event) => {
  analysisByUri.delete(event.document.uri);
  tokenBuilders.delete(event.document.uri);
  readTextCallsByUri.delete(event.document.uri);
  staleSides.delete(event.document.uri);
  clearTimeout(sideTimers.get(event.document.uri));
  sideTimers.delete(event.document.uri);
  if (isLua(event.document)) {
    return;
  }
  // Back to the file on disk, which may not have the unsaved changes.
  const file = filePathOf(event.document.uri);
  const changed = file !== undefined && rereadFromDisk(file);
  // A script still in a tab, or of the workspace when its problems are asked for, keeps its problems as it is on disk.
  if (file && isChecked(file)) {
    checkClosedFile(fileKey(file), file, true);
  } else {
    void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  }
  if (changed) {
    reanalyzeAll();
    scheduleWorkspaceCheck();
  } else if (file) {
    reanalyzePatchesOf(file);
    scheduleWorkspaceCheck(patchFilesOf(file));
  }
});

/** The analysis and caret offset behind a request, when the document is open and analysed. */
function locate(uri: string, position: { line: number; character: number }): { analysis: DocumentAnalysis; offset: number } | undefined {
  const analysis = currentAnalysis(uri);
  const document = documents.get(uri);
  if (!analysis || !document) {
    return undefined;
  }
  return { analysis, offset: document.offsetAt(position) };
}

connection.onCompletion((params): CompletionList | CompletionItem[] => {
  const located = locate(params.textDocument.uri, params.position);
  if (!located) {
    return [];
  }
  const started = performance.now();
  const items = completionAt(located.analysis, located.offset, game, { snippetSupport, ...textDisplay() });
  debug(`${params.textDocument.uri}: ${items.length} completion(s) in ${(performance.now() - started).toFixed(1)} ms`);
  return { isIncomplete: false, items };
});

/** The `ReadText` calls of an open Lua document, as of its version. */
function readTextCallsOf(document: TextDocument): ReadTextCall[] {
  const known = readTextCallsByUri.get(document.uri);
  if (known?.version === document.version) {
    return known.calls;
  }
  const started = performance.now();
  const calls = readTextCalls(document.getText());
  readTextCallsByUri.set(document.uri, { version: document.version, calls });
  debug(`${document.uri}: ${calls.length} ReadText call(s) in ${(performance.now() - started).toFixed(1)} ms`);
  return calls;
}

connection.onHover((params): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (document && isLua(document)) {
    const texts = game?.texts;
    return texts && texts.fileCount > 0
      ? (readTextHover(document, readTextCallsOf(document), document.offsetAt(params.position), texts, textDisplay()) ?? null)
      : null;
  }
  const located = locate(params.textDocument.uri, params.position);
  return located ? (hoverAt(located.analysis, located.offset, game, textDisplay()) ?? null) : null;
});

// In the arguments of a format (`'%s of %s'.[…]`): its placeholders; in a call (`run_script`, `create_order`,
// `run_actions`, `<cue ref>`, …): its target's parameters.
connection.onSignatureHelp((params): SignatureHelp | null => {
  const located = locate(params.textDocument.uri, params.position);
  if (!located) {
    return null;
  }
  const { analysis, offset } = located;
  return formatSignatureHelp(analysis, offset, game, textDisplay()) ?? callSignatureHelp(analysis, offset, game, textDisplay().language) ?? null;
});

connection.onDefinition((params): Location[] => {
  const uri = params.textDocument.uri;
  const located = locate(uri, params.position);
  return located ? locationsInClient(uri, located.analysis, definitionAt(located.analysis, located.offset, game, textDisplay())) : [];
});

connection.onReferences((params): Location[] => {
  const uri = params.textDocument.uri;
  const located = locate(uri, params.position);
  return located ? locationsInClient(uri, located.analysis, referencesAt(located.analysis, located.offset, game)) : [];
});

/** Why nothing is renamed from a document: a side of a patch comparison or a game document; undefined for others. */
function renameRefusal(uri: string): string | undefined {
  return comparisonSideOf(uri) ? sideRenameRefusal : gameFileOfUri(uri) !== undefined ? gameFileRefusal : undefined;
}

// A rename may edit other files of the workspace, never the game's; a refusal is shown to the user.
connection.onPrepareRename((params) => {
  const refusal = renameRefusal(params.textDocument.uri);
  if (refusal) {
    return new ResponseError(ErrorCodes.InvalidRequest, refusal);
  }
  const located = locate(params.textDocument.uri, params.position);
  const prepared = located ? prepareRenameAt(located.analysis, located.offset, game, { editableFolders: workspaceFolders }) : undefined;
  if (prepared && 'refused' in prepared) {
    return new ResponseError(ErrorCodes.InvalidRequest, prepared.refused);
  }
  return prepared ?? null;
});

connection.onRenameRequest((params): WorkspaceEdit | ResponseError | null => {
  const refusal = renameRefusal(params.textDocument.uri);
  if (refusal) {
    return new ResponseError(ErrorCodes.InvalidRequest, refusal);
  }
  const located = locate(params.textDocument.uri, params.position);
  const renamed = located ? renameAt(located.analysis, located.offset, params.newName, game, { editableFolders: workspaceFolders }) : undefined;
  if (renamed && 'refused' in renamed) {
    return new ResponseError(ErrorCodes.InvalidRequest, renamed.refused);
  }
  return renamed ?? null;
});

// Other XML gets no outline from here, so other XML tooling gives it one.
connection.onDocumentSymbol((params): DocumentSymbol[] | null => {
  const analysis = currentAnalysis(params.textDocument.uri);
  return analysis?.structure ? documentSymbols(analysis, game && { database: game.texts, language: textDisplay().language }) : null;
});

// The scripts, cues and interrupt library items of the index; the workspace's own first among equal matches.
connection.onWorkspaceSymbol((params): WorkspaceSymbol[] => {
  const index = game?.index;
  if (!index) {
    return [];
  }
  const started = performance.now();
  const symbols = workspaceSymbols(index, params.query, { preferredFolders: workspaceFolders });
  debug(`workspace symbols for '${params.query}': ${symbols.length} in ${(performance.now() - started).toFixed(1)} ms`);
  return symbols.map((symbol) => {
    const uri = clientUriOf(symbol.location.uri);
    return uri === symbol.location.uri ? symbol : { ...symbol, location: { ...symbol.location, uri } };
  });
});

// Quick fixes for the diagnostics the editor sends along, as far as the current analysis still has them,
// with one that applies every preferred fix of the document when it has two or more; and that one as
// `source.fixAll` when asked for (the Source Action menu, `editor.codeActionsOnSave`). The side of a
// patch comparison before the patch and the game documents are read only.
connection.onCodeAction((params): CodeAction[] => {
  const uri = params.textDocument.uri;
  const analysis = comparisonSideOf(uri)?.side === 'before' || gameFileOfUri(uri) !== undefined ? undefined : currentAnalysis(uri);
  const only = params.context.only;
  const asked = (kind: string): boolean => !only || only.some((wanted) => kind === wanted || kind.startsWith(`${wanted}.`));
  if (!analysis) {
    return [];
  }
  const started = performance.now();
  const actions: CodeAction[] = [];
  if (asked(CodeActionKind.QuickFix)) {
    actions.push(...quickFixes(analysis, params.context.diagnostics, game));
    const all = actions.length > 0 ? fixAllOf(analysis) : undefined;
    if (all && (all.diagnostics?.length ?? 0) > 1) {
      actions.push({ ...all, kind: CodeActionKind.QuickFix });
    }
  }
  if (only && asked(CodeActionKind.SourceFixAll)) {
    const all = fixAllOf(analysis);
    if (all) {
      actions.push(all);
    }
  }
  debug(`${uri}: ${actions.length} code action(s) in ${(performance.now() - started).toFixed(1)} ms`);
  const analysed = analysis.document.uri;
  // The edits of a side's analysis are the side's; those of another file go to it as the client named it.
  const target = (changed: string): string => {
    if (changed === analysed) {
      return uri;
    }
    const file = filePathOf(changed);
    return (file !== undefined && clientUris.get(fileKey(file))) || changed;
  };
  return actions.map((action) => {
    const changes = action.edit?.changes;
    if (!changes || Object.keys(changes).every((changed) => target(changed) === changed)) {
      return action;
    }
    return { ...action, edit: { ...action.edit, changes: Object.fromEntries(Object.entries(changes).map(([changed, edits]) => [target(changed), edits])) } };
  });
});

/** Fix all of each analysis, worked out once: the editor asks for code actions whenever the caret moves onto a problem. */
const fixAllByAnalysis = new WeakMap<DocumentAnalysis, CodeAction | null>();

function fixAllOf(analysis: DocumentAnalysis): CodeAction | undefined {
  let all = fixAllByAnalysis.get(analysis);
  if (all === undefined) {
    all = fixAll(analysis, game) ?? null;
    fixAllByAnalysis.set(analysis, all);
  }
  return all ?? undefined;
}

/** Fills a builder with the semantic tokens of an open document; false for a document other XML tooling colours. */
function buildTokens(uri: string, builder: SemanticTokensBuilder, range?: Range): boolean {
  const analysis = currentAnalysis(uri);
  const document = documents.get(uri);
  if (!analysis || !document) {
    return false;
  }
  const started = performance.now();
  const tokens = semanticTokens(analysis, game, range && { start: document.offsetAt(range.start), end: document.offsetAt(range.end) });
  if (!tokens) {
    return false;
  }
  for (const token of positionTokens(document, tokens)) {
    builder.push(token.line, token.character, token.length, token.tokenType, token.tokenModifiers);
  }
  debug(`${uri}: ${tokens.length} semantic token(s)${range ? ' in a range' : ''} in ${(performance.now() - started).toFixed(1)} ms`);
  return true;
}

connection.languages.semanticTokens.on((params): SemanticTokens | null => {
  const uri = params.textDocument.uri;
  const builder = new SemanticTokensBuilder();
  if (!buildTokens(uri, builder)) {
    tokenBuilders.delete(uri);
    return null;
  }
  tokenBuilders.set(uri, builder);
  return builder.build();
});

connection.languages.semanticTokens.onDelta((params): SemanticTokens | SemanticTokensDelta | null => {
  const uri = params.textDocument.uri;
  const builder = tokenBuilders.get(uri) ?? new SemanticTokensBuilder();
  builder.previousResult(params.previousResultId);
  if (!buildTokens(uri, builder)) {
    tokenBuilders.delete(uri);
    return null;
  }
  tokenBuilders.set(uri, builder);
  return builder.buildEdits();
});

connection.languages.semanticTokens.onRange((params): SemanticTokens | null => {
  const builder = new SemanticTokensBuilder();
  return buildTokens(params.textDocument.uri, builder, params.range) ? builder.build() : null;
});

connection.onRequest(DocumentInfoRequestMethod, (params: DocumentInfoParams): DocumentInfoResult => {
  const analysis = analysisByUri.get(params.uri);
  const detection = analysis?.detection;
  const patch = analysis?.patch;
  const file = patch?.target.file;
  const source = file === undefined ? undefined : game?.index?.sourceOf(file);
  const uri = file === undefined ? undefined : clientUriOf(pathToFileURL(file).toString());
  return {
    metadata: detection?.script,
    isDiff: detection?.isDiff ?? false,
    rootElement: detection?.rootElement,
    patchTarget: patch ? { ...patch.target, ...(uri ? { uri } : {}), ...(source ? { source } : {}), earlier: patch.earlier, merged: patch.merged } : undefined,
  };
});

// The text of a game document: a file of the installed game's catalogs, read when the client shows it.
connection.onRequest(GameFileRequestMethod, (params: GameFileParams): GameFileResult => {
  const file = gameFileOfUri(params.uri);
  if (!game || file === undefined) {
    return null;
  }
  try {
    return { text: game.files.readText(file) };
  } catch {
    return null;
  }
});

// The file a patch changes, before and after the patch, for the client to compare.
connection.onRequest(PatchComparisonRequestMethod, (params: PatchComparisonParams): PatchComparisonResult => {
  const patch = analysisByUri.get(params.uri)?.patch;
  const compared = patch && game?.index ? comparePatch(patch, game.index) : undefined;
  // Every change of an open document is analysed as it comes, so the analysis is of the current version.
  const version = documents.get(params.uri)?.version;
  return compared && version !== undefined ? { ...compared, version } : null;
});

// What a patch must become for the edited side of its comparison.
connection.onRequest(PatchWriteRequestMethod, (params: PatchWriteParams): PatchWriteResult => {
  const document = documents.get(params.uri);
  const patch = analysisByUri.get(params.uri)?.patch;
  const refuse = (reason: string): PatchWriteResult => ({ edits: [], changes: [], refused: [{ line: 0, reason }] });
  if (gameFileOfUri(params.uri) !== undefined) {
    return refuse(gameFileRefusal);
  }
  if (!document || !patch || !game?.index) {
    return refuse('The patch is not open, or the file it changes is not known yet');
  }
  if (document.version !== params.version) {
    // The side does not have what was changed in the patch since: writing it would undo that.
    return refuse('The patch changed since this side was last in step with it: revert the side and make the change again');
  }
  const written = writePatch(patch, params.edited, game.index);
  debug(`${params.uri}: side written, ${written.changes.length} change(s), ${written.refused.length} refused`);
  return {
    edits: written.edits.map((edit) => ({
      range: { start: document.positionAt(edit.offset), end: document.positionAt(edit.offset + edit.length) },
      newText: edit.text,
    })),
    changes: written.changes,
    refused: written.refused,
  };
});

documents.listen(connection);
connection.listen();
