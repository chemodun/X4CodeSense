import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import {
  DocumentInfoRequestMethod,
  PatchComparisonRequestMethod,
  PatchWriteRequestMethod,
  schemaDisplayName,
  StatusNotificationMethod,
  type DocumentInfoParams,
  type DocumentInfoResult,
  type PatchComparisonParams,
  type PatchComparisonResult,
  type PatchTargetInfo,
  type PatchWriteResult,
  type ScriptSchema,
  type ServerStatus,
} from 'x4-script-core';
import { PatchLayout } from './patchLayout';
import { PatchedSides, patchedScheme } from './patchSides';
import {
  offerDetails,
  offerMessage,
  oldSettingsOffer,
  ourSection,
  type OldSettingsOffer,
  type ScopedValues,
  type SettingsScope,
} from './x4CodeCompleteSettings';

/** The scheme of the left side of a patch comparison, the file before the patch: the patch document's uri is in the query. */
const comparisonScheme = 'x4codesense-patch';

/** Set when the offer of X4CodeComplete's settings was answered with Never; Settings Sync carries it to other machines. */
const neverOfferKey = 'x4CodeSense.neverOfferOldSettings';

/** The commands the status bar's tooltip may run. */
const tooltipCommands = [
  'x4CodeSense.selectGameFolder',
  'x4CodeSense.showOutput',
  'x4CodeSense.openSettings',
  'x4CodeSense.restartServer',
  'x4CodeSense.openPatchTarget',
  'x4CodeSense.comparePatch',
  'x4CodeSense.editPatchWithResult',
];

const shortSchemaName: Record<ScriptSchema, string> = { md: 'MD', aiscripts: 'AI' };

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
/** What the server last said it does and has read; undefined while it starts. */
let serverStatus: ServerStatus | undefined;
/** What the server said of the active document. */
let activeInfo: { document: vscode.TextDocument; info: DocumentInfoResult } | undefined;
/** The value of the `x4CodeSense.documentKind` context key: `md`, `aiscripts`, `patch` or empty. */
let documentKind = '';
/** Counts status bar updates: an answer to an older one is dropped. */
let statusRequests = 0;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  // Scripts and text files of the workspace change on disk too (checkouts, other editors): the server reads them again.
  const xmlFiles = vscode.workspace.createFileSystemWatcher('**/*.xml');
  context.subscriptions.push(xmlFiles);
  const clientOptions: LanguageClientOptions = {
    // Lua files only get the hover of `ReadText` calls, with the text they read.
    documentSelector: [
      { scheme: 'file', language: 'xml' },
      { scheme: 'file', language: 'lua' },
    ],
    synchronize: { configurationSection: 'x4CodeSense', fileEvents: xmlFiles },
    outputChannelName: 'X4CodeSense',
  };
  const languageClient = new LanguageClient('x4CodeSense', 'X4CodeSense', serverOptions, clientOptions);
  client = languageClient;

  statusBarItem = vscode.window.createStatusBarItem('x4CodeSense.documentInfo', vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = 'X4CodeSense';
  statusBarItem.command = 'x4CodeSense.showMenu';
  context.subscriptions.push(statusBarItem);

  const comparisons = new PatchComparisons();
  const sides = new PatchedSides({
    compare: async (patch) => {
      const params: PatchComparisonParams = { uri: patch };
      return client ? await client.sendRequest<PatchComparisonResult>(PatchComparisonRequestMethod, params) : null;
    },
    write: async (params) => {
      if (!client) {
        throw new Error('The language server is not running');
      }
      return await client.sendRequest<PatchWriteResult>(PatchWriteRequestMethod, params);
    },
    log: (line) => languageClient.outputChannel.appendLine(line),
  });
  const layout = new PatchLayout();
  languageClient.onNotification(StatusNotificationMethod, (status: ServerStatus) => {
    const nowReady = status.state === 'ready' && serverStatus?.state !== 'ready';
    serverStatus = status;
    void updateStatusBar();
    if (nowReady) {
      // Comparisons restored from the last session, or opened while the server was busy, get their text now.
      comparisons.refreshAll();
      sides.refreshAll();
    }
  });
  let changeTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(comparisonScheme, comparisons),
    vscode.workspace.registerFileSystemProvider(patchedScheme, sides, { isCaseSensitive: true }),
    sides,
    layout,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void updateStatusBar();
      void followPatch(editor, layout, comparisons, sides);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== 'xml' || event.document.uri.scheme !== 'file' || event.contentChanges.length === 0) {
        return;
      }
      // A change to a patch or to the file it changes: the status bar and open comparisons follow when typing pauses.
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        void updateStatusBar();
        comparisons.refreshAll();
        sides.refreshAll();
      }, 300);
    }),
    { dispose: () => clearTimeout(changeTimer) },
    vscode.commands.registerCommand('x4CodeSense.restartServer', async () => {
      serverStatus = undefined;
      await updateStatusBar();
      await client?.restart();
    }),
    vscode.commands.registerCommand('x4CodeSense.showOutput', () => client?.outputChannel.show(true)),
    vscode.commands.registerCommand('x4CodeSense.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)
    ),
    vscode.commands.registerCommand('x4CodeSense.selectGameFolder', selectGameFolder),
    vscode.commands.registerCommand('x4CodeSense.openPatchTarget', openPatchTarget),
    vscode.commands.registerCommand('x4CodeSense.comparePatch', () => comparePatch(comparisons, sides)),
    vscode.commands.registerCommand('x4CodeSense.editPatchWithResult', () => editPatchWithResult(comparisons, sides, layout)),
    vscode.commands.registerCommand('x4CodeSense.writeSideIntoPatch', writeSideIntoPatch),
    vscode.commands.registerCommand('x4CodeSense.showMenu', showMenu)
  );

  context.globalState.setKeysForSync([neverOfferKey]);
  void offerOldSettings(context, languageClient.outputChannel);
  await languageClient.start();
  await updateStatusBar();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}

/** The kind of script the server found the document to be, `patch`, or undefined. */
function kindOf(info: DocumentInfoResult | undefined): ScriptSchema | 'patch' | undefined {
  return info?.metadata?.schema ?? (info?.isDiff ? 'patch' : undefined);
}

function setDocumentKind(kind: string | undefined): void {
  if ((kind ?? '') !== documentKind) {
    documentKind = kind ?? '';
    void vscode.commands.executeCommand('setContext', 'x4CodeSense.documentKind', documentKind);
  }
}

/** True when the game files are known to be missing: not set, or no schemas in them. */
function gameFilesMissing(): boolean {
  return serverStatus !== undefined && serverStatus.state !== 'loading' && serverStatus.schemas.length === 0;
}

/** Asks the server about the document in the active editor; the answer is undefined when it cannot tell now. */
async function activeDocumentInfo(): Promise<{ document: vscode.TextDocument; info: DocumentInfoResult } | undefined> {
  return documentInfo(vscode.window.activeTextEditor?.document);
}

/** Asks the server about a document; the answer is undefined when it cannot tell now. */
async function documentInfo(document: vscode.TextDocument | undefined): Promise<{ document: vscode.TextDocument; info: DocumentInfoResult } | undefined> {
  if (!client || !document || document.languageId !== 'xml' || document.uri.scheme !== 'file') {
    return undefined;
  }
  try {
    const params: DocumentInfoParams = { uri: document.uri.toString() };
    return { document, info: await client.sendRequest<DocumentInfoResult>(DocumentInfoRequestMethod, params) };
  } catch {
    // The server is starting or stopping.
    return undefined;
  }
}

/**
 * Shows the active script or patch in the status bar: its kind and name, or the file a patch changes. A
 * spinner while the server reads the game files or indexes the scripts, a warning when the game files
 * are not set or hold no schemas. The tooltip tells what the server has read; a click opens the menu.
 */
async function updateStatusBar(): Promise<void> {
  const item = statusBarItem;
  if (!item) {
    return;
  }
  const request = ++statusRequests;
  const active = await activeDocumentInfo();
  if (request !== statusRequests) {
    return;
  }
  activeInfo = active;
  const kind = kindOf(active?.info);
  setDocumentKind(kind);
  if (!active || !kind) {
    item.hide();
    return;
  }
  const info = active.info;
  const target = info.patchTarget;
  const label = info.metadata
    ? `X4 ${shortSchemaName[info.metadata.schema]}: ${info.metadata.name || '(unnamed)'}`
    : `X4 patch${target ? `: ${target.name}` : ''}`;
  const busy = serverStatus === undefined || serverStatus.state !== 'ready';
  const missing = gameFilesMissing();
  const icon = busy ? '$(sync~spin)' : missing ? '$(warning)' : kind === 'patch' ? '$(diff)' : '$(symbol-namespace)';
  item.text = `${icon} ${label}`;
  item.backgroundColor = missing ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  item.tooltip = tooltip(info);
  item.show();
}

/** Text as Markdown shows it literally: names such as extension ids may hold `_` or `*`. */
function escaped(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function plural(count: number, word: string, suffix = 's'): string {
  return `${count.toLocaleString('en')} ${word}${count === 1 ? '' : suffix}`;
}

/**
 * The tooltip of the status bar item. VS Code pads code spans in hovers, so no punctuation follows one:
 * it would look detached.
 */
function tooltip(info: DocumentInfoResult): vscode.MarkdownString {
  const lines: string[] = [];
  const target = info.patchTarget;
  if (info.metadata) {
    lines.push(`**${schemaDisplayName[info.metadata.schema]}** \`${info.metadata.name}\``);
  } else if (target?.file) {
    const whose = target.source === 'game' ? "the game's file" : target.source ? `the file of ${escaped(target.source)}` : 'the file';
    const earlier = target.earlier.length === 0 ? '' : `, after ${plural(target.earlier.length, 'earlier patch', 'es')}`;
    lines.push(
      `**Patch** of \`${target.name}\` (${whose}${earlier})`,
      '',
      '[Open the file it changes](command:x4CodeSense.openPatchTarget) · [Show what it changes](command:x4CodeSense.comparePatch) · [Edit above what it changes](command:x4CodeSense.editPatchWithResult)'
    );
  } else if (target) {
    lines.push(`**Patch** of \`${target.name}\` has nothing to patch: ${escaped(target.missing ?? 'the file is not found')}`);
  } else {
    lines.push('**Patch**: the file it changes is known once the scripts are indexed');
  }
  lines.push('', '---', '');
  const status = serverStatus;
  if (!status) {
    lines.push('$(sync~spin) The language server is starting.');
  } else if (status.state === 'loading') {
    lines.push('$(sync~spin) Reading the game files.');
  } else if (status.gameFolder === undefined) {
    lines.push(
      '$(warning) The extracted game files are not set, so scripts are only checked for well-formedness. [Select the folder](command:x4CodeSense.selectGameFolder)'
    );
  } else if (status.schemas.length === 0) {
    lines.push(
      `$(warning) The game files hold no schemas, so scripts are only checked for well-formedness. [Select another folder](command:x4CodeSense.selectGameFolder) instead of \`${status.gameFolder}\``
    );
  } else {
    const properties = status.properties ? 'script properties' : 'no script properties';
    lines.push(`Game files: schemas ${status.schemas.join(', ')}, ${properties} and ${plural(status.texts, 'text')}, read from \`${status.gameFolder}\``);
  }
  if (status?.state === 'indexing') {
    lines.push('', '$(sync~spin) Indexing the scripts.');
  } else if (status?.state === 'ready' && status.gameFolder !== undefined) {
    const sources = ['the game'];
    if (status.dlcs.length > 0) {
      sources.push(`its ${plural(status.dlcs.length, 'DLC')}`);
    }
    if (status.extensions.length > 5) {
      sources.push(plural(status.extensions.length, 'extension'));
    } else if (status.extensions.length > 0) {
      sources.push(`the extension${status.extensions.length === 1 ? '' : 's'} ${listed(status.extensions.map(escaped))}`);
    }
    lines.push('', `Indexed: ${plural(status.scripts, 'script')} of ${listed(sources)}.`);
  }
  if (status && status.problems > 0) {
    lines.push(
      '',
      `$(warning) ${status.problems} problem${status.problems === 1 ? '' : 's'} reading the game files: [see the output](command:x4CodeSense.showOutput)`
    );
  }
  lines.push(
    '',
    '---',
    '',
    '[Output](command:x4CodeSense.showOutput) · [Settings](command:x4CodeSense.openSettings) · [Restart](command:x4CodeSense.restartServer)'
  );
  const markdown = new vscode.MarkdownString(lines.join('\n'), true);
  markdown.isTrusted = { enabledCommands: tooltipCommands };
  return markdown;
}

/** The commands of the status bar item, with those for a patch when the active document is one. */
async function showMenu(): Promise<void> {
  type Entry = vscode.QuickPickItem & { command: string };
  const entries: Entry[] = [];
  const target = activeInfo?.info.patchTarget;
  if (kindOf(activeInfo?.info) === 'patch') {
    entries.push(
      { label: '$(go-to-file) Open the File This Patch Changes', description: target?.name, command: 'x4CodeSense.openPatchTarget' },
      { label: '$(diff) Show What This Patch Changes', command: 'x4CodeSense.comparePatch' },
      { label: '$(split-vertical) Edit This Patch Above What It Changes', command: 'x4CodeSense.editPatchWithResult' }
    );
  }
  entries.push(
    {
      label: '$(folder-opened) Select the Extracted Game Files...',
      description: serverStatus?.gameFolder ?? 'not set',
      command: 'x4CodeSense.selectGameFolder',
    },
    { label: '$(output) Show Output', command: 'x4CodeSense.showOutput' },
    { label: '$(settings-gear) Open Settings', command: 'x4CodeSense.openSettings' },
    { label: '$(debug-restart) Restart Language Server', description: 'reads the game files and the scripts again', command: 'x4CodeSense.restartServer' }
  );
  const picked = await vscode.window.showQuickPick(entries, { title: 'X4CodeSense', placeHolder: 'Choose an action' });
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}

/** Asks for the folder of the extracted game files and sets it where the setting is set: the workspace, else the user settings. */
async function selectGameFolder(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('x4CodeSense');
  const current = configuration.get<string>('unpackedFileLocation', '').trim();
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    title: 'The extracted game files: the folder holding aiscripts, md, libraries and t',
    openLabel: 'Use These Game Files',
    ...(current ? { defaultUri: vscode.Uri.file(current) } : {}),
  });
  const folder = picked?.[0];
  if (!folder) {
    return;
  }
  const schemas = await Promise.all(['md.xsd', 'aiscripts.xsd'].map((file) => exists(vscode.Uri.joinPath(folder, 'libraries', file))));
  if (!schemas.some(Boolean)) {
    const useAnyway = 'Use It Anyway';
    const choice = await vscode.window.showWarningMessage(
      `${folder.fsPath} holds no libraries/md.xsd or libraries/aiscripts.xsd: it does not look like the extracted game files.`,
      { modal: true },
      useAnyway
    );
    if (choice !== useAnyway) {
      return;
    }
  }
  const inWorkspace = configuration.inspect<string>('unpackedFileLocation')?.workspaceValue !== undefined;
  await configuration.update('unpackedFileLocation', folder.fsPath, inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
}

/**
 * Offers the settings of X4CodeComplete where X4CodeSense has none of its own yet, see `oldSettingsOffer`.
 * Use copies them, Show Them lists them in the output with those not taken and asks again, Not Now (or
 * closing the notice) asks at the next start, Never stops asking. Once copied, our settings are set at
 * that scope, so nothing is offered there again.
 */
async function offerOldSettings(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (context.globalState.get<boolean>(neverOfferKey)) {
    return;
  }
  const offer = oldSettingsOffer(inspectSetting, (folder) => fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true);
  if (offer.taken.length === 0) {
    if (offer.skipped.length > 0) {
      output.appendLine(['Settings of X4CodeComplete, none of which X4CodeSense can take:', ...offerDetails(offer)].join('\n'));
    }
    return;
  }
  const use = 'Use';
  const showThem = 'Show Them';
  const notNow = 'Not Now';
  const never = 'Never';
  let choice = await vscode.window.showInformationMessage(offerMessage(offer), use, showThem, notNow, never);
  if (choice === showThem) {
    output.appendLine(['Settings of X4CodeComplete that X4CodeSense would take:', ...offerDetails(offer)].join('\n'));
    output.show(true);
    choice = await vscode.window.showInformationMessage(offerMessage(offer), use, notNow, never);
  }
  if (choice === use) {
    await takeOldSettings(offer, output);
  } else if (choice === never) {
    await context.globalState.update(neverOfferKey, true);
  }
}

function inspectSetting(section: string, key: string): ScopedValues {
  const values = vscode.workspace.getConfiguration(section).inspect(key);
  return { user: values?.globalValue, workspace: values?.workspaceValue };
}

async function takeOldSettings(offer: OldSettingsOffer, output: vscode.OutputChannel): Promise<void> {
  const targets: Record<SettingsScope, vscode.ConfigurationTarget> = {
    user: vscode.ConfigurationTarget.Global,
    workspace: vscode.ConfigurationTarget.Workspace,
  };
  const configuration = vscode.workspace.getConfiguration(ourSection);
  const failed: string[] = [];
  for (const setting of offer.taken) {
    try {
      await configuration.update(setting.key, setting.value, targets[setting.scope]);
    } catch (error) {
      failed.push(`  ${ourSection}.${setting.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  output.appendLine(`Took ${offer.taken.length - failed.length} of ${offer.taken.length} settings of X4CodeComplete.`);
  if (failed.length > 0) {
    output.appendLine(['Not written:', ...failed].join('\n'));
    const showOutput = 'Show Output';
    if (
      (await vscode.window.showWarningMessage(`X4CodeSense could not write ${failed.length} of the settings of X4CodeComplete.`, showOutput)) === showOutput
    ) {
      output.show(true);
    }
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** The patch document in the active editor, with what the server knows of it; tells the user when there is none. */
async function activePatch(): Promise<{ document: vscode.TextDocument; info: DocumentInfoResult } | undefined> {
  const active = await activeDocumentInfo();
  if (!active || !active.info.isDiff) {
    void vscode.window.showInformationMessage('X4CodeSense: the active editor holds no patch document.');
    return undefined;
  }
  if (!active.info.patchTarget) {
    void vscode.window.showInformationMessage('X4CodeSense: the file this patch changes is known once the scripts are indexed.');
    return undefined;
  }
  if (!active.info.patchTarget.file) {
    void vscode.window.showWarningMessage(
      `X4CodeSense: nothing to patch: ${active.info.patchTarget.missing ?? `${active.info.patchTarget.name} is not found`}.`
    );
    return undefined;
  }
  return active;
}

async function openPatchTarget(): Promise<void> {
  const file = (await activePatch())?.info.patchTarget?.file;
  if (file) {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }
}

/** Opens a diff of the file the active patch changes: as the game loads it before the patch, and after it. */
async function comparePatch(comparisons: PatchComparisons, sides: PatchedSides): Promise<void> {
  const patch = await activePatch();
  if (patch?.info.patchTarget) {
    await openComparison(patch.document, patch.info.patchTarget, comparisons, sides);
  }
}

/**
 * Puts the active patch in the upper part of the window, and the diff of the file it changes full width
 * below it. From then on, files opened below go up, and the diff below follows the patch in front above.
 */
async function editPatchWithResult(comparisons: PatchComparisons, sides: PatchedSides, layout: PatchLayout): Promise<void> {
  const patch = await activePatch();
  const target = patch?.info.patchTarget;
  if (!patch || !target) {
    return;
  }
  // Two groups, one above the other; the editors of any other groups move into them.
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 1, groups: [{ size: 0.4 }, { size: 0.6 }] });
  await vscode.window.showTextDocument(patch.document, { viewColumn: vscode.ViewColumn.One, preview: false });
  await openComparison(patch.document, target, comparisons, sides, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true, preview: false });
  layout.arrange();
}

/** Shows the diff of the patch that came to the front above, while the window is arranged so. */
async function followPatch(editor: vscode.TextEditor | undefined, layout: PatchLayout, comparisons: PatchComparisons, sides: PatchedSides): Promise<void> {
  const column = editor && layout.comparisonColumn(editor);
  const patch = column && (await documentInfo(editor.document));
  if (!column || !patch?.info.isDiff || !patch.info.patchTarget?.file) {
    return;
  }
  await openComparison(patch.document, patch.info.patchTarget, comparisons, sides, { viewColumn: column, preserveFocus: true, preview: true });
}

/** Saves the active side with a patch, which writes its changes into the patch; without the save actions, which would change the game's text. */
async function writeSideIntoPatch(): Promise<void> {
  if (vscode.window.activeTextEditor?.document.uri.scheme !== patchedScheme) {
    void vscode.window.showInformationMessage('X4CodeSense: click into the side with the patch first.');
    return;
  }
  await vscode.commands.executeCommand('workbench.action.files.saveWithoutFormatting');
}

/** The diff of a patch's target without and with the patch; the side with it can be edited. */
async function openComparison(
  patch: vscode.TextDocument,
  target: PatchTargetInfo,
  comparisons: PatchComparisons,
  sides: PatchedSides,
  options?: vscode.TextDocumentShowOptions
): Promise<void> {
  const before = comparisons.uriOf(patch.uri, target.name);
  comparisons.refresh(before);
  sides.refreshAll();
  const earlier = target.earlier.length === 0 ? '' : ` after ${target.earlier.length} earlier`;
  const title = `${path.basename(target.name)}: without and with this patch${earlier}`;
  await vscode.commands.executeCommand('vscode.diff', before, sides.uriOf(patch.uri, target.name), title, options);
}

/** The left sides of patch comparisons, asked from the server whenever the editor shows them. */
class PatchComparisons implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  uriOf(patch: vscode.Uri, targetName: string): vscode.Uri {
    return vscode.Uri.from({ scheme: comparisonScheme, path: `/before/${targetName}`, query: new URLSearchParams({ patch: patch.toString() }).toString() });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params: PatchComparisonParams = { uri: new URLSearchParams(uri.query).get('patch') ?? '' };
    let compared: PatchComparisonResult = null;
    try {
      compared = client ? await client.sendRequest<PatchComparisonResult>(PatchComparisonRequestMethod, params) : null;
    } catch {
      // The server is starting or stopping.
    }
    return compared?.before ?? '<!-- X4CodeSense: open the patch document to compare it with the file it changes. -->\n';
  }

  refresh(...uris: vscode.Uri[]): void {
    for (const uri of uris) {
      this.changed.fire(uri);
    }
  }

  /** Asks again for every side the editor shows. */
  refreshAll(): void {
    this.refresh(...vscode.workspace.textDocuments.filter((document) => document.uri.scheme === comparisonScheme).map((document) => document.uri));
  }
}
