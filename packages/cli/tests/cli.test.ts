/**
 * End-to-end test: bundle the checker and run it on a temporary extension folder,
 * with and without the fixture schemas of the core package.
 */
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../src/cli.ts');
const coreEntry = path.resolve(here, '../../core/src/index.ts');
const unpacked = path.resolve(here, '../../core/tests/fixtures/unpacked');

let workDir: string;
let bundle: string;
let extension: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundle, ...args], { env: { ...process.env, X4_UNPACKED: '' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

function lines(result: Run): string[] {
  return result.stdout.trim().split(/\r?\n/);
}

/** Writes a file for one test and removes it afterwards, whatever happens. */
async function withFile(file: string, content: string, body: () => Promise<void>): Promise<void> {
  writeFileSync(file, content);
  try {
    await body();
  } finally {
    rmSync(file);
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'x4codesense-cli-'));
  bundle = path.join(workDir, 'cli.js');
  await build({
    entryPoints: [cliEntry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
    alias: { 'x4-script-core': coreEntry },
  });
  extension = path.join(workDir, 'my_extension');
  mkdirSync(path.join(extension, 'md'), { recursive: true });
  mkdirSync(path.join(extension, 'aiscripts'), { recursive: true });
  writeFileSync(path.join(extension, 'md', 'Good.xml'), '<mdscript name="Good">\n  <cues/>\n</mdscript>\n');
  writeFileSync(path.join(extension, 'md', 'patch.xml'), '<diff><add sel="/mdscript/cues"><cue name="X"/></add></diff>\n');
  writeFileSync(
    path.join(extension, 'aiscripts', 'order.good.xml'),
    '<aiscript name="order.good">\n  <attention min="1"><actions/></attention>\n</aiscript>\n'
  );
}, 30_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('x4-script-check', () => {
  it('passes a clean extension and says that schemas were not used', async () => {
    const result = await run(extension);
    expect(result.code).toBe(0);
    expect(lines(result)).toEqual(['3 file(s) in 2 folder(s): 2 script(s), 1 patch(es), 0 finding(s) (no schema validation: pass --unpacked)']);
  });

  it('reports well-formedness problems with line and column', async () => {
    const broken = path.join(extension, 'md', 'Broken.xml');
    await withFile(broken, '<mdscript name="Broken">\n  <cues>\n    <cue name="A>\n      <actions/>\n  </cues>\n</mdscript>\n', async () => {
      const result = await run(extension);
      expect(result.code).toBe(1);
      expect(lines(result)).toEqual([
        `${broken}:3:15: Value of attribute 'name' is not closed [unclosed-attribute]`,
        `${broken}:3:5: Element 'cue' has no end tag [missing-end-tag]`,
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 2 finding(s) (no schema validation: pass --unpacked)',
      ]);
    });
  });

  it('reports a script in the wrong folder', async () => {
    const misplaced = path.join(extension, 'aiscripts', 'Misplaced.xml');
    await withFile(misplaced, '<mdscript name="Misplaced"/>\n', async () => {
      const result = await run(extension);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`${misplaced}: is a md script but lies in the aiscripts folder`);
    });
  });

  it('validates against the schemas of an unpacked folder', async () => {
    const clean = await run('--unpacked', unpacked, extension);
    expect(clean.code).toBe(0);
    expect(lines(clean)).toEqual(['3 file(s) in 2 folder(s): 2 script(s), 1 patch(es), 0 finding(s)']);

    const invalid = path.join(extension, 'md', 'Invalid.xml');
    const text =
      '<mdscript name="Invalid">\n  <cues>\n    <cue name="A" bogus="1">\n      <actions><set_value exact="1"/></actions>\n      <conditions/>\n    </cue>\n  </cues>\n</mdscript>\n';
    await withFile(invalid, text, async () => {
      const result = await run(`--unpacked=${unpacked}`, extension);
      expect(result.code).toBe(1);
      expect(lines(result)).toEqual([
        `${invalid}:3:19: Unknown attribute 'bogus' in 'cue' [unknown-attribute]`,
        `${invalid}:4:17: Missing required attribute 'name' in 'set_value' [missing-required-attribute]`,
        `${invalid}:5:8: Element 'conditions' is not allowed after 'actions' in 'cue'. Expected 'cues' [invalid-child-element]`,
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 3 finding(s)',
      ]);

      const withoutStructure = await run('--unpacked', unpacked, '--no-structure', extension);
      expect(withoutStructure.code).toBe(1);
      expect(lines(withoutStructure).length).toBe(3);
    });
  });

  it('finds extensions one level below the given folder', async () => {
    const result = await run(workDir);
    expect(result.code).toBe(0);
    expect(lines(result)).toEqual(['3 file(s) in 2 folder(s): 2 script(s), 1 patch(es), 0 finding(s) (no schema validation: pass --unpacked)']);
  });

  it('fails on a path that is not a folder and on unknown options', async () => {
    const missing = await run(path.join(workDir, 'missing'));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('Not a folder');

    const badUnpacked = await run('--unpacked', path.join(workDir, 'missing'), extension);
    expect(badUnpacked.code).toBe(2);
    expect(badUnpacked.stderr).toContain('Not a folder');

    const unknown = await run('--bogus');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown option --bogus');

    const help = await run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: x4-script-check');
  });
});
