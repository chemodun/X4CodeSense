/**
 * Corpus gate for schema validation against the extracted vanilla game (X4_EXTRACTED, never committed):
 * the real schemas must load cleanly and no vanilla script may produce a single diagnostic.
 * Any hit is a bug in the engine or a gap in the model, never something to suppress.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeText, loadSchemas, scriptSchemas, schemaFolderName, type SchemaSet } from '../src';

const extracted = process.env.X4_EXTRACTED;

function xmlFilesIn(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.xml'))
    .map((name) => path.join(folder, name));
}

describe.skipIf(!extracted)('schema validation on the vanilla corpus', () => {
  const root = extracted ?? '';
  let schemas: SchemaSet;

  beforeAll(() => {
    const started = performance.now();
    schemas = loadSchemas(path.join(root, 'libraries'));
    console.log(`loaded schemas in ${(performance.now() - started).toFixed(0)} ms`);
  });

  it('loads the game schemas without problems', () => {
    expect(schemas.problems).toEqual([]);
    expect(Object.keys(schemas.schemas).sort()).toEqual(['aiscripts', 'md']);
  });

  for (const schema of scriptSchemas) {
    it(`reports nothing on any ${schema} file`, () => {
      const failures: string[] = [];
      const files = xmlFilesIn(path.join(root, schemaFolderName[schema]));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas });
        for (const diagnostic of analysis.diagnostics) {
          failures.push(
            `${path.basename(file)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message} [${diagnostic.code}]`
          );
        }
      }
      expect(failures).toEqual([]);
    }, 30_000);
  }

  it('validates all scripts quickly', () => {
    const texts = [...xmlFilesIn(path.join(root, 'md')), ...xmlFilesIn(path.join(root, 'aiscripts'))].map((file) => readFileSync(file, 'utf8'));
    const started = performance.now();
    let slowest = 0;
    for (const text of texts) {
      const fileStarted = performance.now();
      analyzeText(text, { schemas });
      slowest = Math.max(slowest, performance.now() - fileStarted);
    }
    const elapsed = performance.now() - started;
    console.log(`validated ${texts.length} files in ${elapsed.toFixed(0)} ms, slowest ${slowest.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(15000);
  });
});
