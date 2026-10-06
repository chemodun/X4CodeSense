/**
 * End-to-end test: bundle the server, start it over stdio and talk LSP to it.
 * Self-contained: it does not need a previous `tsc -b` or client bundle.
 * The test client answers `workspace/configuration` with the settings below, so the server loads the
 * fixture schemas and script properties of the core package.
 */
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  CodeActionRequest,
  CompletionRequest,
  ConfigurationRequest,
  createProtocolConnection,
  DefinitionRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  DidChangeWorkspaceFoldersNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  FileChangeType,
  FoldingRangeRequest,
  HoverRequest,
  InitializedNotification,
  InlayHintRefreshRequest,
  InlayHintRequest,
  InitializeRequest,
  PrepareRenameRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RegistrationRequest,
  RenameRequest,
  SemanticTokensDeltaRequest,
  SemanticTokensRangeRequest,
  SemanticTokensRefreshRequest,
  SemanticTokensRequest,
  ShutdownRequest,
  SignatureHelpRequest,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocumentSyncKind,
  WorkDoneProgress,
  WorkDoneProgressCreateRequest,
  WorkspaceSymbolRequest,
  type CodeAction,
  type DocumentSymbol,
  type Location,
  type ProtocolConnection,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { writeCatalog, type CatalogFile } from 'x4-catalog';
import {
  DocumentInfoRequestMethod,
  EditorTabsNotificationMethod,
  GameFileRequestMethod,
  loadGameData,
  patchAfterScheme,
  patchBeforeScheme,
  PatchComparisonRequestMethod,
  PatchWriteRequestMethod,
  semanticTokensLegend,
  StatusNotificationMethod,
  type DocumentInfoResult,
  type GameFileResult,
  type PatchComparisonResult,
  type PatchWriteResult,
  type ServerStatus,
} from '../../core/src';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '../src/server.ts');
const coreEntry = path.resolve(here, '../../core/src/index.ts');
const catalogEntry = path.resolve(here, '../../catalog/src/index.ts');
const unpacked = path.resolve(here, '../../core/tests/fixtures/unpacked');

let workDir: string;
let child: ChildProcess;
let connection: ProtocolConnection;

/** What the test client returns for `workspace/configuration`. */
const clientSettings: Record<string, unknown> = {
  unpackedFileLocation: unpacked,
  validateXmlStructure: true,
  debug: false,
};

const mdText = '<?xml version="1.0"?>\n<mdscript name="Sample" xsi:noNamespaceSchemaLocation="md.xsd">\n  <cues />\n</mdscript>\n';
const aiText = '<aiscript name="order.sample" version="1">\n</aiscript>\n';

/** Every status the server sent, and its progress as `begin: message`, `report: message` and `end`. */
const statuses: ServerStatus[] = [];
const progress: string[] = [];
/** Waiting for a status: each returns true once it took one. The connection has one handler per method. */
const statusWaiters = new Set<(status: ServerStatus) => boolean>();
/** How often the server asked for the semantic tokens of the open documents again. */
let semanticTokensRefreshes = 0;
/** How often the server asked for the inlay hints of the open documents again. */
let inlayHintRefreshes = 0;
/** The methods the server registered for. */
const registrations: string[] = [];

async function documentInfo(uri: string): Promise<DocumentInfoResult> {
  return connection.sendRequest<DocumentInfoResult>(DocumentInfoRequestMethod, { uri });
}

/** Resolves with the latest status when `accept` takes it, else with the next one it takes. */
function statusWhere(accept: (status: ServerStatus) => boolean): Promise<ServerStatus> {
  const latest = statuses[statuses.length - 1];
  if (latest && accept(latest)) {
    return Promise.resolve(latest);
  }
  return new Promise((resolve) => {
    statusWaiters.add((status) => {
      if (accept(status)) {
        resolve(status);
        return true;
      }
      return false;
    });
  });
}

/**
 * Resolves with the next diagnostics the server publishes for the uri, or with the first that `accept`
 * takes when given: a change may be published more than once, for example again when the script index
 * has been built. Call before sending the change that triggers them.
 */
function nextDiagnostics(uri: string, accept: (params: PublishDiagnosticsParams) => boolean = () => true): Promise<PublishDiagnosticsParams> {
  return new Promise((resolve) => {
    const disposable = connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      if (params.uri === uri && accept(params)) {
        disposable.dispose();
        resolve(params);
      }
    });
  });
}

/** Waits for published diagnostics of a uri with this many entries. */
const diagnosticsCount = (uri: string, count: number): Promise<PublishDiagnosticsParams> =>
  nextDiagnostics(uri, (params) => params.diagnostics.length === count);

function summarize(params: PublishDiagnosticsParams): string[] {
  return params.diagnostics.map((diagnostic) => `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.code}`);
}

async function open(uri: string, text: string): Promise<PublishDiagnosticsParams> {
  const published = nextDiagnostics(uri);
  await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'xml', version: 1, text } });
  return published;
}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'x4codesense-server-'));
  const bundle = path.join(workDir, 'server.js');
  await build({
    entryPoints: [serverEntry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
    alias: { 'x4-script-core': coreEntry, 'x4-catalog': catalogEntry },
  });
  child = spawn(process.execPath, [bundle, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  connection = createProtocolConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
  connection.onRequest(ConfigurationRequest.type, (params) => params.items.map(() => ({ ...clientSettings })));
  connection.onRequest(RegistrationRequest.type, (params) => {
    registrations.push(...params.registrations.map((registration) => registration.method));
  });
  connection.onNotification(StatusNotificationMethod, (status: ServerStatus) => {
    statuses.push(status);
    for (const waiter of [...statusWaiters]) {
      if (waiter(status)) {
        statusWaiters.delete(waiter);
      }
    }
  });
  connection.onRequest(WorkDoneProgressCreateRequest.type, ({ token }) => {
    connection.onProgress(WorkDoneProgress.type, token, (value) => {
      progress.push(value.kind === 'end' ? 'end' : `${value.kind}: ${value.message}`);
    });
  });
  connection.onRequest(SemanticTokensRefreshRequest.type, () => {
    semanticTokensRefreshes++;
  });
  connection.onRequest(InlayHintRefreshRequest.type, () => {
    inlayHintRefreshes++;
  });
  connection.listen();
  const result = await connection.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: {
      workspace: {
        configuration: true,
        didChangeConfiguration: { dynamicRegistration: true },
        workspaceFolders: true,
        semanticTokens: { refreshSupport: true },
        inlayHint: { refreshSupport: true },
      },
      textDocument: { completion: { completionItem: { snippetSupport: true } } },
      window: { workDoneProgress: true },
    },
  });
  expect(result.capabilities.textDocumentSync).toBe(TextDocumentSyncKind.Incremental);
  expect(result.capabilities.completionProvider?.triggerCharacters).toEqual(expect.arrayContaining(['<', '/', '@', "'"]));
  expect(result.capabilities.hoverProvider).toBe(true);
  expect(result.capabilities.signatureHelpProvider).toEqual({ triggerCharacters: ['<', '"', ' ', '[', ','] });
  expect(result.capabilities.definitionProvider).toBe(true);
  expect(result.capabilities.referencesProvider).toBe(true);
  expect(result.capabilities.renameProvider).toEqual({ prepareProvider: true });
  expect(result.capabilities.documentSymbolProvider).toEqual({ label: 'X4CodeSense' });
  expect(result.capabilities.foldingRangeProvider).toBe(true);
  expect(result.capabilities.inlayHintProvider).toBe(true);
  expect(result.capabilities.workspaceSymbolProvider).toBe(true);
  expect(result.capabilities.codeActionProvider).toEqual({ codeActionKinds: ['quickfix', 'source.fixAll'] });
  expect(result.capabilities.semanticTokensProvider).toEqual({ legend: semanticTokensLegend, full: { delta: true }, range: true });
  await connection.sendNotification(InitializedNotification.type, {});
}, 30_000);

afterAll(async () => {
  try {
    await connection.sendRequest(ShutdownRequest.type);
    await connection.sendNotification(ExitNotification.type);
  } finally {
    connection.dispose();
    child.kill();
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('status', () => {
  it('tells the client what it reads and when it is ready, with progress meanwhile', async () => {
    const ready = await statusWhere((status) => status.state === 'ready');
    expect(ready).toEqual({
      state: 'ready',
      gameFolder: unpacked,
      gameSource: 'extracted',
      schemas: ['aiscripts', 'diff', 'md'],
      properties: true,
      texts: ready.texts,
      textFiles: 2,
      scripts: 0,
      dlcs: [],
      extensions: [],
      problems: loadGameData(unpacked).problems.length,
    });
    expect(ready.texts).toBeGreaterThan(0);
    expect(statuses.map((status) => status.state)).toEqual(['loading', 'indexing', 'ready']);
    expect(statuses[0].gameFolder).toBeUndefined();
    // The fixture's index is built before the client has made room for its progress, which then only ends.
    await vi.waitFor(() => expect(progress).toEqual(['begin: reading the game files', 'end', 'end']));
    expect(registrations).toEqual(['workspace/didChangeConfiguration']);
  });
});

describe('clients other than VS Code', () => {
  /**
   * Starts another server from the test's bundle, for a client with these workspace capabilities, which
   * answers `workspace/configuration` with `settings()` and `client/registerCapability` with `register`.
   * Returns its connection and the statuses it sent.
   */
  async function startServer(
    workspace: Record<string, unknown>,
    settings: () => unknown,
    register: () => void
  ): Promise<{ other: ProtocolConnection; sent: ServerStatus[] }> {
    const otherChild = spawn(process.execPath, [path.join(workDir, 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const other = createProtocolConnection(new StreamMessageReader(otherChild.stdout!), new StreamMessageWriter(otherChild.stdin!));
    const sent: ServerStatus[] = [];
    other.onRequest(ConfigurationRequest.type, (params) => params.items.map(settings));
    other.onRequest(RegistrationRequest.type, register);
    other.onNotification(StatusNotificationMethod, (status: ServerStatus) => {
      sent.push(status);
    });
    other.listen();
    onTestFinished(async () => {
      try {
        await other.sendRequest(ShutdownRequest.type);
        await other.sendNotification(ExitNotification.type);
      } finally {
        other.dispose();
        otherChild.kill();
      }
    });
    await other.sendRequest(InitializeRequest.type, { processId: process.pid, rootUri: null, capabilities: { workspace } });
    await other.sendNotification(InitializedNotification.type, {});
    return { other, sent };
  }

  const ready = (sent: ServerStatus[]): ServerStatus | undefined => sent.filter((status) => status.state === 'ready').pop();

  it('reads the game for a client that takes no registration for configuration changes', async () => {
    let asked = 0;
    const refuse = (): void => {
      asked++;
      throw new Error('client/registerCapability is not supported');
    };
    // One that does not offer it is not asked; one that offers it and then fails still gets the game.
    const unoffered = await startServer({ configuration: true }, () => ({ unpackedFileLocation: unpacked }), refuse);
    await vi.waitFor(() => expect(ready(unoffered.sent)?.schemas).toEqual(['aiscripts', 'diff', 'md']), { timeout: 10_000 });
    expect(asked).toBe(0);
    const failing = await startServer(
      { configuration: true, didChangeConfiguration: { dynamicRegistration: true } },
      () => ({ unpackedFileLocation: unpacked }),
      refuse
    );
    await vi.waitFor(() => expect(ready(failing.sent)?.schemas).toEqual(['aiscripts', 'diff', 'md']), { timeout: 10_000 });
    expect(asked).toBe(1);
  }, 30_000);

  it('takes a setting of another type as its default, and a language number as the text files are named', async () => {
    let settings: Record<string, unknown> = {
      unpackedFileLocation: unpacked,
      gameFolder: null,
      extensionsFolder: 42,
      languageNumber: '049',
      limitLanguageOutput: true,
      diagnosticMode: 'everything',
      debug: 'yes',
    };
    const { other, sent } = await startServer(
      { configuration: true },
      () => settings,
      () => undefined
    );
    // German and English: `049` is the `49` of `0001-l049.xml`.
    await vi.waitFor(() => expect(ready(sent)).toMatchObject({ schemas: ['aiscripts', 'diff', 'md'], textFiles: 2 }), { timeout: 10_000 });
    settings = { unpackedFileLocation: null };
    const before = sent.length;
    await other.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await vi.waitFor(() => expect(ready(sent.slice(before))?.schemas).toEqual([]), { timeout: 10_000 });
    expect(ready(sent)?.gameFolder).toBeUndefined();
  }, 30_000);
});

describe('language server over stdio', () => {
  it('reports metadata for an opened Mission Director script', async () => {
    const uri = 'file:///mod/md/Sample.xml';
    expect((await open(uri, mdText)).diagnostics).toEqual([]);
    const info = await documentInfo(uri);
    expect(info.metadata).toMatchObject({ schema: 'md', name: 'Sample', schemaLocation: 'md.xsd' });
  });

  it('follows a full-content change to an AI script', async () => {
    const uri = 'file:///mod/md/Sample.xml';
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: aiText }],
    });
    const info = await documentInfo(uri);
    expect(info.metadata).toMatchObject({ schema: 'aiscripts', name: 'order.sample' });
  });

  it('follows an incremental change to the name attribute', async () => {
    const uri = 'file:///mod/md/Sample.xml';
    const nameStart = aiText.indexOf('order.sample');
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 3 },
      contentChanges: [
        {
          range: { start: { line: 0, character: nameStart }, end: { line: 0, character: nameStart + 'order.sample'.length } },
          text: 'lib.renamed',
        },
      ],
    });
    const info = await documentInfo(uri);
    expect(info.metadata?.name).toBe('lib.renamed');
  });

  it('returns no metadata for XML that is not a script', async () => {
    const uri = 'file:///mod/libraries/wares.xml';
    await open(uri, '<wares><ware id="x" /></wares>');
    expect(await documentInfo(uri)).toEqual({ isDiff: false, rootElement: 'wares' });
  });

  it('recognises a patch document', async () => {
    const uri = 'file:///mod/md/patch.xml';
    await open(uri, '<diff><add sel="/mdscript/cues"><cue name="X" /></add></diff>');
    expect(await documentInfo(uri)).toEqual({ isDiff: true, rootElement: 'diff' });
  });

  it('returns no metadata for a document it has never seen', async () => {
    const info = await documentInfo('file:///nowhere.xml');
    expect(info.metadata).toBeUndefined();
  });
});

describe('diagnostics', () => {
  const uri = 'file:///mod/md/Broken.xml';
  const brokenText = '<mdscript name="Broken">\n  <cues>\n    <cue name="A>\n      <actions/>\n    </cue>\n  </cues>\n</mdscript>\n';

  it('publishes well-formedness problems of a script with positions', async () => {
    const params = await open(uri, brokenText);
    expect(params.version).toBe(1);
    expect(params.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.source, diagnostic.range.start.line])).toEqual([
      ['unclosed-attribute', 'X4CodeSense', 2],
    ]);
    expect(params.diagnostics[0].range.start.character).toBe(brokenText.split('\n')[2].indexOf('"A'));
  });

  it('clears the problems once the text is fixed', async () => {
    const published = nextDiagnostics(uri);
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 2, character: 16 }, end: { line: 2, character: 16 } }, text: '"' }],
    });
    const params = await published;
    expect(params.version).toBe(2);
    expect(params.diagnostics).toEqual([]);
  });

  it('validates against the schemas from the configured unpacked folder', async () => {
    const published = nextDiagnostics(uri);
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 3 },
      contentChanges: [
        {
          text: '<mdscript name="Broken">\n  <cues>\n    <cue name="A" bogus="1">\n      <actions><set_value exact="1"/></actions>\n      <conditions/>\n    </cue>\n  </cues>\n</mdscript>\n',
        },
      ],
    });
    expect(summarize(await published)).toEqual(['3:19 unknown-attribute', '4:17 missing-required-attribute', '5:8 invalid-child-element']);
  });

  it('re-analyses open documents when the settings change', async () => {
    clientSettings.validateXmlStructure = false;
    const published = nextDiagnostics(uri);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    expect(summarize(await published)).toEqual(['3:19 unknown-attribute', '4:17 missing-required-attribute']);

    clientSettings.validateXmlStructure = true;
    clientSettings.unpackedFileLocation = '';
    const withoutSchemas = nextDiagnostics(uri);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    expect(summarize(await withoutSchemas)).toEqual([]);
    expect(await statusWhere((status) => status.gameFolder === undefined)).toEqual({
      state: 'ready',
      schemas: [],
      properties: false,
      texts: 0,
      textFiles: 0,
      scripts: 0,
      dlcs: [],
      extensions: [],
      problems: 0,
    });

    clientSettings.unpackedFileLocation = unpacked;
    const restored = nextDiagnostics(uri);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    expect(summarize(await restored).length).toBe(3);
    expect((await statusWhere((status) => status.state === 'ready' && status.gameFolder === unpacked)).schemas).toHaveLength(3);
  });

  it('publishes nothing for XML that is not a script', async () => {
    const otherUri = 'file:///mod/libraries/broken.xml';
    expect((await open(otherUri, '<wares><ware id="x></wares>')).diagnostics).toEqual([]);
  });

  it('clears diagnostics when the document closes', async () => {
    const published = nextDiagnostics(uri);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect((await published).diagnostics).toEqual([]);
    expect((await documentInfo(uri)).metadata).toBeUndefined();
  });
});

describe('completion, hover and definition', () => {
  const uri = 'file:///mod/md/Complete.xml';
  const lines = [
    '<mdscript name="C">',
    '  <cues>',
    '    <cue name="A">',
    '      <actions>',
    '        <set_value name="$x" exact="player.ship."/>',
    '        <',
    '      </actions>',
    '    </cue>',
    '  </cues>',
    '</mdscript>',
    '',
  ];
  const text = lines.join('\n');
  const chainLine = 4;
  const chainEnd = lines[chainLine].indexOf('player.ship.') + 'player.ship.'.length;

  it('completes property chains, elements and attribute values', async () => {
    await open(uri, text);
    const chain = await connection.sendRequest(CompletionRequest.type, { textDocument: { uri }, position: { line: chainLine, character: chainEnd } });
    const chainLabels = Array.isArray(chain) ? chain.map((item) => item.label) : (chain?.items.map((item) => item.label) ?? []);
    expect(chainLabels).toContain('pilot');
    expect(chainLabels).toContain('cargo');

    const elements = await connection.sendRequest(CompletionRequest.type, { textDocument: { uri }, position: { line: 5, character: lines[5].length } });
    const elementLabels = Array.isArray(elements) ? elements.map((item) => item.label) : (elements?.items.map((item) => item.label) ?? []);
    expect(elementLabels).toContain('set_value');
    expect(elementLabels).toContain('debug_text');
  });

  it('hovers keywords and properties', async () => {
    const hover = await connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: chainLine, character: lines[chainLine].indexOf('player') + 2 },
    });
    const value = hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
    expect(value).toContain('**player** *(keyword)*');
    const none = await connection.sendRequest(HoverRequest.type, { textDocument: { uri }, position: { line: 1, character: 0 } });
    expect(none).toBeNull();
  });

  it('goes to the definition of a property', async () => {
    const result = await connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line: chainLine, character: lines[chainLine].indexOf('ship.') + 1 },
    });
    const locations = (Array.isArray(result) ? result : result ? [result] : []) as Location[];
    expect(locations.map((location) => path.basename(location.uri))).toEqual(['scriptproperties.xml']);
    expect(locations[0].range.start.line).toBeGreaterThan(0);
  });
});

describe('typing in expressions', () => {
  it('reports after each edit what the text alone tells, also for values the edit left', async () => {
    const uri = 'file:///mod/md/Typing.xml';
    const lines = [
      '<mdscript name="T">',
      '  <cues>',
      '    <cue name="A">',
      '      <actions>',
      '        <set_value name="$s" exact="player.ship"/>',
      '        <set_value name="$n" exact="$s.pilot.frob"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
      '',
    ];
    const text = lines.join('\n');
    const unknown = (params: PublishDiagnosticsParams): string[] =>
      params.diagnostics.filter((diagnostic) => diagnostic.code === 'expression-unknown-property').map((diagnostic) => String(diagnostic.message));
    const asShip = ["'entity' has no property 'frob' ($s is a ship, set by set_value at line 5)"];
    await statusWhere((status) => status.state === 'ready' && status.gameFolder === unpacked);
    expect(unknown(await open(uri, text))).toEqual(asShip);
    // `$s` becomes a string and a ship again, while the chain on it stays as it was.
    const start = lines[4].indexOf('player.ship');
    const replace = async (version: number, from: string, to: string): Promise<PublishDiagnosticsParams> => {
      const published = nextDiagnostics(uri);
      await connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ range: { start: { line: 4, character: start }, end: { line: 4, character: start + from.length } }, text: to }],
      });
      return published;
    };
    expect(unknown(await replace(2, 'player.ship', "'text'"))).toEqual(["'string' has no property 'pilot' ($s is a string, set by set_value at line 5)"]);
    expect(unknown(await replace(3, "'text'", 'player.ship'))).toEqual(asShip);
    const closed = nextDiagnostics(uri);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    await closed;
    expect(unknown(await open(uri, text))).toEqual(asShip);
  });
});

describe('references and rename', () => {
  const uri = 'file:///mod/md/Rename.xml';
  const lines = [
    '<mdscript name="R">',
    '  <cues>',
    '    <cue name="A">',
    '      <actions>',
    '        <set_value name="$x" exact="1"/>',
    '        <set_value name="$y" exact="$x + 1"/>',
    '      </actions>',
    '    </cue>',
    '  </cues>',
    '</mdscript>',
    '',
  ];
  const position = { line: 5, character: lines[5].indexOf('$x') + 1 };

  it('lists every occurrence of the variable under the caret', async () => {
    await open(uri, lines.join('\n'));
    const locations = await connection.sendRequest(ReferencesRequest.type, { textDocument: { uri }, position, context: { includeDeclaration: true } });
    expect((locations ?? []).map((location) => `${location.range.start.line}:${location.range.start.character}`)).toEqual([
      `4:${lines[4].indexOf('$x')}`,
      `5:${lines[5].indexOf('$x')}`,
    ]);
    expect(
      await connection.sendRequest(ReferencesRequest.type, {
        textDocument: { uri },
        position: { line: 1, character: 3 },
        context: { includeDeclaration: true },
      })
    ).toEqual([]);
  });

  it('prepares and applies a rename', async () => {
    const prepared = await connection.sendRequest(PrepareRenameRequest.type, { textDocument: { uri }, position });
    expect(prepared).toMatchObject({ placeholder: '$x', range: { start: { line: 5, character: lines[5].indexOf('$x') } } });
    const edit = await connection.sendRequest(RenameRequest.type, { textDocument: { uri }, position, newName: '$counter' });
    expect(edit?.changes?.[uri].map((change) => change.newText)).toEqual(['$counter', '$counter']);
    expect(await connection.sendRequest(RenameRequest.type, { textDocument: { uri }, position: { line: 1, character: 3 }, newName: '$z' })).toBeNull();
  });

  it('renames a label and reports one that no block defines', async () => {
    const labelUri = 'file:///mod/aiscripts/order.rename.xml';
    const labelLines = [
      '<aiscript name="order.rename">',
      '  <attention min="unknown">',
      '    <actions>',
      '      <label name="start"/>',
      '      <resume label="start"/>',
      '      <resume label="nowhere"/>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
      '',
    ];
    expect(summarize(await open(labelUri, labelLines.join('\n')))).toEqual([`6:${labelLines[5].indexOf('nowhere') + 1} label-undefined`]);
    const labelPosition = { line: 4, character: labelLines[4].indexOf('start') + 2 };
    const locations = await connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri: labelUri },
      position: labelPosition,
      context: { includeDeclaration: true },
    });
    expect((locations ?? []).map((location) => location.range.start.line)).toEqual([3, 4]);
    const edit = await connection.sendRequest(RenameRequest.type, { textDocument: { uri: labelUri }, position: labelPosition, newName: 'begin' });
    expect(edit?.changes?.[labelUri].map((change) => change.newText)).toEqual(['begin', 'begin']);
  });
});

describe('outline', () => {
  it('outlines scripts and leaves other XML to other tooling', async () => {
    const uri = 'file:///mod/md/Outline.xml';
    const lines = [
      '<mdscript name="O">',
      '  <cues>',
      '    <cue name="A">',
      '      <actions>',
      '        <set_value name="$x" exact="1"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
      '',
    ];
    await open(uri, lines.join('\n'));
    const symbols = (await connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri } })) as DocumentSymbol[] | null;
    const flat = (list: DocumentSymbol[]): string[] =>
      list.flatMap((symbol) => [`${symbol.name}@${symbol.selectionRange.start.line}`, ...flat(symbol.children ?? [])]);
    expect(flat(symbols ?? [])).toEqual(['O@0', 'A@2', '$x@4']);
    const otherUri = 'file:///mod/assets/ship.xml';
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: otherUri, languageId: 'xml', version: 1, text: '<macros>\n  <macro name="m"/>\n</macros>\n' },
    });
    expect(await connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri: otherUri } })).toBeNull();
  });
});

describe('folding', () => {
  it('folds scripts and leaves other XML to other tooling', async () => {
    const uri = 'file:///mod/md/Folding.xml';
    const lines = [
      '<mdscript name="F">',
      '  <cues>',
      '    <!--',
      '      A cue.',
      '    -->',
      '    <cue name="A">',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
      '',
    ];
    await open(uri, lines.join('\n'));
    const ranges = await connection.sendRequest(FoldingRangeRequest.type, { textDocument: { uri } });
    expect(ranges?.map((range) => `${range.startLine}-${range.endLine}${range.kind ? ` ${range.kind}` : ''}`)).toEqual(['0-7', '1-6', '2-4 comment']);
    const otherUri = 'file:///mod/assets/folded.xml';
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: otherUri, languageId: 'xml', version: 1, text: '<macros>\n  <macro name="m">\n  </macro>\n</macros>\n' },
    });
    expect(await connection.sendRequest(FoldingRangeRequest.type, { textDocument: { uri: otherUri } })).toBeNull();
  });
});

describe('inlay hints', () => {
  it('shows texts and variable types, each as the settings ask, and asks for them again when the settings change', async () => {
    const uri = 'file:///mod/md/Hints.xml';
    const lines = [
      '<mdscript name="H">',
      '  <cues>',
      '    <cue name="A">',
      '      <actions>',
      '        <set_value name="$ship" exact="player.ship"/>',
      '        <debug_text text="{1001,2}"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
      '',
    ];
    await open(uri, lines.join('\n'));
    const hints = async (): Promise<string[]> => {
      const found = await connection.sendRequest(InlayHintRequest.type, {
        textDocument: { uri },
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
      });
      return (found ?? []).map((hint) => `${hint.position.line + 1}:${hint.position.character + 1} ${String(hint.label)}`);
    };
    expect(await hints()).toEqual(['5:31 : ship', '6:35 Shield']);
    onTestFinished(async () => {
      delete clientSettings.inlayHints;
      const restored = nextDiagnostics(uri);
      await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
      await restored;
    });
    const refreshes = inlayHintRefreshes;
    clientSettings.inlayHints = { texts: false };
    const reanalysed = nextDiagnostics(uri);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await reanalysed;
    await vi.waitFor(() => expect(inlayHintRefreshes).toBeGreaterThan(refreshes));
    expect(await hints()).toEqual(['5:31 : ship']);
    // Other XML has texts too.
    const otherUri = 'file:///mod/libraries/hinted.xml';
    clientSettings.inlayHints = { variableTypes: false };
    const changed = nextDiagnostics(uri);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await changed;
    expect(await hints()).toEqual(['6:35 Shield']);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: otherUri, languageId: 'xml', version: 1, text: '<wares>\n  <ware id="x" name="{1001,1}"/>\n</wares>\n' },
    });
    const other = await connection.sendRequest(InlayHintRequest.type, {
      textDocument: { uri: otherUri },
      range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
    });
    expect(other?.map((hint) => String(hint.label))).toEqual(['Hull']);
  });
});

describe('quick fixes', () => {
  it('fixes the diagnostics the request sends along, and only when quick fixes are asked for', async () => {
    const uri = 'file:///mod/md/Fixes.xml';
    const lines = [
      '<mdscript name="F">',
      '  <cues>',
      '    <cue name="A">',
      '      <actions>',
      '        <set_valeu name="$x" exact="1"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
      '',
    ];
    const published = await open(uri, lines.join('\n'));
    const diagnostic = published.diagnostics.find((candidate) => candidate.code === 'unknown-element');
    expect(diagnostic).toBeDefined();
    const request = { textDocument: { uri }, range: diagnostic!.range, context: { diagnostics: [diagnostic!] } };
    const actions = (await connection.sendRequest(CodeActionRequest.type, request)) as CodeAction[];
    expect(actions.map((action) => `${action.kind} ${action.title}`)).toEqual(["quickfix Change to 'set_value'"]);
    expect(actions[0].edit?.changes?.[uri]).toEqual([{ range: diagnostic!.range, newText: 'set_value' }]);
    expect(await connection.sendRequest(CodeActionRequest.type, { ...request, context: { ...request.context, only: ['refactor'] } })).toEqual([]);
    const closed = nextDiagnostics(uri);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    await closed;
  });

  it('applies every preferred fix at once: in the light bulb when there are two or more, and as source.fixAll', async () => {
    const uri = 'file:///mod/md/FixAll.xml';
    const lines = [
      '<mdscript name="F">',
      '  <cues>',
      '    <cue name="A">',
      '      <actions>',
      '        <set_valeu name="$x" exact="1"/>',
      '        <debug_text text="1" filter=general/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
      '',
    ];
    const published = await open(uri, lines.join('\n'));
    const diagnostic = published.diagnostics.find((candidate) => candidate.code === 'unknown-element')!;
    const request = { textDocument: { uri }, range: diagnostic.range, context: { diagnostics: [diagnostic] } };
    const actions = (await connection.sendRequest(CodeActionRequest.type, request)) as CodeAction[];
    expect(actions.map((action) => `${action.kind} ${action.title}${action.isPreferred ? ' *' : ''}`)).toEqual([
      "quickfix Change to 'set_value' *",
      'quickfix Apply all preferred fixes in this file (2)',
    ]);
    // On save or from the Source Action menu, without a diagnostic at the caret.
    const source = (await connection.sendRequest(CodeActionRequest.type, {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [], only: ['source.fixAll'] },
    })) as CodeAction[];
    expect(source.map((action) => `${action.kind} ${action.title}`)).toEqual(['source.fixAll Apply all preferred fixes in this file (2)']);
    expect((source[0].edit?.changes?.[uri] ?? []).map((edit) => `${edit.range.start.line}: ${edit.newText}`)).toEqual(['4: set_value', '5: "general"']);
    const closed = nextDiagnostics(uri);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    await closed;
  });
});

describe('signature help for formats', () => {
  it('marks the placeholder of the argument at the caret, before the help of the call the value is in', async () => {
    const uri = 'file:///mod/md/Formats.xml';
    const lines = [
      '<mdscript name="F">',
      '  <cues>',
      '    <library name="Lib"/>',
      '    <cue name="A">',
      '      <actions>',
      '        <run_actions ref="Lib">',
      `          <param name="x" value="'%s of %s'.[$a, $b]"/>`,
      '        </run_actions>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
      '',
    ];
    await open(uri, lines.join('\n'));
    const help = await connection.sendRequest(SignatureHelpRequest.type, {
      textDocument: { uri },
      position: { line: 6, character: lines[6].indexOf('$b') },
    });
    const signature = help?.signatures[0];
    const active = signature?.parameters?.[help?.activeParameter ?? 0]?.label as [number, number];
    expect(`${signature?.label} [${active[0]}, ${active[1]}]`).toBe("'%s of %s' [7, 9]");
    const closed = nextDiagnostics(uri);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    await closed;
  });
});

describe('semantic tokens', () => {
  /** `line text=type[.modifier]` of each token of the protocol's relative encoding; the text is cut from its line. */
  function decode(data: readonly number[], lines: readonly string[]): string[] {
    const result: string[] = [];
    let line = 0;
    let character = 0;
    for (let index = 0; index < data.length; index += 5) {
      character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
      line += data[index];
      const modifiers = semanticTokensLegend.tokenModifiers.filter((_modifier, bit) => (data[index + 4] & (1 << bit)) !== 0);
      const text = lines[line].slice(character, character + data[index + 2]);
      result.push(`${line} ${text}=${[semanticTokensLegend.tokenTypes[data[index + 3]], ...modifiers].join('.')}`);
    }
    return result;
  }

  it('classifies expressions, follows an edit with a delta, answers a range, and leaves other XML to other tooling', async () => {
    const uri = 'file:///mod/md/Tokens.xml';
    const lines = [
      '<mdscript name="T">',
      '  <cues>',
      '    <cue name="A">',
      '      <actions>',
      '        <set_value name="$x" exact="player.money + 1"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
      '',
    ];
    await open(uri, lines.join('\n'));
    const full = await connection.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
    expect(decode(full?.data ?? [], lines)).toEqual([
      '0 T=namespace.declaration',
      '2 A=namespace.declaration',
      '4 $x=variable.modification',
      '4 player=keyword',
      '4 .=operator',
      '4 money=property',
      '4 +=operator',
      '4 1=number',
    ]);

    // `1` becomes `$x * 2`: the delta against the first result gives the tokens of the new text.
    const character = lines[4].indexOf('1"');
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 4, character }, end: { line: 4, character: character + 1 } }, text: '$x * 2' }],
    });
    const changed = [...lines];
    changed[4] = `${lines[4].slice(0, character)}$x * 2${lines[4].slice(character + 1)}`;
    const delta = await connection.sendRequest(SemanticTokensDeltaRequest.type, { textDocument: { uri }, previousResultId: full?.resultId ?? '' });
    expect(delta && 'edits' in delta).toBe(true);
    const data = [...(full?.data ?? [])];
    for (const edit of delta && 'edits' in delta ? [...delta.edits].sort((a, b) => b.start - a.start) : []) {
      data.splice(edit.start, edit.deleteCount, ...(edit.data ?? []));
    }
    expect(decode(data, changed).slice(-4)).toEqual(['4 +=operator', '4 $x=variable', '4 *=operator', '4 2=number']);
    const fresh = await connection.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
    expect(fresh?.data).toEqual(data);
    // A result the server no longer has: the whole tokens.
    const unknown = await connection.sendRequest(SemanticTokensDeltaRequest.type, { textDocument: { uri }, previousResultId: 'gone' });
    expect(unknown && 'data' in unknown ? unknown.data : undefined).toEqual(fresh?.data);

    const range = await connection.sendRequest(SemanticTokensRangeRequest.type, {
      textDocument: { uri },
      range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } },
    });
    expect(decode(range?.data ?? [], changed)).toEqual(['2 A=namespace.declaration']);

    const otherUri = 'file:///mod/assets/tokens.xml';
    await open(otherUri, '<macros>\n  <macro name="m" class="ship_s"/>\n</macros>\n');
    expect(await connection.sendRequest(SemanticTokensRequest.type, { textDocument: { uri: otherUri } })).toBeNull();
  });

  it('asks the client for the tokens again when the analyses change without an edit', async () => {
    const before = semanticTokensRefreshes;
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await vi.waitFor(() => expect(semanticTokensRefreshes).toBeGreaterThan(before));
  });
});

describe('texts', () => {
  const scriptUri = 'file:///mod/md/Texts.xml';
  const textUri = 'file:///mod/t/0001-l044.xml';
  const scriptLines = [
    '<mdscript name="T">',
    '  <cues>',
    '    <cue name="A">',
    '      <actions>',
    '        <debug_text text="{1001,1} + {1001,50}"/>',
    '      </actions>',
    '    </cue>',
    '  </cues>',
    '</mdscript>',
    '',
  ];
  const missing = `5:${scriptLines[4].indexOf('{1001,50}') + 1} text-undefined`;

  it('shows texts and reports the ones no file defines', async () => {
    expect(summarize(await open(scriptUri, scriptLines.join('\n')))).toEqual([missing]);
    const hover = await connection.sendRequest(HoverRequest.type, {
      textDocument: { uri: scriptUri },
      position: { line: 4, character: scriptLines[4].indexOf('{1001,1}') + 2 },
    });
    expect(hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '').toContain('Hull');
  });

  it('reads the workspace mod, and its neighbours when extensionsFolder is ..', async () => {
    const mods = path.join(workDir, 'mods');
    const mine = path.join(mods, 'mine');
    for (const [folder, page] of [
      [mine, 91000],
      [path.join(mods, 'other'), 91001],
    ] as const) {
      mkdirSync(path.join(folder, 't'), { recursive: true });
      writeFileSync(path.join(folder, 't', '0001-l044.xml'), `<language><page id="${page}"><t id="1">Text</t></page></language>`);
    }
    const workspace = { uri: pathToFileURL(mine).toString(), name: 'mine' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });

    const uri = pathToFileURL(path.join(mine, 'md', 'Mine.xml')).toString();
    const lines = [...scriptLines];
    lines[4] = lines[4].replace('{1001,1} + {1001,50}', '{91000,1} + {91001,1}');
    // The workspace is the mod: its own text resolves, the neighbour's does not.
    expect(summarize(await open(uri, lines.join('\n')))).toEqual([`5:${lines[4].indexOf('{91001,1}') + 1} text-undefined`]);

    clientSettings.extensionsFolder = '..';
    const withNeighbours = diagnosticsCount(uri, 0);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    expect(summarize(await withNeighbours)).toEqual([]);

    clientSettings.extensionsFolder = '';
    const restored = diagnosticsCount(uri, 1);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    expect(summarize(await restored)).toHaveLength(1);
    // Without the workspace folder neither text is found.
    const reanalysed = diagnosticsCount(uri, 2);
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
    await reanalysed;
    const closed = diagnosticsCount(uri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect((await closed).diagnostics).toEqual([]);
  });

  it('follows a text file while it is edited, and forgets unsaved texts on close', async () => {
    // One waiter at a time: the connection keeps a single handler per notification.
    const added = diagnosticsCount(scriptUri, 0);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: textUri,
        languageId: 'xml',
        version: 1,
        text: '<diff><add sel="/language"><page id="1001"><t id="50">Fifty</t></page></add></diff>',
      },
    });
    expect(summarize(await added)).toEqual([]);
    const removed = diagnosticsCount(scriptUri, 1);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: textUri } });
    expect(summarize(await removed)).toEqual([missing]);
  });
});

describe('Lua files', () => {
  const uri = 'file:///mod/ui/menu.lua';
  const lines = ['local PAGE_ID = 1001', 'local label = ReadText(PAGE_ID, 1)', 'function f(id) return ReadText(PAGE_ID, id) end', ''];

  async function hoverAt(line: number, character: number): Promise<{ value: string; range?: string } | null> {
    const hover = await connection.sendRequest(HoverRequest.type, { textDocument: { uri }, position: { line, character } });
    if (!hover) {
      return null;
    }
    const value = typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
    const range = hover.range && `${hover.range.start.line}:${hover.range.start.character}-${hover.range.end.line}:${hover.range.end.character}`;
    return { value, range };
  }

  it('shows the text of a ReadText call between its parentheses, and nothing else', async () => {
    // Diagnostics published until those of an XML document opened after the Lua one: none for the Lua one.
    const xmlUri = 'file:///mod/md/AfterLua.xml';
    const published: string[] = [];
    const xmlPublished = new Promise<void>((resolve) => {
      const disposable = connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
        published.push(params.uri);
        if (params.uri === xmlUri) {
          disposable.dispose();
          resolve();
        }
      });
    });
    await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'lua', version: 1, text: lines.join('\n') } });
    await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: xmlUri, languageId: 'xml', version: 1, text: mdText } });
    await xmlPublished;
    expect(published).not.toContain(uri);

    await statusWhere((status) => status.state === 'ready');
    const open = lines[1].indexOf('(');
    const hover = await hoverAt(1, open + 1);
    expect(hover?.value).toContain('Hull');
    expect(hover?.value).toContain('The page `PAGE_ID` is 1001, set on line 1.');
    expect(hover?.range).toBe(`1:${open}-1:${lines[1].indexOf(')') + 1}`);
    expect(await hoverAt(1, lines[1].indexOf('ReadText'))).toBeNull();
    expect((await hoverAt(2, lines[2].lastIndexOf('id)')))?.value).toContain('The id `id` is not known here: a parameter of a function.');

    const position = { line: 1, character: open + 1 };
    const completion = await connection.sendRequest(CompletionRequest.type, { textDocument: { uri }, position });
    expect(Array.isArray(completion) ? completion : completion?.items).toEqual([]);
    expect(await connection.sendRequest(DefinitionRequest.type, { textDocument: { uri }, position })).toEqual([]);
    expect(await connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri } })).toBeNull();
    expect(await connection.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } })).toBeNull();

    // An edit is seen at the next hover.
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 16 }, end: { line: 0, character: 20 } }, text: '1002' }],
    });
    expect((await hoverAt(1, open + 1))?.value).toContain('The page `PAGE_ID` is 1002, set on line 1.');
    for (const closed of [uri, xmlUri]) {
      await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: closed } });
    }
  });
});

describe('script index', () => {
  it('follows an interrupt library while it is edited in another document', async () => {
    const mod = path.join(workDir, 'ailib');
    const libraryFile = path.join(mod, 'aiscripts', 'lib.mine.xml');
    const orderFile = path.join(mod, 'aiscripts', 'order.mine.xml');
    const libraryText = (handler: string): string =>
      `<aiscript name="lib.mine">\n  <interrupts>\n    <library>\n      <handler name="${handler}"/>\n    </library>\n  </interrupts>\n  <attention min="unknown">\n    <actions/>\n  </attention>\n</aiscript>\n`;
    const orderText =
      '<aiscript name="order.mine">\n  <interrupts>\n    <handler ref="MineHandler"/>\n  </interrupts>\n  <attention min="unknown">\n    <actions/>\n  </attention>\n</aiscript>\n';
    mkdirSync(path.dirname(libraryFile), { recursive: true });
    writeFileSync(libraryFile, libraryText('MineHandler'));
    writeFileSync(orderFile, orderText);
    const workspace = { uri: pathToFileURL(mod).toString(), name: 'ailib' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });

    const orderUri = pathToFileURL(orderFile).toString();
    const libraryUri = pathToFileURL(libraryFile).toString();
    expect(summarize(await open(orderUri, orderText))).toEqual([]);

    // Renaming the handler in the editor makes the reference of the other script unknown, before saving.
    const renamed = diagnosticsCount(orderUri, 1);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: libraryUri, languageId: 'xml', version: 1, text: libraryText('MineHandler') },
    });
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: libraryUri, version: 2 },
      contentChanges: [{ text: libraryText('RenamedHandler') }],
    });
    expect(summarize(await renamed)).toEqual(['3:19 library-undefined']);

    // Closing without saving: the file on disk counts again.
    const restored = diagnosticsCount(orderUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: libraryUri } });
    expect(summarize(await restored)).toEqual([]);

    const removed = diagnosticsCount(orderUri, 0);
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
    await removed;
    const closed = diagnosticsCount(orderUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: orderUri } });
    await closed;
  });

  it('follows what a library of another script sets while it is edited, in the scripts that include it', async () => {
    const mod = path.join(workDir, 'mdlib');
    const libraryFile = path.join(mod, 'md', 'libscript.xml');
    const userFile = path.join(mod, 'md', 'user.xml');
    const libraryText = (sets: string): string =>
      `<mdscript name="LibScript">\n  <cues>\n    <library name="Lib">\n      <actions>\n        ${sets}\n      </actions>\n    </library>\n  </cues>\n</mdscript>\n`;
    const userText =
      '<mdscript name="User">\n  <cues>\n    <cue name="Use">\n      <actions>\n        <include_actions ref="md.LibScript.Lib"/>\n        <debug_text text="$first + $second"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    mkdirSync(path.dirname(libraryFile), { recursive: true });
    writeFileSync(libraryFile, libraryText('<set_value name="$first" exact="1"/>'));
    writeFileSync(userFile, userText);
    const workspace = { uri: pathToFileURL(mod).toString(), name: 'mdlib' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });

    const userUri = pathToFileURL(userFile).toString();
    const libraryUri = pathToFileURL(libraryFile).toString();
    // Read but never set, once the index of the new folder is built (one waiter at a time: `open` would replace it).
    const unset = diagnosticsCount(userUri, 1);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: userUri, languageId: 'xml', version: 1, text: userText } });
    expect(summarize(await unset)).toEqual(['6:36 variable-undefined']);

    // The library sets the variable in the editor: what it sets is no part of its signature, yet the including script follows.
    const set = diagnosticsCount(userUri, 0);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: libraryUri, languageId: 'xml', version: 1, text: libraryText('<set_value name="$first" exact="1"/>') },
    });
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: libraryUri, version: 2 },
      contentChanges: [{ text: libraryText('<set_value name="$first" exact="1"/>\n        <set_value name="$second" exact="2"/>') }],
    });
    await set;

    for (const uri of [libraryUri, userUri]) {
      const closed = diagnosticsCount(uri, 0);
      await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
      await closed;
    }
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  }, 20_000);

  it('renames a cue across the scripts of the workspace, and refuses when a script outside it names the cue', async () => {
    const mods = path.join(workDir, 'renamemods');
    const write = (file: string, lines: string[]): string => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${lines.join('\n')}\n`);
      return pathToFileURL(file).toString();
    };
    const apiUri = write(path.join(mods, 'mine', 'md', 'api.xml'), [
      '<mdscript name="Api">',
      '  <cues>',
      '    <cue name="Register"/>',
      '  </cues>',
      '</mdscript>',
    ]);
    const userLines = [
      '<mdscript name="User">',
      '  <cues>',
      '    <cue name="Use">',
      '      <actions>',
      '        <signal_cue_instantly cue="md.Api.Register"/>',
      '        <signal_cue_instantly cue="md.Api.Nowhere"/>',
      '        <signal_cue_instantly cue="md.Far.Base"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
    ];
    const userUri = write(path.join(mods, 'mine', 'md', 'user.xml'), userLines);
    write(path.join(mods, 'other', 'md', 'far.xml'), [
      '<mdscript name="Far">',
      '  <cues>',
      '    <cue name="Base">',
      '      <actions>',
      '        <cancel_cue cue="md.Api.Register"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
    ]);
    const workspace = { uri: pathToFileURL(path.join(mods, 'mine')).toString(), name: 'mine' };
    // Both md.Api.Nowhere and md.Far.Base are unknown once the workspace mod is indexed.
    const indexed = diagnosticsCount(userUri, 2);
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: userUri, languageId: 'xml', version: 1, text: userLines.join('\n') + '\n' },
    });
    await indexed;

    const position = { line: 4, character: userLines[4].indexOf('Register') + 2 };
    const locations = await connection.sendRequest(ReferencesRequest.type, { textDocument: { uri: userUri }, position, context: { includeDeclaration: true } });
    expect((locations ?? []).map((location) => `${path.basename(fileURLToPath(location.uri))}:${location.range.start.line}`).sort()).toEqual([
      'api.xml:2',
      'user.xml:4',
    ]);
    const edit = await connection.sendRequest(RenameRequest.type, { textDocument: { uri: userUri }, position, newName: 'Enrol' });
    const changes = Object.entries(edit?.changes ?? {}).map(
      ([uri, edits]) => `${path.basename(fileURLToPath(uri))}:${edits.map((change) => change.newText).join(',')}`
    );
    expect(changes.sort()).toEqual(['api.xml:Enrol', 'user.xml:Enrol']);
    expect(Object.keys(edit?.changes ?? {})).toContain(apiUri);

    // The neighbouring mod is read, not part of the workspace: its reference cannot be renamed.
    clientSettings.extensionsFolder = mods;
    const withNeighbour = diagnosticsCount(userUri, 1);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await withNeighbour;
    await expect(connection.sendRequest(PrepareRenameRequest.type, { textDocument: { uri: userUri }, position })).rejects.toMatchObject({
      message: 'cue Register of Api is also written in far.xml (other), outside the workspace',
    });

    clientSettings.extensionsFolder = '';
    const restored = diagnosticsCount(userUri, 2);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await restored;
    const closed = diagnosticsCount(userUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: userUri } });
    await closed;
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  });

  it('names the scripts and cues of the index for Go to Symbol in Workspace, and follows an open document', async () => {
    const mod = path.join(workDir, 'symbolmods', 'hubmod');
    const file = path.join(mod, 'md', 'hub.xml');
    const lines = ['<mdscript name="Hub">', '  <cues>', '    <cue name="HubStart"/>', '  </cues>', '</mdscript>'];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`);
    const uri = pathToFileURL(file).toString();
    const workspace = { uri: pathToFileURL(mod).toString(), name: 'hubmod' };
    const symbols = async (query: string): Promise<string[]> =>
      ((await connection.sendRequest(WorkspaceSymbolRequest.type, { query })) ?? []).map((symbol) => {
        const location = symbol.location as Location;
        return `${symbol.name} [${symbol.containerName}] ${path.basename(fileURLToPath(location.uri))}:${location.range.start.line}:${location.range.start.character}-${location.range.end.character}`;
      });
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    await vi.waitFor(async () => expect(await symbols('hub')).toEqual(['Hub [hubmod] hub.xml:0:16-19', 'HubStart [md.Hub (hubmod)] hub.xml:2:15-23']), {
      timeout: 10_000,
    });
    expect(await symbols('md.hub.hubst')).toEqual(['HubStart [md.Hub (hubmod)] hub.xml:2:15-23']);

    // While typing: the cue being written counts from the editor, before the file is saved.
    const typed = [...lines.slice(0, 3), '    <cue name="HubTyp', ...lines.slice(3)].join('\n');
    expect(summarize(await open(uri, typed))).toEqual(['4:15 unclosed-attribute', '4:5 unclosed-start-tag']);
    expect(await symbols('hubtyp')).toEqual(['HubTyp [md.Hub (hubmod)] hub.xml:3:15-21']);

    const closed = diagnosticsCount(uri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    await closed;
    expect(await symbols('hubtyp')).toEqual([]);
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  }, 30_000);

  it('indexes an extension created in the workspace while the server runs, and forgets one deleted', async () => {
    const mods = path.join(workDir, 'growingmods');
    const write = (file: string, text: string): string => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return pathToFileURL(file).toString();
    };
    write(path.join(mods, 'first', 'md', 'first.xml'), '<mdscript name="GrowFirst">\n  <cues/>\n</mdscript>\n');
    const names = async (query: string): Promise<string[]> =>
      ((await connection.sendRequest(WorkspaceSymbolRequest.type, { query })) ?? []).map((symbol) => symbol.name);
    const workspace = { uri: pathToFileURL(mods).toString(), name: 'growingmods' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    await vi.waitFor(async () => expect(await names('growfirst')).toEqual(['GrowFirst']), { timeout: 10_000 });

    // A mod copied in: its file in no folder the index reads yet.
    const fresh = write(path.join(mods, 'second', 'md', 'second.xml'), '<mdscript name="GrowSecond">\n  <cues/>\n</mdscript>\n');
    await connection.sendNotification(DidChangeWatchedFilesNotification.type, { changes: [{ uri: fresh, type: FileChangeType.Created }] });
    await vi.waitFor(async () => expect(await names('growsecond')).toEqual(['GrowSecond']), { timeout: 10_000 });

    // The mod's folder deleted at once: VS Code reports the folder alone, not the files in it.
    rmSync(path.join(mods, 'second'), { recursive: true });
    const folder = pathToFileURL(path.join(mods, 'second')).toString();
    await connection.sendNotification(DidChangeWatchedFilesNotification.type, { changes: [{ uri: folder, type: FileChangeType.Deleted }] });
    await vi.waitFor(async () => expect(await names('grow')).toEqual(['GrowFirst']), { timeout: 10_000 });
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  }, 30_000);

  it('helps with the parameters of a call: signature help, completion, hover and definition; and with the order it names', async () => {
    const mod = path.join(workDir, 'callmods', 'callmod');
    const orderFile = path.join(mod, 'aiscripts', 'order.patrol.xml');
    const orderLines = [
      '<aiscript name="order.patrol">',
      '  <order id="Patrol">',
      '    <params>',
      '      <param name="area" type="object" text="Where to patrol"/>',
      '      <param name="duration" type="time" default="1h"/>',
      '    </params>',
      '  </order>',
      '</aiscript>',
    ];
    mkdirSync(path.dirname(orderFile), { recursive: true });
    writeFileSync(orderFile, `${orderLines.join('\n')}\n`);
    const callerLines = [
      '<aiscript name="patrol.caller">',
      '  <attention min="unknown">',
      '    <actions>',
      '      <create_order object="this.ship" id="\'Patrol\'">',
      '        <param name="duration" value="2h"/>',
      '        <param name="" value="null"/>',
      '      </create_order>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
    ];
    const callerUri = pathToFileURL(path.join(mod, 'aiscripts', 'patrol.caller.xml')).toString();
    const workspace = { uri: pathToFileURL(mod).toString(), name: 'callmod' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    await vi.waitFor(
      async () =>
        expect((await connection.sendRequest(WorkspaceSymbolRequest.type, { query: 'order.patrol' }))?.map((symbol) => symbol.name)).toEqual(['order.patrol']),
      { timeout: 10_000 }
    );
    await open(callerUri, `${callerLines.join('\n')}\n`);

    const at = (line: number, part: string, into = 1): { textDocument: { uri: string }; position: { line: number; character: number } } => ({
      textDocument: { uri: callerUri },
      position: { line, character: callerLines[line].indexOf(part) + into },
    });
    const help = await connection.sendRequest(SignatureHelpRequest.type, at(4, 'value'));
    const signature = help?.signatures[0];
    const active = signature?.parameters?.[help?.activeParameter ?? 0]?.label as [number, number];
    expect(`${signature?.label} [${signature?.label.slice(active[0], active[1])}]`).toBe('Patrol(area, duration = 1h) [duration]');
    expect(signature?.parameters?.[1].documentation).toEqual({ kind: 'markdown', value: 'Default: `1h`\n\nType: `time`' });

    const completion = await connection.sendRequest(CompletionRequest.type, at(5, 'name=""', 6));
    expect((Array.isArray(completion) ? completion : (completion?.items ?? [])).map((item) => item.label)).toEqual(['area']);
    const hover = await connection.sendRequest(HoverRequest.type, at(4, 'duration'));
    expect((hover?.contents as { value: string }).value).toMatch(/^\*\*duration\*\* \*\(parameter of order `Patrol` of `order\.patrol`\)\*/);
    const places = (locations: Location[]): string[] =>
      locations.map((location) => `${path.basename(fileURLToPath(location.uri))}:${location.range.start.line}:${location.range.start.character}`);
    const definition = (await connection.sendRequest(DefinitionRequest.type, at(4, 'duration'))) as Location[];
    expect(places(definition)).toEqual(['order.patrol.xml:4:19']);

    // The order the call names, by its id.
    const id = at(3, "'Patrol'", 2);
    const order = await connection.sendRequest(HoverRequest.type, id);
    expect((order?.contents as { value: string }).value).toMatch(/^\*\*Patrol\*\* \*\(order of `order\.patrol`\)\*/);
    expect(places((await connection.sendRequest(DefinitionRequest.type, id)) as Location[])).toEqual(['order.patrol.xml:1:13']);
    const references = await connection.sendRequest(ReferencesRequest.type, { ...id, context: { includeDeclaration: true } });
    expect(places(references ?? [])).toEqual(['patrol.caller.xml:3:44', 'order.patrol.xml:1:13']);
    const ids = await connection.sendRequest(CompletionRequest.type, id);
    expect((Array.isArray(ids) ? ids : (ids?.items ?? [])).map((item) => item.label)).toContain('Patrol');

    const closed = diagnosticsCount(callerUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: callerUri } });
    await closed;
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  }, 30_000);

  it("follows the parameters of an order edited in another document: a caller's unknown parameter becomes known", async () => {
    const mod = path.join(workDir, 'parammods', 'parammod');
    const orderFile = path.join(mod, 'aiscripts', 'order.guard.xml');
    const orderText = (params: string): string =>
      `<aiscript name="order.guard">\n  <order id="Guard">\n    <params>\n${params}    </params>\n  </order>\n</aiscript>\n`;
    mkdirSync(path.dirname(orderFile), { recursive: true });
    writeFileSync(orderFile, orderText('      <param name="area"/>\n'));
    const callerLines = [
      '<aiscript name="guard.caller">',
      '  <attention min="unknown">',
      '    <actions>',
      '      <create_order object="this.ship" id="\'Guard\'">',
      '        <param name="duration" value="2h"/>',
      '      </create_order>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
    ];
    const callerUri = pathToFileURL(path.join(mod, 'aiscripts', 'guard.caller.xml')).toString();
    const orderUri = pathToFileURL(orderFile).toString();
    const workspace = { uri: pathToFileURL(mod).toString(), name: 'parammod' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    // Once indexed, the order is found and its parameter checked; the fixture schemas do not know `create_order`.
    const unknown = nextDiagnostics(callerUri, (params) => params.diagnostics.some((diagnostic) => diagnostic.code === 'param-unknown'));
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: callerUri, languageId: 'xml', version: 1, text: `${callerLines.join('\n')}\n` },
    });
    expect(summarize(await unknown)).toContain('5:22 param-unknown');

    // The parameter declared in the editor, before saving: the caller is checked again.
    const known = nextDiagnostics(callerUri, (params) => !params.diagnostics.some((diagnostic) => diagnostic.code === 'param-unknown'));
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: orderUri, languageId: 'xml', version: 1, text: orderText('      <param name="area"/>\n') },
    });
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: orderUri, version: 2 },
      contentChanges: [{ text: orderText('      <param name="area"/>\n      <param name="duration"/>\n') }],
    });
    await known;

    for (const uri of [orderUri, callerUri]) {
      await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    }
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  }, 30_000);

  it('creates a cue in the script that md.Script.Cue names, in that file as the editor named it', async () => {
    const mod = path.join(workDir, 'createmods', 'createmod');
    const calleeFile = path.join(mod, 'md', 'callee.xml');
    const calleeText = '<mdscript name="Callee">\n  <cues>\n    <cue name="Start"/>\n  </cues>\n</mdscript>\n';
    mkdirSync(path.dirname(calleeFile), { recursive: true });
    writeFileSync(calleeFile, calleeText);
    const callerUri = pathToFileURL(path.join(mod, 'md', 'caller.xml')).toString();
    const callerText =
      '<mdscript name="Caller">\n  <cues>\n    <cue name="A">\n      <actions>\n        <signal_cue_instantly cue="md.Callee.Later"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    const workspace = { uri: pathToFileURL(mod).toString(), name: 'createmod' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    const reported = nextDiagnostics(callerUri, (params) => params.diagnostics.some((diagnostic) => diagnostic.code === 'cue-undefined'));
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: callerUri, languageId: 'xml', version: 1, text: callerText },
    });
    const diagnostic = (await reported).diagnostics.find((candidate) => candidate.code === 'cue-undefined')!;
    expect(diagnostic.message).toBe("Script 'Callee' has no cue 'Later'");
    const request = { textDocument: { uri: callerUri }, range: diagnostic.range, context: { diagnostics: [diagnostic] } };
    const created = async (): Promise<Record<string, string[]>> => {
      const actions = (await connection.sendRequest(CodeActionRequest.type, request)) as CodeAction[];
      const action = actions.find((candidate) => candidate.title === "Create cue 'Later' in script 'Callee'");
      return Object.fromEntries(
        Object.entries(action?.edit?.changes ?? {}).map(([uri, edits]) => [uri, edits.map((edit) => `${edit.range.start.line}: ${edit.newText}`)])
      );
    };
    const edit = [
      '2: \n    <cue name="Later">\n      <conditions>\n        <event_cue_signalled/>\n      </conditions>\n      <actions>\n      </actions>\n    </cue>',
    ];
    // A closed file: its file uri.
    expect(await created()).toEqual({ [pathToFileURL(calleeFile).toString()]: edit });
    // Open in the editor under the uri VS Code writes (`c%3A`): that uri.
    const editorUri = pathToFileURL(calleeFile)
      .toString()
      .replace(/^file:\/\/\/([A-Za-z]):/, (_, drive: string) => `file:///${drive.toLowerCase()}%3A`);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: editorUri, languageId: 'xml', version: 1, text: calleeText },
    });
    expect(await created()).toEqual({ [editorUri]: edit });

    for (const uri of [editorUri, callerUri]) {
      await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    }
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  }, 30_000);
});

describe('problems of the workspace', () => {
  it('checks the files of the editor tabs that the editor has not loaded, from the disk, until their tab closes', async () => {
    const file = path.join(workDir, 'tabmod', 'md', 'tabbed.xml');
    const lines = ['<mdscript name="Tabbed">', '  <cues>', '    <cue name="A>', '    </cue>', '  </cues>', '</mdscript>'];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`);
    const uri = pathToFileURL(file).toString();
    const tabs = (uris: string[]): Promise<void> => connection.sendNotification(EditorTabsNotificationMethod, { uris });

    // A tab restored at start, not shown: its problems come from the disk, without a version.
    const restored = nextDiagnostics(uri);
    await tabs([uri, 'file:///nowhere/md/missing.xml']);
    expect(summarize(await restored)).toEqual(['3:15 unclosed-attribute']);
    expect((await restored).version).toBeUndefined();

    // Shown: the editor's text counts; closed with its tab still there: the disk again.
    const fixed = diagnosticsCount(uri, 0);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'xml', version: 1, text: `${lines.join('\n')}\n`.replace('"A>', '"A">') },
    });
    expect((await fixed).version).toBe(1);
    const fromDisk = diagnosticsCount(uri, 1);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect((await fromDisk).version).toBeUndefined();

    // Its tab closed.
    const cleared = diagnosticsCount(uri, 0);
    await tabs([]);
    await cleared;
  });

  it('checks the closed scripts of the workspace when asked to, follows what they refer to, and clears them when no longer asked', async () => {
    // A workspace of three extensions: one with scripts, and one that patches another's script.
    const root = path.join(workDir, 'wsproblems');
    const write = (relative: string, lines: string[]): { file: string; uri: string; text: string } => {
      const file = path.join(root, relative);
      const text = `${lines.join('\n')}\n`;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return { file, uri: pathToFileURL(file).toString(), text };
    };
    const order = write('wsmod/aiscripts/order.patrol.xml', ['<aiscript name="order.patrol">', '  <order id="Patrol"/>', '</aiscript>']);
    const callerLines = (id: string): string[] => [
      '<aiscript name="patrol.caller">',
      '  <attention min="unknown">',
      '    <actions>',
      `      <create_order object="this.ship" id="'${id}'"/>`,
      '    </actions>',
      '  </attention>',
      '</aiscript>',
    ];
    const caller = write('wsmod/aiscripts/patrol.caller.xml', callerLines('Patrl'));
    const broken = write('wsmod/md/broken.xml', ['<mdscript name="Broken">', '  <cues>', '    <cue name="A>', '    </cue>', '  </cues>', '</mdscript>']);
    const clean = write('wsmod/aiscripts/clean.xml', [
      '<aiscript name="clean">',
      '  <attention min="unknown">',
      '    <actions/>',
      '  </attention>',
      '</aiscript>',
    ]);
    const target = write('wsbase/md/wsapi.xml', [
      '<mdscript name="WsApi">',
      '  <cues>',
      '    <cue name="Register">',
      '      <actions/>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
    ]);
    write('wspatcher/content.xml', ['<content id="wspatcher" name="Patcher" version="100"/>']);
    const patch = write('wspatcher/extensions/wsbase/md/wsapi.xml', [
      '<diff>',
      `  <add sel="//cue[@name='Register']/actions">`,
      '    <debug_text text="1"/>',
      '  </add>',
      '</diff>',
    ]);
    // A merge file in one extension's libraries, and a patch in another's of what it adds.
    const merge = write('wsbase/libraries/wares.xml', ['<wares>', '  <ware id="wsware"/>', '</wares>']);
    const libraryPatch = write('wspatcher/libraries/wares.xml', [
      '<diff>',
      `  <add sel="/wares/ware[@id='wsware']" type="@volume">1</add>`,
      `  <remove sel="/wares/ware[@id='gone']" silent="true"/>`,
      '</diff>',
    ]);
    const workspace = { uri: pathToFileURL(root).toString(), name: 'wsproblems' };
    // The tests after this one see neither the folder nor the mode, also when it fails.
    onTestFinished(async () => {
      if (clientSettings.diagnosticMode !== 'openFilesOnly') {
        clientSettings.diagnosticMode = 'openFilesOnly';
        await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
      }
      await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
    });

    // Checked once the index with the workspace folder is built; a file without problems gets nothing.
    // The connection has one handler per method: one takes them all.
    const published = new Map<string, PublishDiagnosticsParams[]>();
    const collecting = connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      published.set(params.uri, [...(published.get(params.uri) ?? []), params]);
    });
    clientSettings.diagnosticMode = 'workspace';
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    await vi.waitFor(() => expect(published.has(broken.uri) && published.has(caller.uri) && published.has(libraryPatch.uri)).toBe(true), {
      timeout: 10_000,
    });
    collecting.dispose();
    // The fixture schemas do not know `create_order`.
    const unknownOrder = ['4:8 unknown-element', '4:45 order-undefined'];
    expect(published.get(caller.uri)?.map(summarize)).toEqual([unknownOrder]);
    expect(published.get(broken.uri)?.map(summarize)).toEqual([['3:15 unclosed-attribute']]);
    expect(published.get(caller.uri)?.[0].version).toBeUndefined();
    expect(published.has(clean.uri)).toBe(false);
    expect(published.has(patch.uri)).toBe(false);
    // The library patch after the merge file: only its silent removal of a ware nobody adds.
    expect(published.get(libraryPatch.uri)?.map(summarize)).toEqual([['3:22 patch-no-match']]);
    expect(published.has(merge.uri)).toBe(false);

    // Open, its problems follow the editor; closed without saving, they are the file's on disk again.
    expect(summarize(await open(caller.uri, caller.text))).toEqual(unknownOrder);
    const edited = diagnosticsCount(caller.uri, 1);
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: caller.uri, version: 2 },
      contentChanges: [{ text: `${callerLines('Patrol').join('\n')}\n` }],
    });
    await edited;
    const reverted = diagnosticsCount(caller.uri, 2);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: caller.uri } });
    expect((await reverted).version).toBeUndefined();

    // The order renamed in the editor: the closed caller is checked again once typing pauses.
    await open(order.uri, order.text);
    const renamed = diagnosticsCount(caller.uri, 1);
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: order.uri, version: 2 },
      contentChanges: [{ text: order.text.replace('"Patrol"', '"Patrl"') }],
    });
    await renamed;
    const back = diagnosticsCount(caller.uri, 2);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: order.uri } });
    await back;

    // What a patch selects removed from its target in the editor, no name changed: the closed patch is checked again.
    await open(target.uri, target.text);
    const unmatched = diagnosticsCount(patch.uri, 1);
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: target.uri, version: 2 },
      contentChanges: [{ text: target.text.replace('      <actions/>\n', '') }],
    });
    // On the step of the path that selects nothing.
    expect(summarize(await unmatched)).toEqual(['2:36 patch-no-match']);
    const matched = diagnosticsCount(patch.uri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: target.uri } });
    await matched;

    // The ware renamed in the merge file in the editor: the closed library patch is checked again.
    await open(merge.uri, merge.text);
    const unmerged = diagnosticsCount(libraryPatch.uri, 2);
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: merge.uri, version: 2 },
      contentChanges: [{ text: merge.text.replace('wsware', 'other') }],
    });
    expect(summarize(await unmerged)).toEqual(['2:19 patch-no-match', '3:22 patch-no-match']);
    const merged = diagnosticsCount(libraryPatch.uri, 1);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: merge.uri } });
    await merged;

    // Changed on disk.
    const fixedOnDisk = diagnosticsCount(caller.uri, 1);
    writeFileSync(caller.file, `${callerLines('Patrol').join('\n')}\n`);
    await connection.sendNotification(DidChangeWatchedFilesNotification.type, { changes: [{ uri: caller.uri, type: FileChangeType.Changed }] });
    await fixedOnDisk;

    // A folder deleted on disk, as by a checkout: VS Code reports the folder alone, and its scripts' problems go.
    const deleted = diagnosticsCount(broken.uri, 0);
    rmSync(path.dirname(broken.file), { recursive: true });
    await connection.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: pathToFileURL(path.dirname(broken.file)).toString(), type: FileChangeType.Deleted }],
    });
    await deleted;

    // Only the open files again: the closed ones' problems are cleared.
    clientSettings.diagnosticMode = 'openFilesOnly';
    const cleared = diagnosticsCount(caller.uri, 0);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await cleared;
  }, 30_000);
});

describe('patches', () => {
  it("checks a patch against the file it changes, and follows that file's edits", async () => {
    const mods = path.join(workDir, 'patchmods');
    const write = (file: string, text: string): string => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return pathToFileURL(file).toString();
    };
    const apiText = '<mdscript name="Api">\n  <cues>\n    <cue name="Register"/>\n  </cues>\n</mdscript>\n';
    const apiUri = write(path.join(mods, 'base', 'md', 'api.xml'), apiText);
    write(path.join(mods, 'patcher', 'content.xml'), '<content id="patcher" name="Patcher" version="100"/>\n');
    const patchText = `<diff>\n  <add sel="//cue[@name='Register']" type="@instantiate">true</add>\n</diff>\n`;
    const patchUri = write(path.join(mods, 'patcher', 'extensions', 'base', 'md', 'api.xml'), patchText);
    const workspace = { uri: pathToFileURL(mods).toString(), name: 'patchmods' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    expect(summarize(await open(patchUri, patchText))).toEqual([]);
    expect((await statusWhere((status) => status.state === 'ready' && status.extensions.includes('patcher'))).extensions).toEqual(['base', 'patcher']);

    // What the status bar tells of a patch, and the comparison of its target before and after it.
    expect((await documentInfo(patchUri)).patchTarget).toEqual({
      name: 'extensions/base/md/api.xml',
      file: fileURLToPath(apiUri),
      uri: apiUri,
      source: 'base',
      earlier: [],
      merged: [],
    });
    const compared = await connection.sendRequest<PatchComparisonResult>(PatchComparisonRequestMethod, { uri: patchUri });
    const after = apiText.replace('<cue name="Register"/>', '<cue name="Register" instantiate="true"/>');
    // The value is the patch's own text: typing there goes into the patch, at the version compared.
    expect(compared).toEqual({
      name: 'extensions/base/md/api.xml',
      file: fileURLToPath(apiUri),
      before: apiText,
      after,
      own: [{ start: after.indexOf('true'), end: after.indexOf('true') + 4, patchStart: patchText.indexOf('true') }],
      version: 1,
    });
    expect(await connection.sendRequest<PatchComparisonResult>(PatchComparisonRequestMethod, { uri: 'file:///mod/md/Sample.xml' })).toBeNull();

    // The side edited: a cue added after Register becomes an operation, from the version compared only.
    const edited = after.replace('<cue name="Register" instantiate="true"/>', '<cue name="Register" instantiate="true"/>\n    <cue name="Mine"/>');
    const written = await connection.sendRequest<PatchWriteResult>(PatchWriteRequestMethod, { uri: patchUri, version: 1, edited });
    expect(written.refused).toEqual([]);
    expect(written.changes.map((change) => `${change.line} ${change.kind}: ${change.label}`)).toEqual(['3 operation: <cue> added']);
    expect(written.edits).toEqual([
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
        newText: `  <add sel="/mdscript/cues/cue[@name='Register']" pos="after">\n    <cue name="Mine"/>\n  </add>\n`,
      },
    ]);
    const stale = await connection.sendRequest<PatchWriteResult>(PatchWriteRequestMethod, { uri: patchUri, version: 0, edited });
    expect(stale).toEqual({
      edits: [],
      changes: [],
      refused: [{ line: 0, reason: 'The patch changed since this side was last in step with it: revert the side and make the change again' }],
    });

    // Renaming the cue in the editor leaves the patch's path without a match, before saving.
    const unmatched = diagnosticsCount(patchUri, 1);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: apiUri, languageId: 'xml', version: 1, text: apiText } });
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: apiUri, version: 2 },
      contentChanges: [{ text: apiText.replace('Register', 'Enrol') }],
    });
    expect(summarize(await unmatched)).toEqual(['2:13 patch-no-match']);

    // Closing without saving: the file on disk counts again.
    const matched = diagnosticsCount(patchUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: apiUri } });
    await matched;
    const closed = diagnosticsCount(patchUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: patchUri } });
    await closed;
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  });

  it('checks what a patch brings in where it lands, with the variables of the edited target', async () => {
    const mods = path.join(workDir, 'contentmods');
    const write = (file: string, text: string): string => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return pathToFileURL(file).toString();
    };
    const apiText =
      '<mdscript name="Api">\n  <cues>\n    <cue name="Register">\n      <actions>\n        <set_value name="$a" exact="1"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    const apiUri = write(path.join(mods, 'base', 'md', 'api.xml'), apiText);
    write(path.join(mods, 'patcher', 'content.xml'), '<content id="patcher" name="Patcher" version="100"/>\n');
    const patchText = `<diff>\n  <add sel="//cue[@name='Register']/actions">\n    <set_value name="$b" exact="$a + 1"/>\n  </add>\n</diff>\n`;
    const patchUri = write(path.join(mods, 'patcher', 'extensions', 'base', 'md', 'api.xml'), patchText);
    const workspace = { uri: pathToFileURL(mods).toString(), name: 'contentmods' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    expect(summarize(await open(patchUri, patchText))).toEqual([]);

    // The target's cue no longer sets `$a` in the editor: the patch's read of it is unset.
    const unset = diagnosticsCount(patchUri, 1);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: apiUri, languageId: 'xml', version: 1, text: apiText } });
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: apiUri, version: 2 },
      contentChanges: [{ text: apiText.replace('$a', '$z') }],
    });
    expect(summarize(await unset)).toEqual(['3:33 variable-undefined']);

    const restored = diagnosticsCount(patchUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: apiUri } });
    await restored;
    const closed = diagnosticsCount(patchUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: patchUri } });
    await closed;
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  });

  it('answers in a patch as it lands in its target, and renames a cue through its path', async () => {
    const mods = path.join(workDir, 'featuremods');
    const write = (file: string, text: string): string => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return pathToFileURL(file).toString();
    };
    const apiText =
      '<mdscript name="Api">\n  <cues>\n    <cue name="Register">\n      <actions>\n        <set_value name="$a" exact="1"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    write(path.join(mods, 'base', 'md', 'api.xml'), apiText);
    write(path.join(mods, 'patcher', 'content.xml'), '<content id="patcher" name="Patcher" version="100"/>\n');
    const patchLines = ['<diff>', `  <add sel="//cue[@name='Register']/actions">`, '    <set_value name="$b" exact="$a + 1"/>', '  </add>', '</diff>'];
    const patchUri = write(path.join(mods, 'patcher', 'extensions', 'base', 'md', 'api.xml'), `${patchLines.join('\n')}\n`);
    const workspace = { uri: pathToFileURL(mods).toString(), name: 'featuremods' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    expect(summarize(await open(patchUri, `${patchLines.join('\n')}\n`))).toEqual([]);
    const request = { textDocument: { uri: patchUri }, position: { line: 2, character: patchLines[2].indexOf('$a') + 1 } };

    // `$a` of the target's cue, as the patched target has it.
    const hover = await connection.sendRequest(HoverRequest.type, request);
    expect(JSON.stringify(hover?.contents)).toContain('at line 5 of api.xml');
    const definitions = (await connection.sendRequest(DefinitionRequest.type, request)) as Location[];
    expect(definitions.map((location) => `${path.basename(fileURLToPath(location.uri))}:${location.range.start.line}`)).toEqual(['api.xml:4']);

    // The cue names of the target in the path, and a rename that edits the path with the cue.
    const inPath = { textDocument: { uri: patchUri }, position: { line: 1, character: patchLines[1].indexOf('Register') } };
    const completions = await connection.sendRequest(CompletionRequest.type, inPath);
    const items = Array.isArray(completions) ? completions : (completions?.items ?? []);
    expect(items.map((item) => item.label)).toEqual(['Register']);
    const edit = await connection.sendRequest(RenameRequest.type, { ...inPath, newName: 'Enrol' });
    const changes = Object.entries(edit?.changes ?? {}).map(
      ([uri, edits]) => `${path.relative(mods, fileURLToPath(uri))}:${edits.map((change) => change.range.start.line).join(',')}`
    );
    expect(changes.sort()).toEqual([path.join('base', 'md', 'api.xml:2'), path.join('patcher', 'extensions', 'base', 'md', 'api.xml:1')]);

    const closed = diagnosticsCount(patchUri, 0);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: patchUri } });
    await closed;
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  });

  it('gives both sides of a patch comparison the features of the script, and the side with the patch its new problems', async () => {
    const mods = path.join(workDir, 'sidemods');
    const write = (file: string, text: string): string => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return pathToFileURL(file).toString();
    };
    // The target has a problem of its own, the patch brings in another.
    const apiText =
      '<mdscript name="Api">\n  <cues>\n    <cue name="Register">\n      <actions>\n        <set_value name="$a" exact="1 +"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    write(path.join(mods, 'base', 'md', 'api.xml'), apiText);
    write(path.join(mods, 'patcher', 'content.xml'), '<content id="patcher" name="Patcher" version="100"/>\n');
    const patchText = `<diff>\n  <add sel="//cue[@name='Register']/actions">\n    <set_value name="$b" exact="$a"/>\n    <set_value name="$s" exact="player.ship"/>\n    <set_value name="$c" exact="2 *"/>\n  </add>\n</diff>\n`;
    const patchUri = write(path.join(mods, 'patcher', 'extensions', 'base', 'md', 'api.xml'), patchText);
    const workspace = { uri: pathToFileURL(mods).toString(), name: 'sidemods' };
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    await statusWhere((status) => status.state === 'ready' && status.extensions.includes('patcher'));
    expect(summarize(await open(patchUri, patchText))).toEqual(['5:36 expression-syntax']);
    const compared = await connection.sendRequest<PatchComparisonResult>(PatchComparisonRequestMethod, { uri: patchUri });
    const before = compared?.before ?? '';
    const after = compared?.after ?? '';
    const afterLines = after.split('\n');
    expect(afterLines.slice(4, 8).map((line) => line.trim())).toEqual([
      '<set_value name="$a" exact="1 +"/>',
      '<set_value name="$b" exact="$a"/>',
      '<set_value name="$s" exact="player.ship"/>',
      '<set_value name="$c" exact="2 *"/>',
    ]);

    // The sides as VS Code sends them: the patch's uri in the query, which is encoded once more.
    const query = encodeURIComponent(new URLSearchParams({ patch: patchUri }).toString());
    const beforeUri = `${patchBeforeScheme}:/before/extensions/base/md/api.xml?${query}`;
    const afterUri = `${patchAfterScheme}:/extensions/base/md/api.xml?${query}`;
    expect(summarize(await open(beforeUri, before))).toEqual([]);
    const lineOf = (params: PublishDiagnosticsParams): string[] =>
      params.diagnostics.map((diagnostic) => `${diagnostic.range.start.line + 1} ${diagnostic.code}`);
    expect(lineOf(await open(afterUri, after))).toEqual(['8 expression-syntax']);

    // The features of the script, the side's own places under its uri.
    const inAfter = (line: number, needle: string, delta = 1): { textDocument: { uri: string }; position: { line: number; character: number } } => ({
      textDocument: { uri: afterUri },
      position: { line, character: afterLines[line].indexOf(needle) + delta },
    });
    const hover = await connection.sendRequest(HoverRequest.type, inAfter(6, 'player', 2));
    expect(hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '').toContain('**player** *(keyword)*');
    const definitions = (await connection.sendRequest(DefinitionRequest.type, inAfter(5, '$a'))) as Location[];
    expect(definitions.map((location) => `${location.uri === afterUri ? 'side' : location.uri}:${location.range.start.line}`)).toEqual(['side:4']);
    const completions = await connection.sendRequest(CompletionRequest.type, inAfter(6, 'player.', 'player.'.length));
    const labels = Array.isArray(completions) ? completions.map((item) => item.label) : (completions?.items.map((item) => item.label) ?? []);
    expect(labels).toContain('ship');
    const tokens = await connection.sendRequest(SemanticTokensRequest.type, { textDocument: { uri: beforeUri } });
    expect(tokens?.data.length).toBeGreaterThan(0);
    await expect(connection.sendRequest(PrepareRenameRequest.type, inAfter(5, '$a'))).rejects.toThrow(
      'Rename in the patch or in the script, not in a side of their comparison'
    );

    // A misspelt element in the side: its quick fix edits the side. The side before the patch is read only.
    const misspelt = nextDiagnostics(afterUri, (params) => params.diagnostics.some((diagnostic) => diagnostic.code === 'unknown-element'));
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: afterUri, version: 2 },
      contentChanges: [{ text: after.replace('<set_value name="$s"', '<set_valeu name="$s"') }],
    });
    const unknown = (await misspelt).diagnostics.find((diagnostic) => diagnostic.code === 'unknown-element');
    const fixRequest = { textDocument: { uri: afterUri }, range: unknown!.range, context: { diagnostics: [unknown!] } };
    const fixes = (await connection.sendRequest(CodeActionRequest.type, fixRequest)) as CodeAction[];
    expect(fixes.map((fix) => Object.keys(fix.edit?.changes ?? {}))).toEqual([[afterUri]]);
    expect(await connection.sendRequest(CodeActionRequest.type, { ...fixRequest, textDocument: { uri: beforeUri } })).toEqual([]);
    const restored = nextDiagnostics(afterUri, (params) => params.diagnostics.every((diagnostic) => diagnostic.code !== 'unknown-element'));
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: afterUri, version: 3 },
      contentChanges: [{ text: after }],
    });
    await restored;

    // Typing half a tag in the side: its well-formedness problem shows there, and hover still answers.
    const typed = nextDiagnostics(afterUri);
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: afterUri, version: 4 },
      contentChanges: [{ range: { start: { line: 7, character: 0 }, end: { line: 7, character: 0 } }, text: '        <set_value name="$d\n' }],
    });
    const typedHover = await connection.sendRequest(HoverRequest.type, inAfter(6, 'player', 2));
    expect(typedHover && typeof typedHover.contents === 'object' && 'value' in typedHover.contents ? typedHover.contents.value : '').toContain('**player**');
    expect(lineOf(await typed)).toEqual(['8 unclosed-attribute', '8 unclosed-start-tag', '9 expression-syntax']);

    for (const uri of [beforeUri, afterUri, patchUri]) {
      const closed = diagnosticsCount(uri, 0);
      await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
      await closed;
    }
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
  });
});

describe('an installed game read in place', () => {
  it('reads the game from its catalogs when only gameFolder is set, and gives its files as read-only game documents', async () => {
    // The install: the fixture's libraries and texts and a game script in its catalogs, a DLC whose patch changes the script.
    const install = path.join(workDir, 'install');
    const filesOf = (folder: string, prefix: string): CatalogFile[] =>
      readdirSync(folder).map((name) => ({ path: `${prefix}/${name}`, data: readFileSync(path.join(folder, name)) }));
    // A misspelt attribute: the game's script has a problem with a quick fix.
    const setupLines = ['<mdscript name="Setup">', '  <cues>', '    <cue name="Start" instantiat="true"/>', '  </cues>', '</mdscript>'];
    const setupText = `${setupLines.join('\n')}\n`;
    mkdirSync(install, { recursive: true });
    writeCatalog(path.join(install, '01.cat'), [
      ...filesOf(path.join(unpacked, 'libraries'), 'libraries'),
      ...filesOf(path.join(unpacked, 't'), 't'),
      { path: 'md/setup.xml', data: setupText },
    ]);
    writeFileSync(path.join(install, 'version.dat'), '900\r\n');
    const dlc = path.join(install, 'extensions', 'ego_dlc_test');
    mkdirSync(dlc, { recursive: true });
    writeFileSync(path.join(dlc, 'content.xml'), '<content id="ego_dlc_test" name="Test DLC" version="100"/>\n');
    const dlcPatchText = `<diff>\n  <add sel="/mdscript/cues/cue[@name='Start']" type="@namespace">this</add>\n</diff>\n`;
    // And a merge file, whose ware goes into the game's wares.
    writeCatalog(path.join(dlc, 'ext_01.cat'), [
      { path: 'md/setup.xml', data: dlcPatchText },
      { path: 'libraries/wares.xml', data: '<wares>\n  <ware id="dlcware"/>\n</wares>\n' },
    ]);
    // The workspace: a mod naming the game's cue, and patching the game's script.
    const mods = path.join(workDir, 'installmods');
    const write = (file: string, text: string): string => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return pathToFileURL(file).toString();
    };
    write(path.join(mods, 'mine', 'content.xml'), '<content id="mine" name="Mine" version="100"/>\n');
    const mineLines = [
      '<mdscript name="Mine">',
      '  <cues>',
      '    <cue name="Own">',
      '      <actions>',
      '        <signal_cue_instantly cue="md.Setup.Start"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
    ];
    const mineText = `${mineLines.join('\n')}\n`;
    const mineUri = write(path.join(mods, 'mine', 'md', 'mine.xml'), mineText);
    const minePatchText = '<diff>\n  <add sel="/mdscript/cues"><cue name="Mine"/></add>\n</diff>\n';
    const minePatchUri = write(path.join(mods, 'mine', 'md', 'setup.xml'), minePatchText);
    // And a patch of the game's wares, of the ware the DLC's merge file adds.
    const mineWaresLines = ['<diff>', `  <add sel="/wares/ware[@id='dlcware']" type="@volume">1</add>`, '</diff>'];
    const mineWaresText = `${mineWaresLines.join('\n')}\n`;
    const mineWaresUri = write(path.join(mods, 'mine', 'libraries', 'wares.xml'), mineWaresText);
    const workspace = { uri: pathToFileURL(mods).toString(), name: 'installmods' };

    clientSettings.unpackedFileLocation = '';
    clientSettings.gameFolder = install;
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [workspace], removed: [] } });
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    const ready = await statusWhere((status) => status.state === 'ready' && status.gameSource === 'installed' && status.extensions.includes('mine'));
    expect(ready).toMatchObject({
      gameFolder: install,
      gameSource: 'installed',
      gameVersion: '900',
      schemas: ['aiscripts', 'diff', 'md'],
      properties: true,
      textFiles: 2,
      dlcs: ['ego_dlc_test'],
      extensions: ['mine'],
      problems: loadGameData(unpacked).problems.length,
    });

    // From the workspace into the game: its script and its schema, as game documents.
    const gameSetup = 'x4codesense-game:/md/setup.xml';
    const at = (
      uri: string,
      lines: string[],
      line: number,
      needle: string
    ): { textDocument: { uri: string }; position: { line: number; character: number } } => ({
      textDocument: { uri },
      position: { line, character: lines[line].indexOf(needle) + 1 },
    });
    const places = (locations: Location[] | null): string[] => (locations ?? []).map((location) => `${location.uri}:${location.range.start.line}`).sort();
    expect(summarize(await open(mineUri, mineText))).toEqual([]);
    expect(places((await connection.sendRequest(DefinitionRequest.type, at(mineUri, mineLines, 4, 'Start'))) as Location[])).toEqual([`${gameSetup}:2`]);
    const inSchema = (await connection.sendRequest(DefinitionRequest.type, at(mineUri, mineLines, 4, 'signal_cue_instantly'))) as Location[];
    expect(inSchema.map((location) => location.uri)).toEqual(['x4codesense-game:/libraries/md.xsd']);
    const symbols = (await connection.sendRequest(WorkspaceSymbolRequest.type, { query: 'md.Setup.Start' })) ?? [];
    expect(symbols.map((symbol) => `${symbol.name} ${(symbol.location as Location).uri}`)).toEqual([`Start ${gameSetup}`]);
    // A patch of the game's script: the file it changes, as the client opens it.
    expect(summarize(await open(minePatchUri, minePatchText))).toEqual([]);
    expect((await documentInfo(minePatchUri)).patchTarget).toEqual({
      name: 'md/setup.xml',
      file: path.join(install, 'md', 'setup.xml'),
      uri: gameSetup,
      source: 'game',
      earlier: [path.join(dlc, 'md', 'setup.xml')],
      merged: [],
    });
    // A patch of a library file: after the DLC's merge file, whose ware it finds there.
    expect(summarize(await open(mineWaresUri, mineWaresText))).toEqual([]);
    const dlcWares = path.join(dlc, 'libraries', 'wares.xml');
    expect((await documentInfo(mineWaresUri)).patchTarget).toEqual({
      name: 'libraries/wares.xml',
      file: path.join(install, 'libraries', 'wares.xml'),
      uri: 'x4codesense-game:/libraries/wares.xml',
      source: 'game',
      earlier: [dlcWares],
      merged: [dlcWares],
    });
    const intoMerge = (await connection.sendRequest(DefinitionRequest.type, at(mineWaresUri, mineWaresLines, 1, 'dlcware'))) as Location[];
    expect(intoMerge.map((location) => `${location.uri}:${location.range.start.line}`)).toEqual([
      'x4codesense-game:/extensions/ego_dlc_test/libraries/wares.xml:1',
    ]);

    // The text of a game document, from the catalogs; none for a file the game does not have, nor for another uri.
    const gameFile = (uri: string): Promise<GameFileResult> => connection.sendRequest<GameFileResult>(GameFileRequestMethod, { uri });
    expect(await gameFile(gameSetup)).toEqual({ text: setupText });
    expect(await gameFile('x4codesense-game:/md/nothing.xml')).toBeNull();
    expect(await gameFile(mineUri)).toBeNull();

    // Opened, it is the game's script, with its problems and the places of the workspace and the DLC that name its cue.
    const opened = await open(gameSetup, setupText);
    expect(summarize(opened)).toEqual(['3:23 unknown-attribute']);
    expect((await documentInfo(gameSetup)).metadata).toMatchObject({ schema: 'md', name: 'Setup' });
    const dlcPatch = 'x4codesense-game:/extensions/ego_dlc_test/md/setup.xml';
    const references = await connection.sendRequest(ReferencesRequest.type, {
      ...at(gameSetup, setupLines, 2, 'Start'),
      context: { includeDeclaration: true },
    });
    expect(places(references)).toEqual([`${mineUri}:4`, `${dlcPatch}:1`, `${gameSetup}:2`]);
    // Read only: no rename in it, no quick fixes.
    await expect(connection.sendRequest(PrepareRenameRequest.type, at(gameSetup, setupLines, 2, 'Start'))).rejects.toMatchObject({
      message: "The game's files are read only",
    });
    const fixRequest = { textDocument: { uri: gameSetup }, range: opened.diagnostics[0].range, context: { diagnostics: opened.diagnostics } };
    expect(await connection.sendRequest(CodeActionRequest.type, fixRequest)).toEqual([]);

    // The DLC's patch, opened as a game document: compared with the file it changes, never written.
    expect(summarize(await open(dlcPatch, dlcPatchText))).toEqual([]);
    expect((await documentInfo(dlcPatch)).patchTarget).toMatchObject({ name: 'md/setup.xml', uri: gameSetup, source: 'game', earlier: [] });
    const compared = await connection.sendRequest<PatchComparisonResult>(PatchComparisonRequestMethod, { uri: dlcPatch });
    expect(compared?.before).toBe(setupText);
    const written = await connection.sendRequest<PatchWriteResult>(PatchWriteRequestMethod, { uri: dlcPatch, version: 1, edited: compared?.after ?? '' });
    expect(written.refused).toEqual([{ line: 0, reason: "The game's files are read only" }]);

    for (const uri of [gameSetup, dlcPatch, minePatchUri, mineWaresUri, mineUri]) {
      const closed = diagnosticsCount(uri, 0);
      await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
      await closed;
    }

    // Both set: the extracted files come first, and the game documents read from them.
    clientSettings.unpackedFileLocation = unpacked;
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    const extracted = await statusWhere((status) => status.state === 'ready' && status.gameSource === 'extracted');
    expect(extracted.gameFolder).toBe(unpacked);
    expect(extracted.gameVersion).toBeUndefined();
    expect(await gameFile(gameSetup)).toBeNull();
    expect(await gameFile('x4codesense-game:/libraries/md.xsd')).toEqual({ text: readFileSync(path.join(unpacked, 'libraries', 'md.xsd'), 'utf8') });
    clientSettings.gameFolder = '';
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    await connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event: { added: [], removed: [workspace] } });
    await statusWhere((status) => status.state === 'ready' && !status.extensions.includes('mine'));
  }, 30_000);
});
