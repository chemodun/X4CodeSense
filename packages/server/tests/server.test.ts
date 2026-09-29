/**
 * End-to-end test: bundle the server, start it over stdio and talk LSP to it.
 * Self-contained: it does not need a previous `tsc -b` or client bundle.
 * The test client answers `workspace/configuration` with the settings below, so the server loads the
 * fixture schemas and script properties of the core package.
 */
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CompletionRequest,
  ConfigurationRequest,
  createProtocolConnection,
  DefinitionRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  PrepareRenameRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RegistrationRequest,
  RenameRequest,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocumentSyncKind,
  type Location,
  type ProtocolConnection,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { DocumentInfoRequestMethod, type DocumentInfoResult } from '../../core/src';

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

async function documentInfo(uri: string): Promise<DocumentInfoResult> {
  return connection.sendRequest<DocumentInfoResult>(DocumentInfoRequestMethod, { uri });
}

/** Resolves with the next diagnostics the server publishes for the uri. Call before sending the change that triggers them. */
function nextDiagnostics(uri: string): Promise<PublishDiagnosticsParams> {
  return new Promise((resolve) => {
    const disposable = connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      if (params.uri === uri) {
        disposable.dispose();
        resolve(params);
      }
    });
  });
}

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
  connection.listen();
  const result = await connection.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: { workspace: { configuration: true }, textDocument: { completion: { completionItem: { snippetSupport: true } } } },
  });
  expect(result.capabilities.textDocumentSync).toBe(TextDocumentSyncKind.Incremental);
  expect(result.capabilities.completionProvider?.triggerCharacters).toContain('<');
  expect(result.capabilities.hoverProvider).toBe(true);
  expect(result.capabilities.definitionProvider).toBe(true);
  expect(result.capabilities.referencesProvider).toBe(true);
  expect(result.capabilities.renameProvider).toEqual({ prepareProvider: true });
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

    clientSettings.unpackedFileLocation = unpacked;
    const restored = nextDiagnostics(uri);
    await connection.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
    expect(summarize(await restored).length).toBe(3);
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

  it('follows a text file while it is edited, and forgets unsaved texts on close', async () => {
    // One waiter at a time: the connection keeps a single handler per notification.
    const added = nextDiagnostics(scriptUri);
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: textUri,
        languageId: 'xml',
        version: 1,
        text: '<diff><add sel="/language"><page id="1001"><t id="50">Fifty</t></page></add></diff>',
      },
    });
    expect(summarize(await added)).toEqual([]);
    const removed = nextDiagnostics(scriptUri);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: textUri } });
    expect(summarize(await removed)).toEqual([missing]);
  });
});
