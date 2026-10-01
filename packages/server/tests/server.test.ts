/**
 * End-to-end test: bundle the server, start it over stdio and talk LSP to it.
 * Self-contained: it does not need a previous `tsc -b` or client bundle.
 * The test client answers `workspace/configuration` with the settings below, so the server loads the
 * fixture schemas and script properties of the core package.
 */
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CodeActionRequest,
  CompletionRequest,
  ConfigurationRequest,
  createProtocolConnection,
  DefinitionRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidChangeWorkspaceFoldersNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  InitializedNotification,
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
import {
  DocumentInfoRequestMethod,
  loadGameData,
  patchAfterScheme,
  patchBeforeScheme,
  PatchComparisonRequestMethod,
  PatchWriteRequestMethod,
  semanticTokensLegend,
  StatusNotificationMethod,
  type DocumentInfoResult,
  type PatchComparisonResult,
  type PatchWriteResult,
  type ServerStatus,
} from '../../core/src';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '../src/server.ts');
const coreEntry = path.resolve(here, '../../core/src/index.ts');
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
    alias: { 'x4-script-core': coreEntry },
  });
  child = spawn(process.execPath, [bundle, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  connection = createProtocolConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
  connection.onRequest(ConfigurationRequest.type, (params) => params.items.map(() => ({ ...clientSettings })));
  connection.onRequest(RegistrationRequest.type, () => undefined);
  connection.onNotification(StatusNotificationMethod, (status: ServerStatus) => {
    statuses.push(status);
    for (const waiter of [...statusWaiters]) {
      if (waiter(status)) {
        statusWaiters.delete(waiter);
      }
    }
  });
  connection.onRequest(WorkDoneProgressCreateRequest.type, ({ token }) => {
    connection.onProgress(WorkDoneProgress.type, token, (value) => progress.push(value.kind === 'end' ? 'end' : `${value.kind}: ${value.message}`));
  });
  connection.onRequest(SemanticTokensRefreshRequest.type, () => {
    semanticTokensRefreshes++;
  });
  connection.listen();
  const result = await connection.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: {
      workspace: { configuration: true, workspaceFolders: true, semanticTokens: { refreshSupport: true } },
      textDocument: { completion: { completionItem: { snippetSupport: true } } },
      window: { workDoneProgress: true },
    },
  });
  expect(result.capabilities.textDocumentSync).toBe(TextDocumentSyncKind.Incremental);
  expect(result.capabilities.completionProvider?.triggerCharacters).toEqual(expect.arrayContaining(['<', '/', '@', "'"]));
  expect(result.capabilities.hoverProvider).toBe(true);
  expect(result.capabilities.definitionProvider).toBe(true);
  expect(result.capabilities.referencesProvider).toBe(true);
  expect(result.capabilities.renameProvider).toEqual({ prepareProvider: true });
  expect(result.capabilities.documentSymbolProvider).toEqual({ label: 'X4CodeSense' });
  expect(result.capabilities.workspaceSymbolProvider).toBe(true);
  expect(result.capabilities.codeActionProvider).toEqual({ codeActionKinds: ['quickfix'] });
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
  });
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
      source: 'base',
      earlier: [],
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
