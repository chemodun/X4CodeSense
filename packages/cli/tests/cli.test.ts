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

/** Runs the checker in a folder, which matters to the paths of the GitHub format. */
async function runIn(cwd: string | undefined, ...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundle, ...args], { cwd, env: { ...process.env, X4_UNPACKED: '' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

function run(...args: string[]): Promise<Run> {
  return runIn(undefined, ...args);
}

interface JsonRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface JsonReport {
  findings: {
    file: string;
    line?: number;
    column?: number;
    range?: JsonRange;
    severity: string;
    code: string;
    message: string;
    fixes: { title: string; preferred: boolean; edits: { range: JsonRange; newText: string }[] }[];
  }[];
  summary: Record<string, number | boolean>;
  problems: string[];
}

/** The offset of an LSP position in a text. */
function offsetOf(text: string, position: { line: number; character: number }): number {
  const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((match) => (match.index ?? 0) + 1)];
  return (lineStarts[position.line] ?? text.length) + position.character;
}

/** A path as a property of a GitHub workflow command: forward slashes, and `%`, `:` and `,` escaped. */
function escapedPath(file: string): string {
  return file.split(path.sep).join('/').replace(/%/g, '%25').replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** Applies edits that do not overlap, the last first, so the earlier offsets stay right. */
function applied(text: string, edits: readonly { range: JsonRange; newText: string }[]): string {
  const spans = edits.map((edit) => ({ start: offsetOf(text, edit.range.start), end: offsetOf(text, edit.range.end), newText: edit.newText }));
  let result = text;
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, span.start) + span.newText + result.slice(span.end);
  }
  return result;
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

  it('reports well-formedness problems with severity, line and column, in the order of the file', async () => {
    const broken = path.join(extension, 'md', 'Broken.xml');
    await withFile(broken, '<mdscript name="Broken">\n  <cues>\n    <cue name="A>\n      <actions/>\n  </cues>\n</mdscript>\n', async () => {
      const result = await run(extension);
      expect(result.code).toBe(1);
      expect(lines(result)).toEqual([
        `${broken}:3:5: error: Element 'cue' has no end tag [missing-end-tag]`,
        `${broken}:3:15: error: Value of attribute 'name' is not closed [unclosed-attribute]`,
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 2 finding(s) (2 error(s); no schema validation: pass --unpacked)',
      ]);
    });
  });

  it('reports a script in the wrong folder', async () => {
    const misplaced = path.join(extension, 'aiscripts', 'Misplaced.xml');
    await withFile(misplaced, '<mdscript name="Misplaced"/>\n', async () => {
      const result = await run(extension);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`${misplaced}: error: is a md script but lies in the aiscripts folder [script-in-wrong-folder]\n`);
    });
  });

  it('shows the quick fixes of a finding under it', async () => {
    const typing = path.join(extension, 'md', 'Typing.xml');
    const text =
      '<mdscript name="Typing">\n  <cues>\n    <cue name="A" checkinterval>\n      <actions><set_value name=$x exact="1"/></actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    await withFile(typing, text, async () => {
      const result = await run(extension);
      expect(result.code).toBe(1);
      expect(lines(result)).toEqual([
        `${typing}:3:19: error: Attribute 'checkinterval' has no value [missing-attribute-value]`,
        "  fix: Give 'checkinterval' an empty value",
        `${typing}:4:32: error: Value of attribute 'name' is not quoted [unquoted-attribute-value]`,
        '  fix: Put the value in quotes',
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 2 finding(s) (2 error(s); no schema validation: pass --unpacked)',
      ]);
    });
  });

  it('writes the findings as JSON, with ranges and quick fixes that apply', async () => {
    const typing = path.join(extension, 'md', 'Typing.xml');
    const misplaced = path.join(extension, 'aiscripts', 'Misplaced.xml');
    const text =
      '<mdscript name="Typing">\n  <cues>\n    <cue name="A" checkinterval>\n      <actions><set_value name=$x exact="1"/></actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    await withFile(misplaced, '<mdscript name="Misplaced"/>\n', () =>
      withFile(typing, text, async () => {
        const result = await run('--format', 'json', extension);
        expect(result.code).toBe(1);
        const report = JSON.parse(result.stdout) as JsonReport;
        expect(report.findings).toEqual([
          {
            file: misplaced,
            severity: 'error',
            code: 'script-in-wrong-folder',
            message: 'is a md script but lies in the aiscripts folder',
            fixes: [],
          },
          {
            file: typing,
            line: 3,
            column: 19,
            range: { start: { line: 2, character: 18 }, end: { line: 2, character: 31 } },
            severity: 'error',
            code: 'missing-attribute-value',
            message: "Attribute 'checkinterval' has no value",
            fixes: [
              {
                title: "Give 'checkinterval' an empty value",
                preferred: true,
                edits: [{ range: { start: { line: 2, character: 31 }, end: { line: 2, character: 31 } }, newText: '=""' }],
              },
            ],
          },
          {
            file: typing,
            line: 4,
            column: 32,
            range: { start: { line: 3, character: 31 }, end: { line: 3, character: 33 } },
            severity: 'error',
            code: 'unquoted-attribute-value',
            message: "Value of attribute 'name' is not quoted",
            fixes: [
              {
                title: 'Put the value in quotes',
                preferred: true,
                edits: [{ range: { start: { line: 3, character: 31 }, end: { line: 3, character: 33 } }, newText: '"$x"' }],
              },
            ],
          },
        ]);
        expect(report.summary).toEqual({
          files: 5,
          folders: 2,
          scripts: 4,
          patches: 1,
          findings: 3,
          errors: 3,
          warnings: 0,
          info: 0,
          hints: 0,
          schemaValidation: false,
        });
        expect(report.problems).toEqual([]);

        // The fixes, applied, leave nothing to report in the file.
        writeFileSync(
          typing,
          applied(
            text,
            report.findings.flatMap((finding) => (finding.file === typing ? finding.fixes[0].edits : []))
          )
        );
        const fixed = JSON.parse((await run('--format=json', extension)).stdout) as JsonReport;
        expect(fixed.findings.map((finding) => finding.file)).toEqual([misplaced]);
      })
    );
  });

  it('annotates the files for GitHub Actions, named from the current folder', async () => {
    const typing = path.join(extension, 'md', 'Typing, 100%.xml');
    const misplaced = path.join(extension, 'aiscripts', 'Misplaced.xml');
    const text = '<mdscript name="Typing">\n  <cues>\n    <cue name="A" checkinterval>\n      <actions/>\n    </cue>\n  </cues>\n</mdscript>\n';
    await withFile(misplaced, '<mdscript name="Misplaced"/>\n', () =>
      withFile(typing, text, async () => {
        const result = await runIn(workDir, '--format', 'github', extension);
        expect(result.code).toBe(1);
        expect(lines(result)).toEqual([
          '::error file=my_extension/aiscripts/Misplaced.xml,title=script-in-wrong-folder::is a md script but lies in the aiscripts folder',
          "::error file=my_extension/md/Typing%2C 100%25.xml,line=3,endLine=3,col=19,endColumn=32,title=missing-attribute-value::Attribute 'checkinterval' has no value%0AFix: Give 'checkinterval' an empty value",
          '5 file(s) in 2 folder(s): 4 script(s), 1 patch(es), 2 finding(s) (2 error(s); no schema validation: pass --unpacked)',
        ]);
        // Outside the current folder, the path stays as it is.
        const elsewhere = await runIn(path.dirname(unpacked), '--format', 'github', extension);
        expect(lines(elsewhere)[0]).toBe(
          `::error file=${escapedPath(misplaced)},title=script-in-wrong-folder::is a md script but lies in the aiscripts folder`
        );
      })
    );
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
        `${invalid}:3:19: error: Unknown attribute 'bogus' in 'cue' [unknown-attribute]`,
        `${invalid}:4:17: error: Missing required attribute 'name' in 'set_value' [missing-required-attribute]`,
        "  fix: Add the required attribute 'name'",
        `${invalid}:5:8: error: Element 'conditions' is not allowed after 'actions' in 'cue'. Expected 'cues', 'patch' [invalid-child-element]`,
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 3 finding(s) (3 error(s))',
      ]);

      const withoutStructure = await run('--unpacked', unpacked, '--no-structure', extension);
      expect(withoutStructure.code).toBe(1);
      expect(lines(withoutStructure).pop()).toBe('4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 2 finding(s) (2 error(s))');
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
        const expected = [
          `${script}:5:${line.indexOf('{90001,2}') + 1}: warning: Text 2 does not exist on page 90001 [text-undefined]`,
          '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 1 finding(s) (1 warning(s))',
        ];
        expect(lines(result)).toEqual(expected);

        // A warning is reported either way; it fails the check unless only errors do.
        const errorsOnly = await run('--unpacked', unpacked, '--fail-on', 'error', extension);
        expect(errorsOnly.code).toBe(0);
        expect(lines(errorsOnly)).toEqual(expected);
        expect((await run('--unpacked', unpacked, '--fail-on=warning', extension)).code).toBe(1);
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
          `${user}:3:19: warning: Interrupt handler 'DepHandler' is not defined in any known script [library-undefined]`,
          '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 1 finding(s) (1 warning(s))',
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
          // Folders and files in the order of their names, the same on every system.
          expect(lines(result)).toEqual([
            `${nowhere}:1:2: warning: Nothing to patch: the game has no md/nowhere.xml [patch-target-missing]`,
            `${other}:1:${otherText.indexOf('//cue') + 1}: error: No matching node in md/other.xml: 'cue[@name='Missing']' selects nothing [patch-no-match]`,
            `${nested}:1:2: warning: Nothing to patch: the extension 'absent_mod' is not among the extensions read [patch-target-missing]`,
            '6 file(s) in 3 folder(s): 2 script(s), 4 patch(es), 3 finding(s) (1 error(s), 2 warning(s))',
          ]);
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

    const format = await run('--format', 'sarif', extension);
    expect(format.code).toBe(2);
    expect(format.stderr).toContain("--format needs one of text, json, github, not 'sarif'");
    const failOn = await run(extension, '--fail-on');
    expect(failOn.code).toBe(2);
    expect(failOn.stderr).toContain('--fail-on needs one of error, warning, info, hint');
    expect((await run('--fail-on=errors', extension)).code).toBe(2);

    const help = await run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: x4-script-check');
  });
});

describe('x4-script-check while typing', { timeout: 30_000 }, () => {
  it('reports every cut of a script alike in each format, with its fixes inside the file', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'x4codesense-cli-typing-'));
    const md = path.join(folder, 'typing_mod', 'md');
    mkdirSync(md, { recursive: true });
    const text =
      '<mdscript name="Typing">\n  <cues>\n    <cue name="A" checkinterval="1s">\n      <actions>\n        <set_value name="$x" exact="1"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    // Each cut lacks at least the last '>', so each has something to report.
    const cuts = new Map<string, string>();
    for (let cut = 1; cut < text.trimEnd().length; cut += 7) {
      const file = path.join(md, `Cut${String(cut).padStart(3, '0')}.xml`);
      cuts.set(file, text.slice(0, cut));
      writeFileSync(file, text.slice(0, cut));
    }
    try {
      const [textRun, jsonRun, githubRun] = await Promise.all([run(folder), run('--format', 'json', folder), runIn(folder, '--format', 'github', folder)]);
      expect([textRun.code, jsonRun.code, githubRun.code]).toEqual([1, 1, 1]);
      const report = JSON.parse(jsonRun.stdout) as JsonReport;
      expect(report.summary.files).toBe(cuts.size);
      expect(new Set(report.findings.map((finding) => finding.file))).toEqual(new Set(cuts.keys()));

      // The same findings in the same order: a text line and an annotation each, a text line per fix.
      const textLines = lines(textRun).slice(0, -1);
      const findingLines = textLines.filter((line) => !line.startsWith('  fix: '));
      const annotations = lines(githubRun).slice(0, -1);
      expect(findingLines.length).toBe(report.findings.length);
      expect(annotations.length).toBe(report.findings.length);
      expect(textLines.length - findingLines.length).toBe(report.findings.reduce((sum, finding) => sum + finding.fixes.length, 0));
      report.findings.forEach((finding, index) => {
        const location = finding.line === undefined ? '' : `:${finding.line}:${finding.column}`;
        expect(findingLines[index]).toContain(`${finding.file}${location}: ${finding.severity}: ${finding.message}`);
        expect(annotations[index]).toMatch(/^::(error|warning|notice) file=typing_mod\/md\/Cut\d{3}\.xml[,:]/);
      });

      for (const finding of report.findings) {
        const content = cuts.get(finding.file) ?? '';
        if (finding.range) {
          expect(offsetOf(content, finding.range.end)).toBeLessThanOrEqual(content.length);
        }
        for (const fix of finding.fixes) {
          for (const edit of fix.edits) {
            expect(offsetOf(content, edit.range.end)).toBeLessThanOrEqual(content.length);
          }
          expect(applied(content, fix.edits)).not.toBe(content);
        }
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
