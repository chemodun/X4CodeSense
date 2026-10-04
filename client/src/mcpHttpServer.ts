import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { serverArguments } from './mcpServer';

/** The port when `x4CodeSense.mcpServer.port` does not name one. */
const defaultPort = 47400;

/** The settings the server is started with: a change to one restarts it. */
const serverSettings = [
  'unpackedFileLocation',
  'gameFolder',
  'extensionsFolder',
  'languageNumber',
  'validateXmlStructure',
  'guessVariableTypes',
  'mcpServer.port',
];

export type McpHttpState = { state: 'stopped' } | { state: 'starting' } | { state: 'running'; url: string };

function portSetting(): number {
  const value = vscode.workspace.getConfiguration('x4CodeSense').get<unknown>('mcpServer.port');
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535 ? value : defaultPort;
}

/**
 * The MCP server on http://127.0.0.1:<port>/mcp, started and stopped by command: for agents that VS Code
 * does not give the servers of extensions, such as Copilot CLI sessions, Claude Code or Codex, which are
 * given its URL. It runs on the editor's Node.js with the settings the language server has, and starts
 * again when they change.
 */
export class McpHttpServer implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private current: McpHttpState = { state: 'stopped' };
  /** True while a stop was asked for: the exit that follows is no failure. */
  private stopping = false;
  private readonly changed = new vscode.EventEmitter<McpHttpState>();
  private readonly disposables: vscode.Disposable[] = [];
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly script: string,
    private readonly output: vscode.LogOutputChannel
  ) {
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (this.child && serverSettings.some((key) => event.affectsConfiguration(`x4CodeSense.${key}`))) {
          void this.restart();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.child) {
          void this.restart();
        }
      })
    );
  }

  get state(): McpHttpState {
    return this.current;
  }

  /** The URL it serves at, or will serve at when started. */
  get url(): string {
    return this.current.state === 'running' ? this.current.url : `http://127.0.0.1:${portSetting()}/mcp`;
  }

  private setState(state: McpHttpState): void {
    this.current = state;
    void vscode.commands.executeCommand('setContext', 'x4CodeSense.mcpHttpServer', state.state);
    this.changed.fire(state);
  }

  /** Starts it, unless it runs; resolves once it listens, true, or has failed, false. */
  async start(): Promise<boolean> {
    if (this.child) {
      return this.current.state === 'running';
    }
    const port = portSetting();
    const args = [this.script, ...serverArguments(), '--port', String(port)];
    const first = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file');
    this.output.info(`Starting: x4-script-mcp ${args.slice(1).join(' ')}`);
    this.stopping = false;
    this.setState({ state: 'starting' });
    // The editor's executable runs as Node.js with this variable; Node.js itself ignores it.
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(first ? { cwd: first.uri.fsPath } : {}),
      windowsHide: true,
    });
    this.child = child;
    let lastLine = '';
    await new Promise<void>((resolve) => {
      let pending = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines.filter((each) => each !== '')) {
          this.output.info(line);
          lastLine = line;
          const listening = /listening on (http:\S+)/.exec(line);
          if (listening && this.child === child) {
            this.setState({ state: 'running', url: listening[1] });
            resolve();
          }
        }
      });
      child.once('error', (error) => {
        lastLine = error.message;
        this.output.error(`Cannot start: ${error.message}`);
      });
      child.once('exit', (code) => {
        if (this.child === child) {
          this.child = undefined;
          this.setState({ state: 'stopped' });
        }
        this.output.info(`Stopped${code === null ? '' : ` with exit code ${code}`}.`);
        if (!this.stopping) {
          // Another VS Code window may run it: a port of its own for this one.
          const taken = / is in use/.test(lastLine);
          const message = `The X4CodeSense MCP server stopped: ${lastLine.replace(/^x4-script-mcp: /, '')}${taken ? '. Another window may run it; or choose another port.' : ''}`;
          void vscode.window.showErrorMessage(message, ...(taken ? ['Change Port'] : []), 'Show Output').then((picked) => {
            if (picked === 'Change Port') {
              void vscode.commands.executeCommand('workbench.action.openSettings', 'x4CodeSense.mcpServer.port');
            } else if (picked === 'Show Output') {
              this.output.show(true);
            }
          });
        }
        resolve();
      });
    });
    return this.current.state === 'running';
  }

  /** Stops it, if it runs; resolves once it has exited. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
  }

  private async restart(): Promise<void> {
    this.output.info('The settings changed: starting again.');
    await this.stop();
    await this.start();
  }

  dispose(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = undefined;
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

/** The server and its commands: start, stop, copy the URL. */
export function registerMcpHttpServer(context: vscode.ExtensionContext): { server: McpHttpServer; disposables: vscode.Disposable[] } {
  const output = vscode.window.createOutputChannel('X4CodeSense MCP Server', { log: true });
  const server = new McpHttpServer(context.asAbsolutePath(path.join('dist', 'x4-script-mcp.js')), output);
  const copy = async (): Promise<void> => {
    await vscode.env.clipboard.writeText(server.url);
    void vscode.window.showInformationMessage(`Copied ${server.url}`);
  };
  return {
    server,
    disposables: [
      output,
      server,
      vscode.commands.registerCommand('x4CodeSense.startMcpServer', async () => {
        if (server.state.state === 'running') {
          void vscode.window.showInformationMessage(`The X4CodeSense MCP server runs at ${server.url}`, 'Copy URL').then((picked) => picked && copy());
          return;
        }
        if (await server.start()) {
          const picked = await vscode.window.showInformationMessage(`The X4CodeSense MCP server runs at ${server.url}`, 'Copy URL', 'Show Output');
          if (picked === 'Copy URL') {
            await copy();
          } else if (picked === 'Show Output') {
            output.show(true);
          }
        }
      }),
      vscode.commands.registerCommand('x4CodeSense.stopMcpServer', () => server.stop()),
      vscode.commands.registerCommand('x4CodeSense.copyMcpServerUrl', copy),
      vscode.commands.registerCommand('x4CodeSense.showMcpServerOutput', () => output.show(true)),
    ],
  };
}
