/**
 * End-to-end test: bundle the checker and run it on a temporary extension folder,
 * with and without the fixture schemas of the core package.
 */
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCatalog, type CatalogFile } from 'x4-catalog';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../src/cli.ts');
const coreEntry = path.resolve(here, '../../core/src/index.ts');
const catalogEntry = path.resolve(here, '../../catalog/src/index.ts');
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

/** Runs the checker in a folder, which matters to the paths of the GitHub format; the game comes from the arguments or `env` only. */
async function execute(cwd: string | undefined, args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundle, ...args], {
      cwd,
      env: { ...process.env, X4_UNPACKED: '', X4_GAME: '', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

function runIn(cwd: string | undefined, ...args: string[]): Promise<Run> {
  return execute(cwd, args);
}

function run(...args: string[]): Promise<Run> {
  return execute(undefined, args);
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
  fixed?: { file: string; line?: number; column?: number; range?: JsonRange; code: string; message: string; fix: string }[];
  summary: Record<string, number | boolean>;
  problems: string[];
}

interface SarifRegion {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

interface SarifArtifact {
  uri: string;
  uriBaseId?: string;
}

interface SarifLog {
  version: string;
  runs: {
    tool: { driver: { name: string; rules: { id: string; shortDescription: { text: string }; fullDescription: { text: string }; help: { text: string } }[] } };
    originalUriBaseIds: Record<string, { uri: string }>;
    columnKind: string;
    invocations: { executionSuccessful: boolean; toolExecutionNotifications: { level: string; message: { text: string } }[] }[];
    results: {
      ruleId?: string;
      ruleIndex?: number;
      level: string;
      message: { text: string };
      locations: { physicalLocation: { artifactLocation: SarifArtifact; region: SarifRegion } }[];
      fixes?: {
        description: { text: string };
        artifactChanges: { artifactLocation: SarifArtifact; replacements: { deletedRegion: SarifRegion; insertedContent?: { text: string } }[] }[];
      }[];
    }[];
  }[];
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
async function withFile(file: string, content: string | Buffer, body: () => Promise<void>): Promise<void> {
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
    alias: { 'x4-script-core': coreEntry, 'x4-catalog': catalogEntry },
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
    expect(lines(result)).toEqual(['3 file(s) in 2 folder(s): 2 script(s), 1 patch(es), 0 finding(s) (no schema validation: pass --unpacked or --game)']);
  });

  it('reports well-formedness problems with severity, line and column, in the order of the file', async () => {
    const broken = path.join(extension, 'md', 'Broken.xml');
    await withFile(broken, '<mdscript name="Broken">\n  <cues>\n    <cue name="A>\n      <actions/>\n  </cues>\n</mdscript>\n', async () => {
      const result = await run(extension);
      expect(result.code).toBe(1);
      expect(lines(result)).toEqual([
        `${broken}:3:5: error: Element 'cue' has no end tag [missing-end-tag]`,
        '  fix: Add the end tag </cue>',
        `${broken}:3:15: error: Value of attribute 'name' is not closed [unclosed-attribute]`,
        "  fix: Close the value of 'name'",
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 2 finding(s) (2 error(s); no schema validation: pass --unpacked or --game)',
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
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 2 finding(s) (2 error(s); no schema validation: pass --unpacked or --game)',
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
          '5 file(s) in 2 folder(s): 4 script(s), 1 patch(es), 2 finding(s) (2 error(s); no schema validation: pass --unpacked or --game)',
        ]);
        // Outside the current folder, the path stays as it is.
        const elsewhere = await runIn(path.dirname(unpacked), '--format', 'github', extension);
        expect(lines(elsewhere)[0]).toBe(
          `::error file=${escapedPath(misplaced)},title=script-in-wrong-folder::is a md script but lies in the aiscripts folder`
        );
      })
    );
  });

  it('writes SARIF for code scanning: a rule per code, regions, fixes, files named from the current folder', async () => {
    const typing = path.join(extension, 'md', 'Typing, 100%.xml');
    const misplaced = path.join(extension, 'aiscripts', 'Misplaced.xml');
    const text =
      '<mdscript name="Typing">\n  <cues>\n    <cue name="A" checkinterval>\n      <actions><set_value name=$x exact="1"/></actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    await withFile(misplaced, '<mdscript name="Misplaced"/>\n', () =>
      withFile(typing, text, async () => {
        const result = await runIn(workDir, '--format', 'sarif', extension);
        expect(result.code).toBe(1);
        const log = JSON.parse(result.stdout) as SarifLog;
        expect(log.version).toBe('2.1.0');
        expect(log.runs.length).toBe(1);
        const [sarifRun] = log.runs;
        expect(sarifRun.tool.driver.name).toBe('x4-script-check');
        expect(sarifRun.columnKind).toBe('utf16CodeUnits');
        expect(sarifRun.originalUriBaseIds['%SRCROOT%'].uri).toBe(`${pathToFileURL(workDir).toString()}/`);
        expect(sarifRun.invocations).toEqual([{ executionSuccessful: true, toolExecutionNotifications: [] }]);

        // A rule per code found, in the order of the codes, each with what it reports.
        const rules = sarifRun.tool.driver.rules;
        expect(rules.map((rule) => rule.id)).toEqual(['missing-attribute-value', 'script-in-wrong-folder', 'unquoted-attribute-value']);
        for (const rule of rules) {
          expect(rule.shortDescription.text).not.toBe(rule.id);
          expect(rule.fullDescription.text).toBe(rule.shortDescription.text);
          expect(rule.help.text).toBe(rule.shortDescription.text);
        }

        const typingFile = { uri: 'my_extension/md/Typing%2C%20100%25.xml', uriBaseId: '%SRCROOT%' };
        expect(sarifRun.results).toEqual([
          {
            ruleId: 'script-in-wrong-folder',
            ruleIndex: 1,
            level: 'error',
            message: { text: 'is a md script but lies in the aiscripts folder' },
            // About the whole file: code scanning shows a result only at a line.
            locations: [
              { physicalLocation: { artifactLocation: { uri: 'my_extension/aiscripts/Misplaced.xml', uriBaseId: '%SRCROOT%' }, region: { startLine: 1 } } },
            ],
          },
          {
            ruleId: 'missing-attribute-value',
            ruleIndex: 0,
            level: 'error',
            message: { text: "Attribute 'checkinterval' has no value" },
            locations: [{ physicalLocation: { artifactLocation: typingFile, region: { startLine: 3, startColumn: 19, endLine: 3, endColumn: 32 } } }],
            fixes: [
              {
                description: { text: "Give 'checkinterval' an empty value" },
                artifactChanges: [
                  {
                    artifactLocation: typingFile,
                    replacements: [{ deletedRegion: { startLine: 3, startColumn: 32, endLine: 3, endColumn: 32 }, insertedContent: { text: '=""' } }],
                  },
                ],
              },
            ],
          },
          {
            ruleId: 'unquoted-attribute-value',
            ruleIndex: 2,
            level: 'error',
            message: { text: "Value of attribute 'name' is not quoted" },
            locations: [{ physicalLocation: { artifactLocation: typingFile, region: { startLine: 4, startColumn: 32, endLine: 4, endColumn: 34 } } }],
            fixes: [
              {
                description: { text: 'Put the value in quotes' },
                artifactChanges: [
                  {
                    artifactLocation: typingFile,
                    replacements: [{ deletedRegion: { startLine: 4, startColumn: 32, endLine: 4, endColumn: 34 }, insertedContent: { text: '"$x"' } }],
                  },
                ],
              },
            ],
          },
        ]);

        // Outside the current folder, a file is named by its absolute URI.
        const elsewhere = JSON.parse((await runIn(path.dirname(unpacked), '--format=sarif', extension)).stdout) as SarifLog;
        expect(elsewhere.runs[0].results[0].locations[0].physicalLocation.artifactLocation).toEqual({ uri: pathToFileURL(misplaced).toString() });
      })
    );
  });

  it('applies the preferred fixes with --fix and reports what is left', async () => {
    const typing = path.join(extension, 'md', 'Typing.xml');
    const good = path.join(extension, 'md', 'Good.xml');
    const goodText = readFileSync(good, 'utf8');
    const text =
      '<mdscript name="Typing">\n  <cues>\n    <cue name="A" checkinterval>\n      <actions><set_value name=$x exact="1"/></actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    await withFile(typing, text, async () => {
      const result = await run('--fix', extension);
      expect(result.code).toBe(1);
      // The quotes are put in; an empty value would only move the problem, so it is left to the author.
      expect(lines(result)).toEqual([
        `${typing}:4:32: fixed: Put the value in quotes [unquoted-attribute-value]`,
        `${typing}:3:19: error: Attribute 'checkinterval' has no value [missing-attribute-value]`,
        "  fix: Give 'checkinterval' an empty value",
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 1 finding(s) (1 error(s); no schema validation: pass --unpacked or --game); 1 fix(es) applied to 1 file(s)',
      ]);
      expect(readFileSync(typing, 'utf8')).toBe(text.replace('name=$x', 'name="$x"'));
      expect(readFileSync(good, 'utf8')).toBe(goodText);

      // Nothing is left to fix.
      const again = await run('--fix', '--format', 'json', extension);
      expect(again.code).toBe(1);
      const report = JSON.parse(again.stdout) as JsonReport;
      expect(report.fixed).toEqual([]);
      expect(report.summary).toMatchObject({ findings: 1, errors: 1, fixes: 0, fixedFiles: 0 });
      expect(readFileSync(typing, 'utf8')).toBe(text.replace('name=$x', 'name="$x"'));

      // Without --fix, the report has no such entries.
      const plain = JSON.parse((await run('--format', 'json', extension)).stdout) as JsonReport;
      expect(plain.fixed).toBeUndefined();
      expect(plain.summary.fixes).toBeUndefined();
    });
  });

  it('counts the columns of a file with a byte order mark as an editor does, and keeps the mark when fixing', async () => {
    const marked = path.join(extension, 'md', 'Marked.xml');
    const text = '﻿<mdscript name=Marked bogus="1">\n  <cues/>\n</mdscript>\n';
    await withFile(marked, text, async () => {
      const result = await run('--unpacked', unpacked, '--fix', extension);
      expect(lines(result)).toEqual([
        `${marked}:1:16: fixed: Put the value in quotes [unquoted-attribute-value]`,
        `${marked}:1:25: error: Unknown attribute 'bogus' in 'mdscript' [unknown-attribute]`,
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 1 finding(s) (1 error(s)); 1 fix(es) applied to 1 file(s)',
      ]);
      expect(readFileSync(marked, 'utf8')).toBe(text.replace('name=Marked', 'name="Marked"'));
    });
  });

  it('leaves a file that is not UTF-8 as it is when fixing, and says so', async () => {
    const latin = path.join(extension, 'md', 'Latin.xml');
    // Windows-1252, which XML allows: the ü is the byte FC, no character in UTF-8.
    const bytes = Buffer.from('<?xml version="1.0" encoding="windows-1252"?>\n<mdscript name=Latin>\n  <!-- für -->\n  <cues/>\n</mdscript>\n', 'latin1');
    await withFile(latin, bytes, async () => {
      const result = await run('--fix', '--format', 'json', extension);
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(report.fixed).toEqual([]);
      expect(report.findings.map((finding) => `${path.basename(finding.file)} ${finding.code}`)).toEqual(['Latin.xml unquoted-attribute-value']);
      expect(report.problems).toEqual([`${latin}: not fixed: the file is not UTF-8`]);
      expect(result.stderr).toContain(`${latin}: not fixed: the file is not UTF-8`);
      expect(readFileSync(latin).equals(bytes)).toBe(true);
    });
  });

  it('fixes every file before checking any, so a fixed definition counts in the files before it', async () => {
    const caller = path.join(extension, 'md', 'A_Caller.xml');
    const callee = path.join(extension, 'md', 'B_Callee.xml');
    const callerText =
      '<mdscript name="Caller">\n  <cues>\n    <cue name="A">\n      <actions>\n        <signal_cue_instantly cue="md.Callee.Start"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    const calleeText = '<mdscript name="Callee">\n  <cues>\n    <cuee name="Start">\n      <actions/>\n    </cuee>\n  </cues>\n</mdscript>\n';
    await withFile(caller, callerText, () =>
      withFile(callee, calleeText, async () => {
        const before = await run('--unpacked', unpacked, extension);
        expect(lines(before)).toEqual([
          `${caller}:5:46: warning: Script 'Callee' has no cue 'Start' [cue-undefined]`,
          `${callee}:3:6: error: Unknown element 'cuee' in 'cues' [unknown-element]`,
          "  fix: Change to 'cue'",
          '5 file(s) in 2 folder(s): 4 script(s), 1 patch(es), 2 finding(s) (1 error(s), 1 warning(s))',
        ]);

        const fixed = await run('--unpacked', unpacked, '--fix', '--format', 'github', extension);
        expect(fixed.code).toBe(0);
        expect(lines(fixed)).toEqual([
          `::notice file=${escapedPath(callee)},line=3,endLine=3,col=6,endColumn=10,title=unknown-element::Fixed: Change to 'cue'`,
          '5 file(s) in 2 folder(s): 4 script(s), 1 patch(es), 0 finding(s); 1 fix(es) applied to 1 file(s)',
        ]);
        // The end tag changes with the name.
        expect(readFileSync(callee, 'utf8')).toBe(calleeText.replace(/cuee/g, 'cue'));
        expect(readFileSync(caller, 'utf8')).toBe(callerText);
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
        '  fix: Move <conditions> before <actions>',
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

  it('passes on information by default, and fails on it when asked', async () => {
    const script = path.join(extension, 'md', 'Unused.xml');
    const line = `        <debug_text text="'%s'.[1, 2]"/>`;
    const text = `<mdscript name="Unused">\n  <cues>\n    <cue name="A">\n      <actions>\n${line}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;
    await withFile(script, text, async () => {
      const result = await run('--unpacked', unpacked, extension);
      expect(result.code).toBe(0);
      expect(lines(result)).toContain(
        `${script}:5:${line.indexOf('2]') + 1}: info: The format takes 1 argument: this one is not shown [format-arguments-unused]`
      );
      expect((await run('--unpacked', unpacked, '--fail-on', 'info', extension)).code).toBe(1);
    });
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

  it("checks the patches and merge files in an extension's libraries against the game's files", async () => {
    const libraries = path.join(extension, 'libraries');
    const patch = path.join(libraries, 'wares.xml');
    const patchText = `<diff><remove sel="/wares/ware[@id='gone']"/></diff>\n`;
    // A merge file the game skips: its root is not the root of the game's languages.xml.
    const skipped = path.join(libraries, 'languages.xml');
    mkdirSync(libraries, { recursive: true });
    writeFileSync(patch, patchText);
    writeFileSync(skipped, '<wares/>\n');
    // A file of a name the game does not have: what the game does with it is not known.
    writeFileSync(path.join(libraries, 'mine.xml'), '<mine/>\n');
    try {
      const result = await run('--unpacked', unpacked, extension);
      expect(result.code).toBe(1);
      expect(lines(result)).toEqual([
        `${skipped}:1:2: error: The game skips this file: its root 'wares' is neither 'diff' for a patch nor 'languages' for a merge into libraries/languages.xml [library-root-mismatch]`,
        `${patch}:1:${patchText.indexOf('/ware[') + 1}: error: No matching node in libraries/wares.xml: 'ware[@id='gone']' selects nothing [patch-no-match]`,
        '6 file(s) in 3 folder(s): 2 script(s), 2 patch(es), 2 finding(s) (2 error(s))',
      ]);
      // Without the game, a merge file is XML like any other; no file there is said to be no script.
      const alone = await run(extension);
      expect(lines(alone)).toEqual(['6 file(s) in 3 folder(s): 2 script(s), 2 patch(es), 0 finding(s) (no schema validation: pass --unpacked or --game)']);
    } finally {
      rmSync(libraries, { recursive: true, force: true });
    }
  });

  it('finds extensions one level below the given folder', async () => {
    const result = await run(workDir);
    expect(result.code).toBe(0);
    expect(lines(result)).toEqual(['3 file(s) in 2 folder(s): 2 script(s), 1 patch(es), 0 finding(s) (no schema validation: pass --unpacked or --game)']);
  });

  it('checks a folder given twice, or inside another given folder, once', async () => {
    const broken = path.join(extension, 'md', 'Broken.xml');
    await withFile(broken, '<mdscript name="Broken">\n  <cues>\n</mdscript>\n', async () => {
      const once = lines(await run(extension));
      expect(once.at(-1)).toBe(
        '4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 1 finding(s) (1 error(s); no schema validation: pass --unpacked or --game)'
      );
      expect(lines(await run(extension, extension))).toEqual(once);
      expect(lines(await run(workDir, extension))).toEqual(once);
    });
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

    const format = await run('--format', 'xml', extension);
    expect(format.code).toBe(2);
    expect(format.stderr).toContain("--format needs one of text, json, github, sarif, not 'xml'");
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
      const [textRun, jsonRun, githubRun, sarifRun] = await Promise.all([
        run(folder),
        run('--format', 'json', folder),
        runIn(folder, '--format', 'github', folder),
        runIn(folder, '--format', 'sarif', folder),
      ]);
      expect([textRun.code, jsonRun.code, githubRun.code, sarifRun.code]).toEqual([1, 1, 1, 1]);
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
      // SARIF: a result per finding, at its line, with a described rule.
      const sarif = (JSON.parse(sarifRun.stdout) as SarifLog).runs[0];
      expect(sarif.results.length).toBe(report.findings.length);
      sarif.results.forEach((result, index) => {
        const finding = report.findings[index];
        expect(result.message.text).toBe(finding.message);
        expect(result.locations[0].physicalLocation.region.startLine).toBe(finding.line ?? 1);
        expect(result.locations[0].physicalLocation.artifactLocation.uri).toMatch(/^typing_mod\/md\/Cut\d{3}\.xml$/);
        expect(sarif.tool.driver.rules[result.ruleIndex ?? -1]?.id).toBe(finding.code);
        expect(result.fixes?.length ?? 0).toBe(finding.fixes.length);
      });
      for (const rule of sarif.tool.driver.rules) {
        expect(rule.shortDescription.text).not.toBe(rule.id);
      }

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

      // --fix on every cut: what it writes has nothing left to fix.
      const fixRun = await run('--fix', '--format', 'json', folder);
      expect([0, 1]).toContain(fixRun.code);
      const fixReport = JSON.parse(fixRun.stdout) as JsonReport;
      expect(fixReport.summary.fixes).toBe(fixReport.fixed?.length);
      for (const fixed of fixReport.fixed ?? []) {
        expect(cuts.has(fixed.file)).toBe(true);
      }
      const again = JSON.parse((await run('--fix', '--format', 'json', folder)).stdout) as JsonReport;
      expect(again.fixed).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('x4-script-check on an installed game', { timeout: 30_000 }, () => {
  /** The fixture game packed into catalogs: the game's files in 01.cat, a DLC's in its ext_01.cat, a mod of the player loose beside it. */
  let install: string;
  let dlcScript: string;
  let modScript: string;

  beforeAll(() => {
    install = path.join(path.dirname(unpacked), 'X4 Foundations');
    mkdirSync(install);
    const filesOf = (folder: string): CatalogFile[] =>
      readdirSync(folder).map((name) => ({ path: `${path.basename(folder)}/${name}`, data: readFileSync(path.join(folder, name)) }));
    writeCatalog(path.join(install, '01.cat'), [
      ...filesOf(path.join(unpacked, 'libraries')),
      ...filesOf(path.join(unpacked, 't')),
      ...filesOf(path.join(unpacked, 'md')),
    ]);
    const dlc = path.join(install, 'extensions', 'ego_dlc_test');
    mkdirSync(dlc, { recursive: true });
    writeFileSync(path.join(dlc, 'content.xml'), '<content id="ego_dlc_test"/>\n');
    // A problem with a preferred fix, which --fix cannot write: the file is in a catalog.
    writeCatalog(path.join(dlc, 'ext_01.cat'), [
      { path: 'md/dlc.xml', data: '<mdscript name="Dlc">\n  <cues>\n    <cuee name="A"/>\n  </cues>\n</mdscript>\n' },
    ]);
    dlcScript = path.join(dlc, 'md', 'dlc.xml');
    modScript = path.join(install, 'extensions', 'player_mod', 'md', 'Mod.xml');
    mkdirSync(path.dirname(modScript), { recursive: true });
    writeFileSync(modScript, '<mdscript name="Mod">\n  <cues>\n    <bogus/>\n  </cues>\n</mdscript>\n');
  });

  it('validates against the installed game as against the extracted files', async () => {
    const invalid = path.join(extension, 'md', 'Invalid.xml');
    const text =
      '<mdscript name="Invalid">\n  <cues>\n    <cue name="A" bogus="{1001,1}">\n      <actions><set_value exact="{1001,99}"/></actions>\n    </cue>\n  </cues>\n</mdscript>\n';
    await withFile(invalid, text, async () => {
      const extracted = await run('--unpacked', unpacked, extension);
      const installed = await run('--game', install, extension);
      // The fixture's script properties name imports it lacks: the same problems either way.
      expect(installed.stderr).toBe(extracted.stderr);
      expect(installed.code).toBe(1);
      expect(lines(installed)).toEqual(lines(extracted));
      expect(lines(installed).pop()).toBe('4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 3 finding(s) (2 error(s), 1 warning(s))');
      // The variable as well.
      expect(lines(await execute(undefined, [extension], { X4_GAME: install }))).toEqual(lines(extracted));
    });
  });

  it('checks the game and its DLCs when given the game folder, not the mods in its extensions folder, and writes none of their files', async () => {
    const result = await run('--game', install, '--fix', '--format', 'json', install);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.fixed).toEqual([]);
    expect(report.findings.map((finding) => `${finding.file} ${finding.code} ${finding.fixes.map((fix) => fix.title).join(', ')}`)).toEqual([
      `${dlcScript} unknown-element Change to 'cue'`,
    ]);
    expect(report.summary).toMatchObject({ files: 2, folders: 2, scripts: 2, patches: 0, schemaValidation: true, fixes: 0, fixedFiles: 0 });
    expect(existsSync(path.dirname(dlcScript))).toBe(false);
    expect(existsSync(path.join(install, 'md'))).toBe(false);

    // The mods there are checked as any folder of extensions is.
    const mods = JSON.parse((await run('--game', install, '--format', 'json', path.join(install, 'extensions'))).stdout) as JsonReport;
    expect(mods.findings.map((finding) => `${finding.file} ${finding.code}`)).toEqual([`${dlcScript} unknown-element`, `${modScript} unknown-element`]);
  });

  it('takes the extracted files first, an option given over the environment, and refuses a folder that is no installed game', async () => {
    const both = await run('--unpacked', unpacked, '--game', install, extension);
    expect(both.code).toBe(0);
    expect(lines(both)).toEqual(['3 file(s) in 2 folder(s): 2 script(s), 1 patch(es), 0 finding(s)']);
    // Beside the extracted files, a folder that is no installed game gives no mods: said, and the check goes on.
    const noMods = await run('--unpacked', unpacked, '--game', workDir, extension);
    expect(noMods.code).toBe(0);
    expect(noMods.stderr).toContain(`Not an installed game, it has no 01.cat: ${workDir}`);
    expect(lines(noMods)).toEqual(lines(both));
    const notGame = await run('--game', workDir, extension);
    expect(notGame.code).toBe(2);
    expect(notGame.stderr).toContain(`Not an installed game, it has no 01.cat: ${workDir}`);
    // The folder given is checked, whatever X4_UNPACKED says.
    const overVariable = await execute(undefined, ['--game', workDir, extension], { X4_UNPACKED: unpacked });
    expect(overVariable.code).toBe(2);
    expect(overVariable.stderr).toContain(`Not an installed game, it has no 01.cat: ${workDir}`);
  });

  it('reads the installed mods the checked extension depends on: packed ones from their catalogs, for patches, and with --installed-dependencies for names', async () => {
    // A packed mod of the player in the game, and an extension being written that depends on it.
    const packed = path.join(install, 'extensions', 'packed_api');
    mkdirSync(packed, { recursive: true });
    writeFileSync(path.join(packed, 'content.xml'), '<content id="ws_packed_api"/>\n');
    writeCatalog(path.join(packed, 'ext_01.cat'), [
      { path: 'md/api.xml', data: '<mdscript name="Api">\n  <cues>\n    <cue name="Hello"/>\n  </cues>\n</mdscript>\n' },
    ]);
    const writing = path.join(workDir, 'writing', 'my_ext');
    mkdirSync(path.join(writing, 'md'), { recursive: true });
    mkdirSync(path.join(writing, 'extensions', 'packed_api', 'md'), { recursive: true });
    writeFileSync(path.join(writing, 'content.xml'), '<content id="my_ext"><dependency id="ws_packed_api"/></content>\n');
    writeFileSync(
      path.join(writing, 'md', 'main.xml'),
      '<mdscript name="Main">\n  <cues>\n    <cue name="A">\n      <actions>\n        <signal_cue_instantly cue="md.Api.Hello"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n'
    );
    writeFileSync(path.join(writing, 'extensions', 'packed_api', 'md', 'api.xml'), `<diff>\n  <remove sel="//cue[@name='Missing']"/>\n</diff>\n`);
    const codes = (result: { stdout: string }): string[] =>
      (JSON.parse(result.stdout) as JsonReport).findings.map((finding) => `${path.basename(finding.file)} ${finding.code}`).sort();
    expect(codes(await run('--unpacked', unpacked, '--format', 'json', writing))).toEqual(['api.xml patch-target-missing', 'main.xml cue-undefined']);
    expect(codes(await run('--unpacked', unpacked, '--game', install, '--format', 'json', writing))).toEqual([
      'api.xml patch-no-match',
      'main.xml cue-undefined',
    ]);
    expect(codes(await run('--unpacked', unpacked, '--game', install, '--installed-dependencies', '--format', 'json', writing))).toEqual([
      'api.xml patch-no-match',
    ]);
  });
});
