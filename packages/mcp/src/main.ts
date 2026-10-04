#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { httpHost, httpPath, serveHttp } from './http';
import { createServer } from './tools';
import { Workspace, type WorkspaceOptions } from './workspace';

const usage = `Usage: x4-script-mcp [options]

An MCP server on standard input and output, or with --port on http://127.0.0.1:<port>/mcp: what
X4CodeSense knows of X4 scripts, as tools for AI agents. The game files are read on the first call,
over HTTP at once; the extensions' files again whenever they change.

Options:
  --unpacked <folder>   extracted vanilla game files, the folder holding libraries, md and aiscripts
  --game <folder>       the installed game, the folder of X4.exe: its files and its DLCs' are read
                        from their catalogs, nothing is extracted; used when --unpacked is not given
                        Without either, the X4_UNPACKED environment variable is read, else X4_GAME.
  --extensions <folder> an extension, or a folder of extensions, whose scripts and texts are read
                        besides the game's: those written and those they refer to; may be given
                        several times (default: the current folder)
  --language <number>   the language texts are shown in, 44 for English (default)
  --no-structure        do not check the order and completeness of child elements
  --no-type-guesses     type variables only by what the scripts and the schemas state, not by
                        guesses from the names and documentation of actions (create_ship: a ship)
  --port <number>       serve Streamable HTTP on 127.0.0.1 at this port, for agents given a URL;
                        0 picks a free port. Only clients on this machine are served
  -h, --help            show this help`;

/** The options that take a value. */
const valueOptions = new Set(['--unpacked', '--game', '--extensions', '--language', '--port']);

type Options = WorkspaceOptions & { help: boolean; port?: number };

function parseOptions(argv: string[]): Options {
  const options: Options = { extensions: [], language: '44', structure: true, typeGuesses: true, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (valueOptions.has(name)) {
      const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
      if (value === undefined) {
        throw new Error(`${name} needs ${name === '--language' || name === '--port' ? 'a number' : 'a folder'}`);
      }
      if (name === '--unpacked') {
        options.unpacked = value;
      } else if (name === '--game') {
        options.game = value;
      } else if (name === '--extensions') {
        options.extensions.push(value);
      } else if (name === '--port') {
        if (!/^\d+$/.test(value) || Number(value) > 65535) {
          throw new Error(`--port needs a number from 0 to 65535, not '${value}'`);
        }
        options.port = Number(value);
      } else if (/^\d+$/.test(value)) {
        // As the text files name it: 049 is 49.
        options.language = String(Number(value));
      } else {
        throw new Error(`--language needs a number, not '${value}'`);
      }
    } else if (argument === '--no-structure') {
      options.structure = false;
    } else if (argument === '--no-type-guesses') {
      options.typeGuesses = false;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (options.extensions.length === 0) {
    options.extensions.push('.');
  }
  // The environment only when the command line names no game: an option given wins over either variable.
  if (options.unpacked === undefined && options.game === undefined) {
    const unpacked = process.env.X4_UNPACKED;
    const installed = process.env.X4_GAME;
    if (unpacked !== undefined && unpacked !== '') {
      options.unpacked = unpacked;
    } else if (installed !== undefined && installed !== '') {
      options.game = installed;
    }
  }
  return options;
}

/** The server's version, set where the VS Code extension bundles it: its package.json there is the extension's. */
declare const X4_SCRIPT_MCP_VERSION: string | undefined;

/** The server's version from its package manifest, when it runs from the installed package, or from its bundle. */
function serverVersion(): string | undefined {
  if (typeof X4_SCRIPT_MCP_VERSION === 'string') {
    return X4_SCRIPT_MCP_VERSION;
  }
  try {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return manifest.name === 'x4-script-mcp' && typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the game files and the extensions now, and logs what was read. */
function readNow(workspace: Workspace): void {
  workspace.current();
  for (const problem of workspace.problems.slice(0, 50)) {
    console.error(problem);
  }
  console.error(
    workspace.game
      ? `x4-script-mcp: read ${workspace.gameFolder} in ${(workspace.loadTime / 1000).toFixed(1)} s: ${workspace.game.index?.size ?? 0} script files, ${workspace.game.texts.textCount} texts`
      : 'x4-script-mcp: no game files read'
  );
}

/** Serves HTTP until the process is stopped; the game files are read at once, so the first call is quick. */
async function mainHttp(workspace: Workspace, port: number): Promise<number | undefined> {
  let served: Awaited<ReturnType<typeof serveHttp>>;
  try {
    served = await serveHttp(workspace, serverVersion(), port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === 'EADDRINUSE'
        ? `x4-script-mcp: port ${port} on ${httpHost} is in use, by another program or another x4-script-mcp`
        : `x4-script-mcp: cannot listen on ${httpHost}:${port}: ${error instanceof Error ? error.message : String(error)}`
    );
    workspace.dispose();
    return 1;
  }
  console.error(`x4-script-mcp: listening on http://${httpHost}:${served.port}${httpPath}`);
  const stop = (): void => {
    served.server.close();
    served.server.closeAllConnections();
    workspace.dispose();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  setImmediate(() => readNow(workspace));
  return undefined;
}

async function main(argv: string[]): Promise<number | undefined> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const workspace = new Workspace(options);
  if (options.port !== undefined) {
    return mainHttp(workspace, options.port);
  }
  const server = createServer(workspace, serverVersion());
  // Read once the client is ready, so the handshake is not kept waiting; a call before waits for it.
  server.server.oninitialized = () => {
    setImmediate(() => readNow(workspace));
  };
  server.server.onclose = () => workspace.dispose();
  await server.connect(new StdioServerTransport());
  return undefined;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) {
      process.exitCode = code;
    }
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  }
);
