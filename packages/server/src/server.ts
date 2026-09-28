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
import { detectDocument, DocumentInfoRequestMethod, type DocumentDetection, type DocumentInfoParams, type DocumentInfoResult } from 'x4-script-core';

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
  validateXmlStructure: false,
  debug: false,
};

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: X4CodeSenseSettings = defaultSettings;
let hasConfigurationCapability = false;

/** What the server currently knows about each open document. */
const detectionByUri = new Map<string, DocumentDetection>();

function log(message: string): void {
  connection.console.log(`[X4CodeSense] ${message}`);
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

async function refreshSettings(): Promise<void> {
  if (!hasConfigurationCapability) {
    return;
  }
  const received = (await connection.workspace.getConfiguration('x4CodeSense')) as Partial<X4CodeSenseSettings> | null;
  settings = { ...defaultSettings, ...(received ?? {}) };
  log(
    `settings: unpackedFileLocation='${settings.unpackedFileLocation}' extensionsFolder='${settings.extensionsFolder}' languageNumber=${settings.languageNumber} validateXmlStructure=${settings.validateXmlStructure} debug=${settings.debug}`
  );
}

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    await connection.client.register(DidChangeConfigurationNotification.type, { section: 'x4CodeSense' });
    await refreshSettings();
  }
  log('server initialized');
});

connection.onDidChangeConfiguration(async () => {
  await refreshSettings();
  for (const document of documents.all()) {
    analyze(document);
  }
});

/**
 * Analyses one document. For now this only detects the script kind and clears diagnostics;
 * the XML structure, expression and symbol passes are added on top of this entry point.
 */
function analyze(document: TextDocument): void {
  const detection = detectDocument(document.getText());
  detectionByUri.set(document.uri, detection);
  const description = detection.script
    ? `${detection.script.schema} '${detection.script.name}'`
    : detection.isDiff
      ? 'patch'
      : `not a script (root '${detection.rootElement ?? ''}')`;
  debug(`${document.uri}: ${description}`);
  void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
}

documents.onDidChangeContent((event) => {
  analyze(event.document);
});

documents.onDidClose((event) => {
  detectionByUri.delete(event.document.uri);
  void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onRequest(DocumentInfoRequestMethod, (params: DocumentInfoParams): DocumentInfoResult => {
  const detection = detectionByUri.get(params.uri);
  return {
    metadata: detection?.script,
    isDiff: detection?.isDiff ?? false,
    rootElement: detection?.rootElement,
  };
});

documents.listen(connection);
connection.listen();
