/**
 * End-to-end test: bundle the checker and run it on a temporary extension folder,
 * with and without the fixture schemas of the core package.
 */
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../src/cli.ts');
const coreEntry = path.resolve(here, '../../core/src/index.ts');
const fixtureUnpacked = path.resolve(here, '../../core/tests/fixtures/unpacked');

let workDir: string;
let bundle: string;
let extension: string;
/** The fixture game files, with game scripts the extension's patches change. */
let unpacked: string;

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
  unpacked = path.join(mkdtempSync(path.join(tmpdir(), 'x4codesense-cli-game-')), 'unpacked');
  cpSync(fixtureUnpacked, unpacked, { recursive: true });
  mkdirSync(path.join(unpacked, 'md'));
  writeFileSync(path.join(unpacked, 'md', 'patch.xml'), '<mdscript name="Patched">\n  <cues/>\n</mdscript>\n');
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
  rmSync(path.dirname(unpacked), { recursive: true, force: true });
});

// Each test starts the checker, which reads the schemas; under a full parallel run that takes seconds.
describe('x4-script-check', { timeout: 30_000 }, () => {
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
        `${invalid}:5:8: Element 'conditions' is not allowed after 'actions' in 'cue'. Expected 'cues', 'patch' [invalid-child-element]`,
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 3 finding(s)',
      ]);

      const withoutStructure = await run('--unpacked', unpacked, '--no-structure', extension);
      expect(withoutStructure.code).toBe(1);
      expect(lines(withoutStructure).length).toBe(3);
    });
  });

  it('checks text references against the game texts and the extension texts', async () => {
    const texts = path.join(extension, 't');
    mkdirSync(texts, { recursive: true });
    const script = path.join(extension, 'md', 'Texts.xml');
    const line = '        <debug_text text="{1001,1} + {90001,1} + {90001,2}"/>';
    const text = `<mdscript name="Texts">\n  <cues>\n    <cue name="A">\n      <actions>\n${line}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;
    try {
      writeFileSync(path.join(texts, '0001-l044.xml'), '<diff><add sel="/language"><page id="90001"><t id="1">Mine</t></page></add></diff>\n');
      await withFile(script, text, async () => {
        const result = await run('--unpacked', unpacked, extension);
        expect(result.code).toBe(1);
        expect(lines(result)).toEqual([
          `${script}:5:${line.indexOf('{90001,2}') + 1}: Text 2 does not exist on page 90001 [text-undefined]`,
          '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 1 finding(s)',
        ]);
      });
    } finally {
      rmSync(texts, { recursive: true, force: true });
    }
  });

  it('reads other extensions for references without checking them', async () => {
    const dependency = path.join(workDir, 'dependencies', 'dep_mod');
    mkdirSync(path.join(dependency, 'aiscripts'), { recursive: true });
    // A broken script there would be a finding if the folder were checked.
    writeFileSync(
      path.join(dependency, 'aiscripts', 'lib.dep.xml'),
      '<aiscript name="lib.dep">\n  <interrupts>\n    <library>\n      <handler name="DepHandler"/>\n    </library>\n  </interrupts>\n  <attention min="1"><actions><bogus/></actions></attention>\n</aiscript>\n'
    );
    const user = path.join(extension, 'aiscripts', 'order.user.xml');
    await withFile(
      user,
      '<aiscript name="order.user">\n  <interrupts>\n    <handler ref="DepHandler"/>\n  </interrupts>\n  <attention min="1"><actions/></attention>\n</aiscript>\n',
      async () => {
        const alone = await run('--unpacked', unpacked, extension);
        expect(alone.code).toBe(1);
        expect(lines(alone)).toEqual([
          `${user}:3:19: Interrupt handler 'DepHandler' is not defined in any known script [library-undefined]`,
          '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 1 finding(s)',
        ]);
        const withDependency = await run('--unpacked', unpacked, '--extensions', path.dirname(dependency), extension);
        expect(withDependency.code).toBe(0);
        expect(lines(withDependency)).toEqual(['4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 0 finding(s)']);
        expect((await run('--unpacked', unpacked, `--extensions=${path.join(workDir, 'missing')}`, extension)).code).toBe(2);
        expect((await run('--unpacked', unpacked, extension, '--extensions')).code).toBe(2);
      }
    ).finally(() => rmSync(path.dirname(dependency), { recursive: true, force: true }));
  });

  it('checks patches against the files they change', async () => {
    const other = path.join(extension, 'md', 'other.xml');
    const otherText = `<diff><remove sel="//cue[@name='Missing']"/></diff>\n`;
    const nowhere = path.join(extension, 'md', 'nowhere.xml');
    const nested = path.join(extension, 'extensions', 'absent_mod', 'md', 'gone.xml');
    writeFileSync(path.join(unpacked, 'md', 'other.xml'), '<mdscript name="Other">\n  <cues/>\n</mdscript>\n');
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, `<diff><remove sel="//cue"/></diff>\n`);
    try {
      await withFile(other, otherText, () =>
        withFile(nowhere, `<diff><remove sel="//cue"/></diff>\n`, async () => {
          const result = await run('--unpacked', unpacked, extension);
          expect(result.code).toBe(1);
          expect(lines(result).sort()).toEqual(
            [
              `${nested}:1:2: Nothing to patch: the extension 'absent_mod' is not among the extensions read [patch-target-missing]`,
              `${nowhere}:1:2: Nothing to patch: the game has no md/nowhere.xml [patch-target-missing]`,
              `${other}:1:${otherText.indexOf('//cue') + 1}: No matching node in md/other.xml: 'cue[@name='Missing']' selects nothing [patch-no-match]`,
              '6 file(s) in 3 folder(s): 2 script(s), 4 patch(es), 3 finding(s)',
            ].sort()
          );
        })
      );
    } finally {
      rmSync(path.join(extension, 'extensions'), { recursive: true, force: true });
      rmSync(path.join(unpacked, 'md', 'other.xml'));
    }
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
