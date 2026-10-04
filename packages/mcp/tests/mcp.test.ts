/**
 * End-to-end test: bundle the MCP server, start it on standard input and output as a client does, on
 * the fixture game files and a temporary extension, and call its tools.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(here, '../src/main.ts');
const coreEntry = path.resolve(here, '../../core/src/index.ts');
const catalogEntry = path.resolve(here, '../../catalog/src/index.ts');
const fixtureUnpacked = path.resolve(here, '../../core/tests/fixtures/unpacked');

let workDir: string;
let bundle: string;
let unpacked: string;
/** A folder of extensions: `mod_a`, whose scripts refer to each other. */
let extensions: string;
let caller: string;
let target: string;
/** The server on the fixture game and the extensions. */
let client: Client;

const callerText = `<?xml version="1.0" encoding="utf-8"?>
<mdscript name="Caller">
  <cues>
    <cue name="Start">
      <actions>
        <signal_cue_instantly cue="md.Target.Wanted" />
        <set_value name="$count" exact="player.ship.cargo.list.count" />
      </actions>
    </cue>
  </cues>
</mdscript>
`;

const targetText = `<?xml version="1.0" encoding="utf-8"?>
<mdscript name="Target">
  <cues>
    <cue name="Wanted">
      <actions />
    </cue>
  </cues>
</mdscript>
`;

interface ToolResult {
  error: boolean;
  text: string;
}

async function connect(args: readonly string[], env: Record<string, string> = {}, cwd?: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle, ...args],
    env: { ...getDefaultEnvironment(), ...env },
    stderr: 'ignore',
    ...(cwd ? { cwd } : {}),
  });
  const connected = new Client({ name: 'x4-script-mcp-test', version: '0' });
  await connected.connect(transport);
  return connected;
}

async function callOn(on: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await on.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { error: result.isError === true, text: content.map((part) => part.text).join('\n') };
}

/** Calls a tool on the main server and returns its answer, which must not be an error. */
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await callOn(client, name, args);
  expect(result.error, result.text).toBe(false);
  return JSON.parse(result.text) as T;
}

interface Place {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text?: string;
  game?: boolean;
}

interface CheckReport {
  findings: (Partial<Place> & {
    file: string;
    severity: string;
    code: string;
    message: string;
    fixes: { title: string; preferred: boolean; edits: (Place & { newText: string })[] }[];
  })[];
  summary: { files: number; scripts: number; patches: number; findings: number; errors: number; warnings: number; schemaValidation: boolean };
}

interface FoundName extends Place {
  name: string;
  qualified: string;
  kind: string;
  in: string;
}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'x4codesense-mcp-'));
  bundle = path.join(workDir, 'x4-script-mcp.js');
  await build({
    entryPoints: [mainEntry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
    alias: { 'x4-script-core': coreEntry, 'x4-catalog': catalogEntry },
  });
  unpacked = path.join(workDir, 'unpacked');
  cpSync(fixtureUnpacked, unpacked, { recursive: true });
  extensions = path.join(workDir, 'extensions');
  const mod = path.join(extensions, 'mod_a');
  mkdirSync(path.join(mod, 'md'), { recursive: true });
  writeFileSync(path.join(mod, 'content.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<content id="mod_a" name="Mod A" version="100" save="0" />\n');
  caller = path.join(mod, 'md', 'caller.xml');
  target = path.join(mod, 'md', 'target.xml');
  writeFileSync(caller, callerText);
  writeFileSync(target, targetText);
  client = await connect(['--unpacked', unpacked, '--extensions', extensions]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  rmSync(workDir, { recursive: true, force: true });
});

// The first call reads the game files; under a full parallel run that takes seconds.
describe('x4-script-mcp', { timeout: 30_000 }, () => {
  it('offers its tools, all read only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'check',
      'describe_element',
      'expression_type',
      'find',
      'definition',
      'references',
      'hover',
      'text',
      'status',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(client.getInstructions()).toContain('describe_element');
  });

  it('tells what it read', async () => {
    const status = await call<Record<string, unknown>>('status');
    expect(status).toMatchObject({ game: unpacked, gameKind: 'extracted', loaded: true, extensions: [extensions], schemas: ['aiscripts', 'md'] });
    expect(status.indexedFiles).toBe(2);
    // The fixture's script properties import from files it does not have.
    expect(status.problems).toEqual(expect.arrayContaining([expect.stringContaining('is missing')]));
  });

  describe('check', () => {
    it('passes a clean extension folder, with the counts', async () => {
      const report = await call<CheckReport>('check', { paths: [extensions] });
      expect(report.findings).toEqual([]);
      expect(report.summary).toMatchObject({ files: 2, scripts: 2, patches: 0, findings: 0, schemaValidation: true });
    });

    it('checks a text as if it were the file, with places from 1 and the quick fixes', async () => {
      const text = callerText.replace('<set_value name="$count"', '<set_value nme="$count"');
      const report = await call<CheckReport>('check', { paths: [caller], text });
      const unknown = report.findings.find((finding) => finding.code === 'unknown-attribute');
      expect(unknown).toMatchObject({ file: caller, line: 7, column: 20, endLine: 7, endColumn: 23, severity: 'error' });
      expect(unknown?.fixes.map((fix) => fix.title)).toContain("Change to 'name'");
      expect(unknown?.fixes.find((fix) => fix.title === "Change to 'name'")?.edits).toEqual([
        { line: 7, column: 20, endLine: 7, endColumn: 23, newText: 'name' },
      ]);
    });

    it('finds what a cue reference names in another file of the extensions', async () => {
      const text = callerText.replace('md.Target.Wanted', 'md.Target.Unwanted');
      const report = await call<CheckReport>('check', { paths: [caller], text });
      expect(report.findings.map((finding) => finding.code)).toContain('cue-undefined');
    });

    it('reports only findings as severe as asked', async () => {
      const text = callerText.replace('<cue name="Start">', '<cue name="Start">\n      <conditions><check_value value="$never" /></conditions>');
      const all = await call<CheckReport>('check', { paths: [caller], text });
      const errors = await call<CheckReport>('check', { paths: [caller], text, severity: 'error' });
      expect(all.findings.length).toBeGreaterThan(errors.findings.length);
      expect(errors.findings.every((finding) => finding.severity === 'error')).toBe(true);
    });

    it('refuses a text with several paths, and a path that is not there', async () => {
      expect(await callOn(client, 'check', { paths: [caller, target], text: '<mdscript/>' })).toMatchObject({ error: true });
      const missing = await callOn(client, 'check', { paths: [path.join(extensions, 'nothing.xml')] });
      expect(missing).toMatchObject({ error: true });
      expect(missing.text).toContain('Not found');
    });

    it('works while typing: a half-typed element and an unquoted value', async () => {
      const text = callerText.replace('<signal_cue_instantly cue="md.Target.Wanted" />', '<signal_cue_instantly cue=md.Target.Wanted');
      const report = await call<CheckReport>('check', { paths: [caller], text });
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings.some((finding) => finding.fixes.length > 0)).toBe(true);
    });
  });

  describe('describe_element', () => {
    it('gives the attributes with their types and whether they are expressions, and the children', async () => {
      const element = await call<{ element: string; attributes: { name: string; type: string; required: boolean; expression: boolean; values?: string[] }[] }>(
        'describe_element',
        { name: 'set_value', script: 'md' }
      );
      expect(element.element).toBe('set_value');
      expect(element.attributes.find((attribute) => attribute.name === 'name')).toMatchObject({ type: 'lvalueexpression', required: true, expression: true });
      expect(element.attributes.find((attribute) => attribute.name === 'operation')).toMatchObject({ required: false, values: ['set', 'add', 'subtract'] });
      const cue = await call<{ children: string[] }>('describe_element', { name: 'cue', script: 'md' });
      expect(cue.children).toEqual(expect.arrayContaining(['conditions', 'actions', 'cues']));
    });

    it('takes the declaration under a parent, and one attribute in full', async () => {
      const param = await call<{ attributes: { name: string }[] }>('describe_element', { name: 'param', script: 'md', parent: 'params' });
      expect(param.attributes.map((attribute) => attribute.name)).toContain('name');
      const operation = await call<{ attribute: { values: { value: string }[] } }>('describe_element', {
        name: 'set_value',
        script: 'md',
        attribute: 'operation',
      });
      expect(operation.attribute.values.map((value) => value.value)).toEqual(['set', 'add', 'subtract']);
    });

    it('names similar elements for one it does not know', async () => {
      const unknown = await callOn(client, 'describe_element', { name: 'setvalue', script: 'md' });
      expect(unknown.error).toBe(true);
      expect(unknown.text).toContain('set_value');
      const notAllowed = await callOn(client, 'describe_element', { name: 'cue', script: 'md', parent: 'actions' });
      expect(notAllowed.error).toBe(true);
      expect(notAllowed.text).toContain('does not allow');
    });
  });

  describe('expression_type', () => {
    it('resolves a chain step by step, with the properties of the result', async () => {
      const result = await call<{ steps: { step: string; type?: string }[]; result: { datatype: string; supertypes: string[] }; properties: string[] }>(
        'expression_type',
        { expression: 'player.ship.sector' }
      );
      expect(result.steps.map((step) => [step.step, step.type])).toEqual([
        ['player', undefined],
        ['ship', 'ship'],
        ['sector', 'sector'],
      ]);
      expect(result.result).toEqual({ datatype: 'sector', supertypes: ['component'] });
      expect(result.properties).toEqual(expect.arrayContaining(['ships → list', 'exists → boolean']));
    });

    it('lists the properties of a datatype, and filtered ones in full, those of derived types too', async () => {
      const container = await call<{ supertypes: string[]; properties: string[]; derivedTypeProperties: number }>('expression_type', { datatype: 'container' });
      expect(container.supertypes).toEqual(['object', 'component']);
      expect(container.properties).toContain('cargo.{$ware}.count → integer');
      expect(container.properties).not.toContain('pilot → entity');
      expect(container.derivedTypeProperties).toBeGreaterThan(0);
      const filtered = await call<{ properties: { name: string; of: string; description: string }[] }>('expression_type', {
        datatype: 'container',
        filter: 'pilot',
      });
      expect(filtered.properties).toEqual([{ name: 'pilot', of: 'ship', type: 'entity', description: 'Pilot of the ship' }]);
    });

    it('refuses what is no chain, and a datatype it does not know', async () => {
      expect(await callOn(client, 'expression_type', { expression: 'player.ship +' })).toMatchObject({ error: true });
      const unknown = await callOn(client, 'expression_type', { datatype: 'shipp' });
      expect(unknown.error).toBe(true);
      expect(unknown.text).toContain('ship');
      expect(await callOn(client, 'expression_type', {})).toMatchObject({ error: true });
    });
  });

  describe('find, definition and references', () => {
    it('finds cues and scripts by name, with their places and lines', async () => {
      const names = await call<FoundName[]>('find', { query: 'Wanted' });
      expect(names).toEqual([
        {
          name: 'Wanted',
          qualified: 'md.Target.Wanted',
          kind: 'cue',
          in: 'md.Target (mod_a)',
          file: target,
          line: 4,
          column: 16,
          endLine: 4,
          endColumn: 22,
          text: '<cue name="Wanted">',
        },
      ]);
      const scripts = await call<FoundName[]>('find', { query: 'md.Caller' });
      expect(scripts[0]).toMatchObject({ name: 'Caller', kind: 'mdscript', file: caller });
    });

    it('says so when no name contains the query', async () => {
      const found = await call<{ note?: string } | FoundName[]>('find', { query: 'Nowhere' });
      expect(Array.isArray(found) ? found : found.note).toBeTruthy();
      expect(Array.isArray(found) ? found.length : 0).toBe(0);
    });

    it('goes from a cue reference to its definition and back', async () => {
      const definition = await call<{ definition: Place[] }>('definition', { file: caller, line: 6, column: 48 });
      // At the start of the cue, as the editor's go to definition into another file.
      expect(definition.definition).toEqual([{ file: target, line: 4, column: 5, endLine: 4, endColumn: 5, text: '<cue name="Wanted">' }]);
      const references = await call<{ references: Place[] }>('references', { file: target, line: 4, column: 18 });
      expect(references.references.map((place) => [place.file, place.line])).toEqual(expect.arrayContaining([[caller, 6]]));
    });

    it('goes to a property in scriptproperties.xml, a file of the game', async () => {
      const definition = await call<{ definition: Place[] }>('definition', { file: caller, line: 7, column: 49 });
      expect(definition.definition).toHaveLength(1);
      expect(definition.definition[0]).toMatchObject({ file: path.join(unpacked, 'libraries', 'scriptproperties.xml'), game: true });
      expect(definition.definition[0].text).toContain('name="ship"');
    });

    it('describes a place as the editor’s hover does, with the range it covers', async () => {
      const element = await call<Record<string, unknown>>('hover', { file: caller, line: 6, column: 10 });
      expect(element).toEqual({
        hover: '**\\<signal\\_cue\\_instantly\\>**\n\nRequired attributes: `cue`\n\n*Defined in md.xsd*',
        line: 6,
        column: 10,
        endLine: 6,
        endColumn: 30,
      });
      const property = await call<Record<string, unknown>>('hover', { file: caller, line: 7, column: 49 });
      expect(property).toMatchObject({ line: 7, column: 48, endColumn: 52 });
      expect(property.hover).toContain('**player.ship**');
      expect(property.hover).toContain('Type: `ship`');
      const cue = await call<Record<string, unknown>>('hover', { file: caller, line: 6, column: 48 });
      expect(cue.hover).toBe('**Wanted** *(cue of Target)*\n\nIn target.xml of `mod_a`, line 4');
    });

    it('describes a text reference, and a place of a script still being typed', async () => {
      const typing = path.join(path.dirname(caller), 'typing.xml');
      writeFileSync(typing, '<mdscript name="Typing">\n  <cues>\n    <cue name="A">\n      <actions>\n        <debug_text text="{1001, 4} + player.');
      try {
        const text = await call<Record<string, unknown>>('hover', { file: typing, line: 5, column: 30 });
        expect(text.hover).toContain('Hull and Shield');
        expect(text).toMatchObject({ line: 5, column: 27 });
        const keyword = await call<Record<string, unknown>>('hover', { file: typing, line: 5, column: 41 });
        expect(keyword.hover).toContain('**player**');
      } finally {
        rmSync(typing, { force: true });
      }
    });

    it('says so when nothing is named at the place', async () => {
      const nothing = await call<{ definition: Place[]; note: string }>('definition', { file: caller, line: 1, column: 1 });
      expect(nothing.definition).toEqual([]);
      expect(nothing.note).toContain('line 1, column 1');
      const noHover = await call<{ hover?: string; note: string }>('hover', { file: caller, line: 1, column: 1 });
      expect(noHover).toEqual({ note: 'Nothing at line 1, column 1 has a description known here.' });
    });
  });

  describe('text', () => {
    it('shows a text as the game does, and how it is written', async () => {
      const text = await call<Record<string, unknown>>('text', { page: 1001, id: 4 });
      expect(text).toMatchObject({ page: 1001, id: 4, language: '44', text: 'Hull and Shield', written: '{1001,1} and {1001, 2}', pageTitle: 'Interface' });
      expect(text.languages).toEqual(['44']);
      const german = await call<Record<string, unknown>>('text', { page: 1001, id: 1, language: '49' });
      expect(german).toMatchObject({ language: '49', text: 'Hülle', languages: ['49', '44'] });
    });

    it('lists a page, searches the texts, and says what is missing', async () => {
      const page = await call<{ title: string; texts: { id: number }[]; more?: number }>('text', { page: 1001, limit: 3 });
      expect(page.title).toBe('Interface');
      expect(page.texts.map((text) => text.id)).toEqual([1, 2, 3]);
      expect(page.more).toBe(4);
      const found = await call<{ texts: { page: number; id: number }[] }>('text', { search: 'SOLD to' });
      expect(found.texts).toMatchObject([{ page: 2000, id: 1 }]);
      const missing = await callOn(client, 'text', { page: 1001, id: 999 });
      expect(missing.error).toBe(true);
    });
  });

  describe('files changed on disk', () => {
    it('sees a script written, changed and deleted, without waiting', async () => {
      const added = path.join(extensions, 'mod_a', 'md', 'added.xml');
      writeFileSync(added, '<mdscript name="Added">\n  <cues>\n    <cue name="FirstVersion" />\n  </cues>\n</mdscript>\n');
      expect((await call<FoundName[]>('find', { query: 'FirstVersion' })).map((name) => name.qualified)).toEqual(['md.Added.FirstVersion']);
      writeFileSync(added, '<mdscript name="Added">\n  <cues>\n    <cue name="SecondVersion" />\n  </cues>\n</mdscript>\n');
      expect((await call<FoundName[]>('find', { query: 'SecondVersion' })).map((name) => name.qualified)).toEqual(['md.Added.SecondVersion']);
      rmSync(added);
      const gone = await call<{ note?: string } | FoundName[]>('find', { query: 'SecondVersion' });
      expect(Array.isArray(gone) ? gone : []).toEqual([]);
    });

    it('checks a file against what another file says now', async () => {
      writeFileSync(target, targetText.replace('Wanted', 'Renamed'));
      try {
        const report = await call<CheckReport>('check', { paths: [caller] });
        expect(report.findings.map((finding) => finding.code)).toContain('cue-undefined');
      } finally {
        writeFileSync(target, targetText);
      }
      expect((await call<CheckReport>('check', { paths: [caller] })).findings).toEqual([]);
    });

    it('reads an extension added to the folder of extensions', async () => {
      const mod = path.join(extensions, 'mod_b');
      mkdirSync(path.join(mod, 'md'), { recursive: true });
      writeFileSync(path.join(mod, 'content.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<content id="mod_b" name="Mod B" version="100" save="0" />\n');
      writeFileSync(path.join(mod, 'md', 'other.xml'), '<mdscript name="Other">\n  <cues>\n    <cue name="InModB" />\n  </cues>\n</mdscript>\n');
      try {
        expect((await call<FoundName[]>('find', { query: 'InModB' })).map((name) => name.in)).toEqual(['md.Other (mod_b)']);
      } finally {
        rmSync(mod, { recursive: true, force: true });
      }
    });
  });
});

describe('x4-script-mcp without game files', { timeout: 30_000 }, () => {
  let bare: Client;

  beforeAll(async () => {
    bare = await connect(['--extensions', extensions]);
  });

  afterAll(async () => {
    await bare?.close();
  });

  it('checks well-formedness and says what needs the game', async () => {
    const report = await callOn(bare, 'check', { paths: [caller], text: '<mdscript name="X"><cues><cue name="A"></cues></mdscript>' });
    expect(report.error).toBe(false);
    expect((JSON.parse(report.text) as CheckReport).findings.map((finding) => finding.code)).toContain('missing-end-tag');
    expect((JSON.parse(report.text) as CheckReport).summary.schemaValidation).toBe(false);
    const element = await callOn(bare, 'describe_element', { name: 'cue', script: 'md' });
    expect(element.error).toBe(true);
    expect(element.text).toContain('No game files');
  });
});

describe('x4-script-mcp options', { timeout: 30_000 }, () => {
  it('reads the game from X4_UNPACKED and takes the current folder as the extensions', async () => {
    const fromEnvironment = await connect([], { X4_UNPACKED: unpacked }, path.join(extensions, 'mod_a'));
    try {
      const status = JSON.parse((await callOn(fromEnvironment, 'status')).text) as Record<string, unknown>;
      expect(status).toMatchObject({ game: unpacked, loaded: true, extensions: [path.join(extensions, 'mod_a')] });
    } finally {
      await fromEnvironment.close();
    }
  });

  it('logs each call on standard error, a text to check by its length', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, '--unpacked', unpacked, '--extensions', extensions],
      env: getDefaultEnvironment(),
      stderr: 'pipe',
    });
    let log = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    const logged = new Client({ name: 'x4-script-mcp-test', version: '0' });
    await logged.connect(transport);
    try {
      await callOn(logged, 'describe_element', { name: 'cue', script: 'md' });
      await callOn(logged, 'describe_element', { name: 'nothing', script: 'md' });
      await callOn(logged, 'check', { paths: [caller], text: callerText });
      expect(log).toMatch(/x4-script-mcp: describe_element \{"name":"cue","script":"md"\} in \d+ ms: \d+ characters/);
      expect(log).toMatch(/x4-script-mcp: describe_element \{"name":"nothing","script":"md"\} in \d+ ms: error: md\.xsd declares no element <nothing>/);
      expect(log).toContain(`"text":"(${callerText.length} characters)"`);
    } finally {
      await logged.close();
    }
  });

  it('reports a game folder that is not one, and keeps answering', async () => {
    const wrong = await connect(['--game', extensions, '--extensions', extensions]);
    try {
      const status = JSON.parse((await callOn(wrong, 'status')).text) as { loaded: boolean; problems: string[] };
      expect(status.loaded).toBe(false);
      expect(status.problems[0]).toContain('Not an installed game');
    } finally {
      await wrong.close();
    }
  });

  it('exits with 2 and the usage on an unknown option, with 0 on --help', async () => {
    const run = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundle, ...args]);
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
      }
    };
    const unknown = await run('--verbose');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown argument --verbose');
    expect(unknown.stderr).toContain('Usage: x4-script-mcp');
    const help = await run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--extensions <folder>');
    expect((await run('--language', 'en')).code).toBe(2);
    expect((await run('--port', 'http')).code).toBe(2);
  });
});

describe('x4-script-mcp over HTTP', { timeout: 30_000 }, () => {
  let server: ChildProcess;
  let url: string;
  /** What the server wrote on standard error. */
  let log = '';

  beforeAll(async () => {
    server = spawn(process.execPath, [bundle, '--port', '0', '--unpacked', unpacked, '--extensions', extensions], { stdio: ['ignore', 'ignore', 'pipe'] });
    url = await new Promise<string>((resolve, reject) => {
      server.stderr?.on('data', (chunk: Buffer) => {
        log += chunk.toString();
        const listening = /listening on (http:\S+)/.exec(log);
        if (listening) {
          resolve(listening[1]);
        }
      });
      server.once('exit', (code) => reject(new Error(`exited with ${code}: ${log}`)));
    });
  });

  afterAll(() => {
    server?.kill();
  });

  async function connectHttp(): Promise<Client> {
    const connected = new Client({ name: 'x4-script-mcp-http-test', version: '0' });
    await connected.connect(new StreamableHTTPClientTransport(new URL(url)));
    return connected;
  }

  it('serves the tools on 127.0.0.1, one session per client on the same game files', async () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const first = await connectHttp();
    const second = await connectHttp();
    try {
      expect((await first.listTools()).tools.map((tool) => tool.name)).toContain('hover');
      const status = JSON.parse((await callOn(second, 'status')).text) as Record<string, unknown>;
      expect(status).toMatchObject({ game: unpacked, loaded: true });
      const hover = JSON.parse((await callOn(first, 'hover', { file: caller, line: 6, column: 10 })).text) as { hover: string };
      expect(hover.hover).toContain('signal\\_cue\\_instantly');
    } finally {
      await first.close();
      await second.close();
    }
    expect(log).toMatch(/session \S+ opened \(2 open\)/);
  });

  it('refuses a request for another host name, from a page elsewhere, or without a session', async () => {
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    const post = (headers: Record<string, string>, body = initialize): Promise<number> =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          url,
          { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          }
        );
        request.on('error', reject);
        request.end(body);
      });
    expect(await post({ Host: 'attacker.example:80' })).toBe(403);
    expect(await post({ Origin: 'https://attacker.example' })).toBe(403);
    expect(await post({}, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toBe(400);
    expect(await post({ 'Mcp-Session-Id': 'nonsense' }, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))).toBe(404);
  });

  it('exits with 1 when the port is taken', async () => {
    const port = new URL(url).port;
    const taken = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const second = spawn(process.execPath, [bundle, '--port', port, '--unpacked', unpacked], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      second.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      second.once('exit', (code) => resolve({ code, stderr }));
    });
    expect(taken.code).toBe(1);
    expect(taken.stderr).toContain(`port ${port} on 127.0.0.1 is in use`);
  });
});
