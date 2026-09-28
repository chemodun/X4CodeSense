import {
  createConnection,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  type CompletionList,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  analyzeDocument,
  completionAt,
  definitionAt,
  DocumentInfoRequestMethod,
  hoverAt,
  loadGameData,
  type AnalysisContext,
  type DocumentAnalysis,
  type DocumentInfoParams,
  type DocumentInfoResult,
  type GameData,
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
const completionTriggerCharacters = ['<', '.', '"', ' ', '$', '{'];

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: X4CodeSenseSettings = defaultSettings;
let hasConfigurationCapability = false;
let snippetSupport = false;
let game: GameData | undefined;

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

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = params.capabilities.workspace?.configuration === true;
  snippetSupport = params.capabilities.textDocument?.completion?.completionItem?.snippetSupport === true;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: completionTriggerCharacters },
      hoverProvider: true,
      definitionProvider: true,
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
  if (folder === undefined) {
    game = undefined;
    warn('x4CodeSense.unpackedFileLocation is not set: scripts are not validated against the game schemas and have no property completion');
    return;
  }
  const started = performance.now();
  game = loadGameData(folder);
  const schemas = Object.keys(game.schemas.schemas);
  const properties = game.properties;
  log(
    `loaded ${schemas.length > 0 ? `schemas ${schemas.join(', ')}` : 'no schemas'}${properties ? `, ${properties.datatypes.size} datatypes and ${properties.keywords.length} keywords` : ', no script properties'} from ${folder} in ${(performance.now() - started).toFixed(0)} ms`
  );
  for (const problem of game.problems.slice(0, 50)) {
    warn(problem);
  }
  if (game.problems.length > 50) {
    warn(`${game.problems.length - 50} more problems not shown`);
  }
}

async function refreshSettings(): Promise<void> {
  if (!hasConfigurationCapability) {
    return;
  }
  const received = (await connection.workspace.getConfiguration('x4CodeSense')) as Partial<X4CodeSenseSettings> | null;
  settings = { ...defaultSettings, ...(received ?? {}) };
  log(
    `settings: unpackedFileLocation='${settings.unpackedFileLocation}' extensionsFolder='${settings.extensionsFolder}' languageNumber=${settings.languageNumber} validateXmlStructure=${settings.validateXmlStructure} debug=${settings.debug}`
  );
  refreshGameData();
}

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    await connection.client.register(DidChangeConfigurationNotification.type, { section: 'x4CodeSense' });
    await refreshSettings();
  } else {
    refreshGameData();
  }
  log('server initialized');
});

connection.onDidChangeConfiguration(async () => {
  await refreshSettings();
  for (const document of documents.all()) {
    analyze(document);
  }
});

function analysisContext(): AnalysisContext {
  const context: AnalysisContext = { validateStructure: settings.validateXmlStructure };
  if (game) {
    context.schemas = game.schemas;
  }
  return context;
}

/** Analyses one document and publishes its diagnostics. */
function analyze(document: TextDocument): void {
  const started = performance.now();
  const analysis = analyzeDocument(document, analysisContext());
  analysisByUri.set(document.uri, analysis);
  const detection = analysis.detection;
  const description = detection.script
    ? `${detection.script.schema} '${detection.script.name}'`
    : detection.isDiff
      ? 'patch'
      : `not a script (root '${detection.rootElement ?? ''}')`;
  debug(`${document.uri}: ${description}, ${analysis.diagnostics.length} diagnostic(s), ${(performance.now() - started).toFixed(1)} ms`);
  void connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: analysis.diagnostics });
}

documents.onDidChangeContent((event) => {
  analyze(event.document);
});

documents.onDidClose((event) => {
  analysisByUri.delete(event.document.uri);
  void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
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
  const items = completionAt(located.analysis, located.offset, game, { snippetSupport });
  debug(`${params.textDocument.uri}: ${items.length} completion(s) in ${(performance.now() - started).toFixed(1)} ms`);
  return { isIncomplete: false, items };
});

connection.onHover((params): Hover | null => {
  const located = locate(params.textDocument.uri, params.position);
  return located ? (hoverAt(located.analysis, located.offset, game) ?? null) : null;
});

connection.onDefinition((params): Location[] => {
  const located = locate(params.textDocument.uri, params.position);
  return located ? definitionAt(located.analysis, located.offset, game) : [];
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
