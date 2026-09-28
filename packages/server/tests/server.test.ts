/**
 * End-to-end test: bundle the server, start it over stdio and talk LSP to it.
 * Self-contained: it does not need a previous `tsc -b` or client bundle.
 */
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProtocolConnection,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocumentSyncKind,
  type ProtocolConnection,
} from 'vscode-languageserver/node';
import { DocumentInfoRequestMethod, type DocumentInfoResult } from '../../core/src';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '../src/server.ts');
const coreEntry = path.resolve(here, '../../core/src/index.ts');

let workDir: string;
let child: ChildProcess;
let connection: ProtocolConnection;

const mdText = '<?xml version="1.0"?>\n<mdscript name="Sample" xsi:noNamespaceSchemaLocation="md.xsd">\n  <cues />\n</mdscript>\n';
const aiText = '<aiscript name="order.sample" version="1">\n</aiscript>\n';

async function documentInfo(uri: string): Promise<DocumentInfoResult> {
  return connection.sendRequest<DocumentInfoResult>(DocumentInfoRequestMethod, { uri });
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
  connection.listen();
  const result = await connection.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  });
  expect(result.capabilities.textDocumentSync).toBe(TextDocumentSyncKind.Incremental);
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
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'xml', version: 1, text: mdText },
    });
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
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'xml', version: 1, text: '<wares><ware id="x" /></wares>' },
    });
    const info = await documentInfo(uri);
    expect(info).toEqual({ isDiff: false, rootElement: 'wares' });
  });

  it('recognises a patch document', async () => {
    const uri = 'file:///mod/md/patch.xml';
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'xml', version: 1, text: '<diff><add sel="/mdscript/cues"><cue name="X" /></add></diff>' },
    });
    const info = await documentInfo(uri);
    expect(info).toEqual({ isDiff: true, rootElement: 'diff' });
  });

  it('returns no metadata for a document it has never seen', async () => {
    const info = await documentInfo('file:///nowhere.xml');
    expect(info.metadata).toBeUndefined();
  });
});
