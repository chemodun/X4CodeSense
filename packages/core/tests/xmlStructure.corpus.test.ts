/**
 * Corpus gate for the XML scanner against local data that never enters the repository.
 * Every vanilla script (X4_EXTRACTED) and every script and patch of the mods workspace (X4_MODS) is scanned
 * and compared element by element with a strict XML parser: same names, same offsets, same attributes.
 * A file the strict parser rejects must at least produce a problem here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as sax from 'sax';
import { describe, expect, it } from 'vitest';
import { parseXml, scriptSchemas, schemaFolderName } from '../src';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

interface OracleElement {
  name: string;
  start: number;
  startTagEnd: number;
  end: number;
  attributes: [string, string][];
}

function xmlFilesIn(folder: string): string[] {
  try {
    if (!statSync(folder).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.xml'))
    .map((name) => path.join(folder, name));
}

function subfolders(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(folder, entry.name));
  } catch {
    return [];
  }
}

/** Element list of a well formed text as the strict sax parser sees it, or undefined when it is not well formed. */
function oracle(text: string): OracleElement[] | undefined {
  const parser = sax.parser(true, { position: true });
  const result: OracleElement[] = [];
  const open: OracleElement[] = [];
  let failed = false;
  parser.onopentag = (node) => {
    const element: OracleElement = {
      name: node.name,
      start: parser.startTagPosition - 1,
      startTagEnd: parser.position,
      end: -1,
      attributes: Object.entries(node.attributes).map(([name, value]) => [name, String(value)]),
    };
    result.push(element);
    open.push(element);
  };
  parser.onclosetag = () => {
    const element = open.pop();
    if (element) {
      element.end = parser.position;
    }
  };
  parser.onerror = () => {
    failed = true;
    parser.resume();
  };
  try {
    parser.write(text).close();
  } catch {
    failed = true;
  }
  return failed ? undefined : result;
}

function scannerView(text: string): OracleElement[] {
  return parseXml(text).elements.map((element) => ({
    name: element.name,
    start: element.start,
    startTagEnd: element.startTagEnd,
    end: element.end,
    attributes: element.attributes.map((attribute) => [attribute.name, attribute.value]),
  }));
}

function firstDifference(expected: OracleElement[], actual: OracleElement[]): string | undefined {
  const count = Math.min(expected.length, actual.length);
  for (let index = 0; index < count; index++) {
    const want = JSON.stringify(expected[index]);
    const got = JSON.stringify(actual[index]);
    if (want !== got) {
      return `element ${index}: expected ${want}, got ${got}`;
    }
  }
  if (expected.length !== actual.length) {
    return `expected ${expected.length} elements, got ${actual.length}`;
  }
  return undefined;
}

/** Checks one file; returns a description of the failure or undefined. */
function checkFile(file: string): string | undefined {
  // Both parsers must see the same offsets, so the BOM is removed before either one runs.
  const raw = readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const expected = oracle(text);
  const structure = parseXml(text);
  if (expected === undefined) {
    return structure.problems.length > 0 ? undefined : 'the strict parser rejects the file but the scanner reports no problem';
  }
  if (structure.problems.length > 0) {
    return `unexpected problems: ${structure.problems.map((problem) => `${problem.code}@${problem.start}`).join(', ')}`;
  }
  if (structure.roots.length !== 1) {
    return `${structure.roots.length} roots`;
  }
  return firstDifference(expected, scannerView(text));
}

function checkFiles(root: string, files: string[]): string[] {
  const failures: string[] = [];
  for (const file of files) {
    const failure = checkFile(file);
    if (failure) {
      failures.push(`${path.relative(root, file)}: ${failure}`);
    }
  }
  return failures;
}

// Whole-corpus runs share the machine with the other corpus gates: time is checked by the tests, not the runner.
describe.skipIf(!extracted)('XML scanner on the vanilla corpus', { timeout: 60_000 }, () => {
  const root = extracted ?? '';
  for (const schema of scriptSchemas) {
    it(`matches the strict parser on every ${schema} file`, () => {
      const files = xmlFilesIn(path.join(root, schemaFolderName[schema]));
      expect(files.length).toBeGreaterThan(0);
      expect(checkFiles(root, files)).toEqual([]);
    });
  }

  it('matches the strict parser on every script and patch of the DLCs', () => {
    const files: string[] = [];
    for (const dlc of subfolders(path.join(root, 'extensions'))) {
      for (const schema of scriptSchemas) {
        files.push(...xmlFilesIn(path.join(dlc, schemaFolderName[schema])));
      }
    }
    expect(files.length).toBeGreaterThan(0);
    expect(checkFiles(root, files)).toEqual([]);
  });

  it('scans all scripts quickly', () => {
    const files = [...xmlFilesIn(path.join(root, 'md')), ...xmlFilesIn(path.join(root, 'aiscripts'))];
    const texts = files.map((file) => readFileSync(file, 'utf8'));
    const bytes = texts.reduce((sum, text) => sum + text.length, 0);
    const started = performance.now();
    let elements = 0;
    for (const text of texts) {
      elements += parseXml(text).elements.length;
    }
    const elapsed = performance.now() - started;
    console.log(`scanned ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${elements} elements in ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe.skipIf(!mods)('XML scanner on the mods corpus', () => {
  it('matches the strict parser on every script and patch', () => {
    const root = mods ?? '';
    const files: string[] = [];
    for (const mod of subfolders(root)) {
      for (const schema of scriptSchemas) {
        files.push(...xmlFilesIn(path.join(mod, schemaFolderName[schema])));
      }
    }
    expect(files.length).toBeGreaterThan(0);
    expect(checkFiles(root, files)).toEqual([]);
  });
});
