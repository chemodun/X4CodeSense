/**
 * End-to-end test: bundle the checker and run it on a temporary extension folder.
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
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundle, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
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
  writeFileSync(path.join(extension, 'aiscripts', 'order.good.xml'), '<aiscript name="order.good">\n</aiscript>\n');
}, 30_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('x4-script-check', () => {
  it('passes a clean extension', async () => {
    const result = await run(extension);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('3 file(s) in 2 folder(s): 2 script(s), 1 patch(es), 0 finding(s)');
  });

  it('reports well-formedness problems with line and column', async () => {
    const broken = path.join(extension, 'md', 'Broken.xml');
    writeFileSync(broken, '<mdscript name="Broken">\n  <cues>\n    <cue name="A>\n      <actions/>\n  </cues>\n</mdscript>\n');
    try {
      const result = await run(extension);
      expect(result.code).toBe(1);
      const lines = result.stdout.trim().split(/\r?\n/);
      expect(lines).toEqual([
        `${broken}:3:15: Value of attribute 'name' is not closed [unclosed-attribute]`,
        `${broken}:3:5: Element 'cue' has no end tag [missing-end-tag]`,
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 2 finding(s)',
      ]);
    } finally {
      rmSync(broken);
    }
  });

  it('reports a script in the wrong folder', async () => {
    const misplaced = path.join(extension, 'aiscripts', 'Misplaced.xml');
    writeFileSync(misplaced, '<mdscript name="Misplaced"/>\n');
    try {
      const result = await run(extension);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`${misplaced}: is a md script but lies in the aiscripts folder`);
    } finally {
      rmSync(misplaced);
    }
  });

  it('finds extensions one level below the given folder', async () => {
    const result = await run(workDir);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('3 file(s) in 2 folder(s): 2 script(s), 1 patch(es), 0 finding(s)');
  });

  it('fails on a path that is not a folder', async () => {
    const result = await run(path.join(workDir, 'missing'));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Not a folder');
  });
});
