import {
  createConnection,
  DidChangeConfigurationNotification,
  ErrorCodes,
  FileChangeType,
  ProposedFeatures,
  ResponseError,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  type CompletionList,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  analyzeDocument,
  completionAt,
  definitionAt,
  DocumentInfoRequestMethod,
  hoverAt,
  languageOfTextFile,
  loadGameData,
  loadTexts,
  parseXml,
  prepareRenameAt,
  referencesAt,
  renameAt,
  ScriptIndex,
  scriptFiles,
  scriptFolders,
  type AnalysisContext,
  type DocumentAnalysis,
  type DocumentInfoParams,
  type DocumentInfoResult,
  type GameData,
  type TextDisplayOptions,
  type TextLoadOptions,
  type XmlStructure,
} from 'x4-script-core';

/** Settings under the `x4CodeSense` section, mirrored from the client's package.json. */
interface X4CodeSenseSettings {
  unpackedFileLocation: string;
  extensionsFolder: string;
  languageNumber: string;
  limitLanguageOutput: boolean;
  validateXmlStructure: boolean;
  debug: boolean;
}

const defaultSettings: X4CodeSenseSettings = {
  unpackedFileLocation: '',
  extensionsFolder: '',
  languageNumber: '44',
  limitLanguageOutput: false,
  validateXmlStructure: true,
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
let game: GameData | undefined;
/** Workspace folders on disk: extensions themselves or holders of extensions, and the base of a relative `extensionsFolder`. */
let workspaceFolders: string[] = [];
/** What the loaded texts were read with, so they are read again only when that changes. */
let textSources: string | undefined;
/** What the script index is built from, so it is built again only when that changes. */
let indexSources: string | undefined;
/** Counts index builds: a build that is no longer the latest stops. */
let indexGeneration = 0;

/** The latest analysis of each open document. */
const analysisByUri = new Map<string, DocumentAnalysis>();

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

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = params.capabilities.workspace?.configuration === true;
  snippetSupport = params.capabilities.textDocument?.completion?.completionItem?.snippetSupport === true;
  workspaceFolderSupport = params.capabilities.workspace?.workspaceFolders === true;
  const folders = params.workspaceFolders?.map((folder) => folder.uri) ?? (params.rootUri ? [params.rootUri] : []);
  workspaceFolders = folders.map(filePathOf).filter((folder): folder is string => folder !== undefined);
  return {
    capabilities: {
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: completionTriggerCharacters },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
    },
    serverInfo: {
      name: 'X4CodeSense language server',
    },
  };
});

/** Loads the schemas and script properties of the unpacked game files, once per folder. */
function refreshGameData(): void {
  const folder = settings.unpackedFileLocation.trim() === '' ? undefined : settings.unpackedFileLocation;
  if (folder === game?.folder || (folder === undefined && game === undefined)) {
    return;
  }
  indexSources = undefined;
  if (folder === undefined) {
    game = undefined;
    warn('x4CodeSense.unpackedFileLocation is not set: scripts are not validated against the game schemas and have no property completion');
    return;
  }
  const started = performance.now();
  const options = textOptions();
  game = loadGameData(folder, options);
  textSources = JSON.stringify(options, (_key, value: unknown) => (value instanceof Set ? [...(value as Set<string>)] : value));
  overlayOpenTextFiles();
  const schemas = Object.keys(game.schemas.schemas);
  const properties = game.properties;
  log(
    `loaded ${schemas.length > 0 ? `schemas ${schemas.join(', ')}` : 'no schemas'}${properties ? `, ${properties.datatypes.size} datatypes and ${properties.keywords.length} keywords` : ', no script properties'}, ${game.texts.textCount} texts from ${game.texts.fileCount} files, from ${folder} in ${(performance.now() - started).toFixed(0)} ms`
  );
  for (const problem of game.problems.slice(0, 50)) {
    warn(problem);
  }
  if (game.problems.length > 50) {
    warn(`${game.problems.length - 50} more problems not shown`);
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
  game.texts = loadTexts(game.folder, options);
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
 * document is analysed again. A newer build stops an older one.
 */
async function refreshIndex(): Promise<void> {
  if (!game) {
    return;
  }
  const folders = scriptFolders(game.folder, extensionFolders());
  const sources = JSON.stringify(folders);
  if (sources === indexSources) {
    return;
  }
  indexSources = sources;
  const generation = ++indexGeneration;
  const target = game;
  const current = (): boolean => generation === indexGeneration && target === game;
  const started = performance.now();
  const index = new ScriptIndex(target.schemas);
  for (const folder of folders) {
    index.addFolder(folder);
  }
  const files = scriptFiles(folders);
  let slice = performance.now();
  for (const source of files) {
    if (!current()) {
      return;
    }
    try {
      index.setText(source.file, readFileSync(source.file, 'utf8'), source.source);
    } catch {
      // A file that cannot be read is left out.
    }
    if (performance.now() - slice > 25) {
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
  log(`indexed ${files.length} script files in ${(performance.now() - started).toFixed(0)} ms`);
  reanalyzeAll();
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
    `settings: unpackedFileLocation='${settings.unpackedFileLocation}' extensionsFolder='${settings.extensionsFolder}' languageNumber=${settings.languageNumber} limitLanguageOutput=${settings.limitLanguageOutput} validateXmlStructure=${settings.validateXmlStructure} debug=${settings.debug}`
  );
  refreshGameData();
  refreshTexts();
  void refreshIndex();
}

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    await connection.client.register(DidChangeConfigurationNotification.type, { section: 'x4CodeSense' });
    await refreshSettings();
  } else {
    refreshGameData();
    void refreshIndex();
  }
  if (workspaceFolderSupport) {
    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      const removed = new Set(event.removed.map((folder) => filePathOf(folder.uri)));
      const added = event.added.map((folder) => filePathOf(folder.uri)).filter((folder): folder is string => folder !== undefined);
      workspaceFolders = [...workspaceFolders.filter((folder) => !removed.has(folder)), ...added];
      refreshTexts();
      reanalyzeAll();
      void refreshIndex();
    });
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
  }
  if (changed) {
    reanalyzeAll();
  }
});

connection.onDidChangeConfiguration(async () => {
  await refreshSettings();
  reanalyzeAll();
});

function reanalyzeAll(except?: string): void {
  for (const document of documents.all()) {
    if (document.uri !== except) {
      analyze(document);
    }
  }
}

function analysisContext(): AnalysisContext {
  const context: AnalysisContext = { validateStructure: settings.validateXmlStructure };
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
  const started = performance.now();
  const analysis = analyzeDocument(document, analysisContext());
  analysisByUri.set(document.uri, analysis);
  if (game?.index && analysis.structure && indexOpenDocument(document, game.index, analysis.structure)) {
    debug(`${document.uri}: names seen by other scripts changed`);
    reanalyzeAll(document.uri);
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
  }
}

/** Analyses the open patch documents again that a file affects: it is their target, or a patch applied before them. */
function reanalyzePatchesOf(file: string, except?: string): void {
  const key = path.resolve(file).toLowerCase();
  const affected = (candidate: string | undefined): boolean => candidate !== undefined && path.resolve(candidate).toLowerCase() === key;
  for (const document of documents.all()) {
    const patch = document.uri === except ? undefined : analysisByUri.get(document.uri)?.patch;
    if (patch && (affected(patch.target.file) || patch.earlier.some(affected))) {
      analyze(document);
    }
  }
}

documents.onDidChangeContent((event) => {
  const textFile = textFileOf(event.document.uri);
  if (textFile && game) {
    // A text being written: scripts that refer to it are checked against the editor's content.
    game.texts.setFile(textFile, event.document.getText());
    reanalyzeAll();
    return;
  }
  analyze(event.document);
});

documents.onDidClose((event) => {
  analysisByUri.delete(event.document.uri);
  void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  // Back to the file on disk, which may not have the unsaved changes.
  const file = filePathOf(event.document.uri);
  if (file && rereadFromDisk(file)) {
    reanalyzeAll();
  } else if (file) {
    reanalyzePatchesOf(file);
  }
});

/** The analysis and caret offset behind a request, when the document is open and analysed. */
function locate(uri: string, position: { line: number; character: number }): { analysis: DocumentAnalysis; offset: number } | undefined {
  const analysis = analysisByUri.get(uri);
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

connection.onHover((params): Hover | null => {
  const located = locate(params.textDocument.uri, params.position);
  return located ? (hoverAt(located.analysis, located.offset, game, textDisplay()) ?? null) : null;
});

connection.onDefinition((params): Location[] => {
  const located = locate(params.textDocument.uri, params.position);
  return located ? definitionAt(located.analysis, located.offset, game, textDisplay()) : [];
});

connection.onReferences((params): Location[] => {
  const located = locate(params.textDocument.uri, params.position);
  return located ? referencesAt(located.analysis, located.offset, game) : [];
});

// A rename may edit other files of the workspace, never the game's; a refusal is shown to the user.
connection.onPrepareRename((params) => {
  const located = locate(params.textDocument.uri, params.position);
  const prepared = located ? prepareRenameAt(located.analysis, located.offset, game, { editableFolders: workspaceFolders }) : undefined;
  if (prepared && 'refused' in prepared) {
    return new ResponseError(ErrorCodes.InvalidRequest, prepared.refused);
  }
  return prepared ?? null;
});

connection.onRenameRequest((params): WorkspaceEdit | ResponseError | null => {
  const located = locate(params.textDocument.uri, params.position);
  const renamed = located ? renameAt(located.analysis, located.offset, params.newName, game, { editableFolders: workspaceFolders }) : undefined;
  if (renamed && 'refused' in renamed) {
    return new ResponseError(ErrorCodes.InvalidRequest, renamed.refused);
  }
  return renamed ?? null;
});

connection.onRequest(DocumentInfoRequestMethod, (params: DocumentInfoParams): DocumentInfoResult => {
  const detection = analysisByUri.get(params.uri)?.detection;
  return {
    metadata: detection?.script,
    isDiff: detection?.isDiff ?? false,
    rootElement: detection?.rootElement,
  };
});

documents.listen(connection);
connection.listen();
