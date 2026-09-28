import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { DocumentInfoRequestMethod, schemaDisplayName, type DocumentInfoParams, type DocumentInfoResult } from 'x4-script-core';

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'xml' }],
    synchronize: { configurationSection: 'x4CodeSense' },
    outputChannelName: 'X4CodeSense',
  };
  client = new LanguageClient('x4CodeSense', 'X4CodeSense', serverOptions, clientOptions);

  statusBarItem = vscode.window.createStatusBarItem('x4CodeSense.documentInfo', vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = 'X4CodeSense';
  statusBarItem.command = 'x4CodeSense.restartServer';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => void updateStatusBar()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        void updateStatusBar();
      }
    }),
    vscode.commands.registerCommand('x4CodeSense.restartServer', async () => {
      await client?.restart();
      await updateStatusBar();
    })
  );

  await client.start();
  await updateStatusBar();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}

async function updateStatusBar(): Promise<void> {
  if (!statusBarItem || !client) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml' || editor.document.uri.scheme !== 'file') {
    statusBarItem.hide();
    return;
  }
  const params: DocumentInfoParams = { uri: editor.document.uri.toString() };
  const result = await client.sendRequest<DocumentInfoResult>(DocumentInfoRequestMethod, params);
  if (result.metadata) {
    const kind = schemaDisplayName[result.metadata.schema];
    statusBarItem.text = `$(symbol-namespace) X4 ${kind}: ${result.metadata.name || '(unnamed)'}`;
    statusBarItem.tooltip = `X4CodeSense: ${kind} '${result.metadata.name}'. Click to restart the language server.`;
    statusBarItem.show();
  } else if (result.isDiff) {
    statusBarItem.text = '$(diff) X4 patch';
    statusBarItem.tooltip = 'X4CodeSense: diff patch document. Click to restart the language server.';
    statusBarItem.show();
  } else {
    statusBarItem.hide();
  }
}
