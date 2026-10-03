#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createServer } from './tools';
import { Workspace, type WorkspaceOptions } from './workspace';

const usage = `Usage: x4-script-mcp [options]

An MCP server on standard input and output: what X4CodeSense knows of X4 scripts, as tools for AI
agents. The game files are read on the first call; the extensions' files again whenever they change.

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
  -h, --help            show this help`;

/** The options that take a value. */
const valueOptions = new Set(['--unpacked', '--game', '--extensions', '--language']);

function parseOptions(argv: string[]): WorkspaceOptions & { help: boolean } {
  const options: WorkspaceOptions & { help: boolean } = { extensions: [], language: '44', structure: true, typeGuesses: true, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (valueOptions.has(name)) {
      const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
      if (value === undefined) {
        throw new Error(`${name} needs ${name === '--language' ? 'a number' : 'a folder'}`);
      }
      if (name === '--unpacked') {
        options.unpacked = value;
      } else if (name === '--game') {
        options.game = value;
      } else if (name === '--extensions') {
        options.extensions.push(value);
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

async function main(argv: string[]): Promise<number | undefined> {
  let options: WorkspaceOptions & { help: boolean };
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
  const server = createServer(workspace, serverVersion());
  // Read once the client is ready, so the handshake is not kept waiting; a call before waits for it.
  server.server.oninitialized = () => {
    setImmediate(() => {
      workspace.current();
      for (const problem of workspace.problems.slice(0, 50)) {
        console.error(problem);
      }
      console.error(
        workspace.game
          ? `x4-script-mcp: read ${workspace.gameFolder} in ${(workspace.loadTime / 1000).toFixed(1)} s: ${workspace.game.index?.size ?? 0} script files, ${workspace.game.texts.textCount} texts`
          : 'x4-script-mcp: no game files read'
      );
    });
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
