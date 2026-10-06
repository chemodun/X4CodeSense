import * as path from 'node:path';
import * as vscode from 'vscode';

/** The id of the provider, as `contributes.mcpServerDefinitionProviders` declares it. */
const providerId = 'x4CodeSense.mcpServer';

/** A string setting, when it is one; settings.json may hold anything. */
function textSetting(configuration: vscode.WorkspaceConfiguration, key: string): string {
  const value = configuration.get<unknown>(key);
  return typeof value === 'string' ? value.trim() : '';
}

function booleanSetting(configuration: vscode.WorkspaceConfiguration, key: string, fallback: boolean): boolean {
  const value = configuration.get<unknown>(key);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * The folders of extensions the server reads, as the language server takes them: `extensionsFolder`
 * resolved against each workspace folder (an absolute path as it is), and the workspace folders.
 */
function extensionFolders(configuration: vscode.WorkspaceConfiguration): string[] {
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
  const setting = textSetting(configuration, 'extensionsFolder');
  const folders: string[] = [];
  if (path.isAbsolute(setting)) {
    folders.push(setting);
  } else if (setting !== '' && setting !== '.') {
    folders.push(...workspaceFolders.map((folder) => path.resolve(folder, setting)));
  }
  folders.push(...workspaceFolders);
  return [...new Set(folders)];
}

/** The server's arguments from the extension's settings. */
export function serverArguments(): string[] {
  const configuration = vscode.workspace.getConfiguration('x4CodeSense');
  const args: string[] = [];
  const unpacked = textSetting(configuration, 'unpackedFileLocation');
  const game = textSetting(configuration, 'gameFolder');
  if (unpacked !== '') {
    args.push('--unpacked', unpacked);
  }
  // The installed game: the game files without extracted ones, and the mods installed in it either way.
  if (game !== '') {
    args.push('--game', game);
    if (booleanSetting(configuration, 'readInstalledDependencies', false)) {
      args.push('--installed-dependencies');
    }
  }
  for (const folder of extensionFolders(configuration)) {
    args.push('--extensions', folder);
  }
  const language = configuration.get<unknown>('languageNumber');
  const digits = typeof language === 'number' ? String(language) : typeof language === 'string' ? language.trim() : '';
  if (/^\d+$/.test(digits)) {
    args.push('--language', String(Number(digits)));
  }
  if (!booleanSetting(configuration, 'validateXmlStructure', true)) {
    args.push('--no-structure');
  }
  if (!booleanSetting(configuration, 'guessVariableTypes', true)) {
    args.push('--no-type-guesses');
  }
  return args;
}

/**
 * Offers the bundled MCP server to the editor's agents (Copilot's agent mode), on the game and the
 * extensions the settings name, run by the editor's own Node.js. Unless `x4CodeSense.mcpServer.enabled`
 * is off; the editor starts it when an agent first uses it, and again when the settings change.
 */
export function registerMcpServer(context: vscode.ExtensionContext): vscode.Disposable[] {
  // An editor without the MCP API: nothing to offer.
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') {
    return [];
  }
  const changed = new vscode.EventEmitter<void>();
  const script = context.asAbsolutePath(path.join('dist', 'x4-script-mcp.js'));
  const version = String((context.extension.packageJSON as { version?: unknown }).version ?? '');
  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      if (!booleanSetting(vscode.workspace.getConfiguration('x4CodeSense'), 'mcpServer.enabled', true)) {
        return [];
      }
      const args = serverArguments();
      // The editor's executable runs as Node.js with this variable; Node.js itself ignores it.
      const definition = new vscode.McpStdioServerDefinition('X4CodeSense', process.execPath, [script, ...args], { ELECTRON_RUN_AS_NODE: '1' }, version);
      const first = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file');
      if (first) {
        definition.cwd = first.uri;
      }
      return [definition];
    },
  };
  return [
    changed,
    vscode.lm.registerMcpServerDefinitionProvider(providerId, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('x4CodeSense')) {
        changed.fire();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
  ];
}
