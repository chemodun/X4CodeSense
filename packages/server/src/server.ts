import * as path from 'node:path';
import {
  createConnection,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type InitializeParams,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  analyzeDocument,
  DocumentInfoRequestMethod,
  loadSchemas,
  type AnalysisContext,
  type DocumentAnalysis,
  type DocumentInfoParams,
  type DocumentInfoResult,
  type SchemaSet,
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

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: X4CodeSenseSettings = defaultSettings;
let hasConfigurationCapability = false;
let schemas: SchemaSet | undefined;

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
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
    serverInfo: {
      name: 'X4CodeSense language server',
    },
  };
});

/** Loads the game schemas from the `libraries` folder of the unpacked game files, once per folder. */
function refreshSchemas(): void {
  const folder = settings.unpackedFileLocation.trim() === '' ? undefined : path.join(settings.unpackedFileLocation, 'libraries');
  if (folder === schemas?.folder || (folder === undefined && schemas === undefined)) {
    return;
  }
  if (folder === undefined) {
    schemas = undefined;
    warn('x4CodeSense.unpackedFileLocation is not set: scripts are not validated against the game schemas');
    return;
  }
  const started = performance.now();
  schemas = loadSchemas(folder);
  const loaded = Object.keys(schemas.schemas);
  if (loaded.length === 0) {
    warn(`no schemas found in ${folder}: scripts are not validated against the game schemas`);
  } else {
    log(`loaded schemas ${loaded.join(', ')} from ${folder} in ${(performance.now() - started).toFixed(0)} ms`);
  }
  for (const problem of schemas.problems) {
    warn(`${problem.file}: ${problem.message}`);
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
  refreshSchemas();
}

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    await connection.client.register(DidChangeConfigurationNotification.type, { section: 'x4CodeSense' });
    await refreshSettings();
  } else {
    refreshSchemas();
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
  if (schemas) {
    context.schemas = schemas;
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
