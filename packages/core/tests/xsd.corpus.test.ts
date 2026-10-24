/**
 * Corpus gate for schema validation against the extracted vanilla game (X4_EXTRACTED, never committed):
 * the real schemas must load cleanly and no vanilla script, nor library file of a schema, may produce a
 * single diagnostic.
 * Any hit is a bug in the engine or a gap in the model, never something to suppress.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyzeText, loadSchemas, parseXml, scriptSchemas, schemaFolderName, validateStructure, type SchemaSet } from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;

function xmlFilesIn(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.xml'))
    .map((name) => path.join(folder, name));
}

/** The folders of a kind of script in the DLCs of the extraction, which the game loads as its own. */
function dlcFoldersOf(root: string, folder: string): string[] {
  const extensions = path.join(root, 'extensions');
  return readdirSync(extensions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('ego_dlc_'))
    .map((entry) => path.join(extensions, entry.name, folder))
    .filter((dlcFolder) => {
      try {
        return readdirSync(dlcFolder).length > 0;
      } catch {
        return false;
      }
    });
}

// Whole-corpus runs share the machine with the other corpus gates: time is checked by the tests, not the runner.
describe.skipIf(!extracted)('schema validation on the vanilla corpus', { timeout: 60_000 }, () => {
  const root = extracted ?? '';
  let schemas: SchemaSet;
  // The DLCs' AI script folders hold patches only; their Mission Director folders scripts as well.
  let dlcScripts = 0;

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
    it(`reports nothing on any ${schema} file, the DLCs' too`, () => {
      const failures: string[] = [];
      const files = xmlFilesIn(path.join(root, schemaFolderName[schema]));
      const dlcFiles = dlcFoldersOf(root, schemaFolderName[schema]).flatMap(xmlFilesIn);
      expect(files.length).toBeGreaterThan(0);
      expect(dlcFiles.length).toBeGreaterThan(0);
      for (const file of [...files, ...dlcFiles]) {
        // The schema checks only: the name checks and the arguments of formats have their own gates with the known vanilla findings.
        const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas, validateNames: false, validateFormats: false });
        // The DLCs' patches have their own gate.
        if (analysis.detection.isDiff) {
          continue;
        }
        dlcScripts += dlcFiles.includes(file) ? 1 : 0;
        for (const diagnostic of analysis.diagnostics) {
          failures.push(
            `${path.relative(root, file)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message} [${diagnostic.code}]`
          );
        }
      }
      expect(failures).toEqual([]);
    }, 30_000);
  }

  it('loads every library schema without problems', () => {
    const names = readdirSync(path.join(root, 'libraries'))
      .filter((name) => name.endsWith('.xsd'))
      .map((name) => name.slice(0, -'.xsd'.length));
    const loaded = names.filter((name) => schemas.library(name));
    expect(names.filter((name) => !loaded.includes(name)).sort()).toEqual(['aiscripts', 'common', 'diff', 'md', 'scriptproperties']);
    expect(loaded.length).toBeGreaterThan(30);
    expect(schemas.problems).toEqual([]);
  });

  it("reports nothing on the library files that name their schema, and on the DLCs' files of their names", () => {
    const failures: string[] = [];
    const rootOf = (text: string) => parseXml(text, { stopAfterFirstStartTag: true }).roots[0];
    const schemaNameOf = (text: string): string | undefined => {
      const location = rootOf(text)?.attributes.find((attribute) => attribute.name === 'xsi:noNamespaceSchemaLocation');
      return location && /(?:^|\/)([\w.-]+)\.xsd$/i.exec(location.value)?.[1];
    };
    const gameSchemas = new Map<string, string>();
    const checked: string[] = [];
    const check = (file: string, text: string, schemaName: string): void => {
      const schema = schemas.library(schemaName);
      const structure = parseXml(text);
      const rootName = structure.roots[0]?.name;
      if (!schema || !rootName) {
        failures.push(`${path.relative(root, file)}: no schema '${schemaName}' or no root`);
        return;
      }
      checked.push(file);
      const document = TextDocument.create(pathToFileURL(file).href, 'xml', 1, text);
      for (const diagnostic of validateStructure(structure, schema, rootName, document, { checkContent: true, source: 'corpus' }).diagnostics) {
        failures.push(
          `${path.relative(root, file)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message} [${diagnostic.code}]`
        );
      }
    };
    for (const file of xmlFilesIn(path.join(root, 'libraries'))) {
      const text = readFileSync(file, 'utf8');
      const schemaName = schemaNameOf(text);
      if (schemaName && schemaName !== 'scriptproperties') {
        gameSchemas.set(path.basename(file).toLowerCase(), schemaName);
        check(file, text, schemaName);
      }
    }
    const games = checked.length;
    for (const file of dlcFoldersOf(root, 'libraries').flatMap(xmlFilesIn)) {
      const text = readFileSync(file, 'utf8');
      const schemaName = gameSchemas.get(path.basename(file).toLowerCase());
      // The patches have their own gate.
      if (schemaName && rootOf(text)?.name !== 'diff') {
        check(file, text, schemaName);
      }
    }
    console.log(`library files checked: ${games} of the game, ${checked.length - games} of the DLCs`);
    expect(games).toBeGreaterThan(40);
    expect(checked.length - games).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  }, 30_000);

  it('analyses the library files as the editor does: those that name their schema with no findings and quickly, the others not', () => {
    const failures: string[] = [];
    const files = [...xmlFilesIn(path.join(root, 'libraries')), ...dlcFoldersOf(root, 'libraries').flatMap(xmlFilesIn)];
    let analysed = 0;
    let largest: { file: string; text: string } | undefined;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const analysis = analyzeText(text, { schemas }, pathToFileURL(file).href);
      if (analysis.detection.isDiff) {
        continue;
      }
      if (!analysis.detection.library) {
        // No schema named on the root: other XML, as before (`wares.xml`, `scriptproperties.xml`, `component.xml`).
        if (analysis.structure || analysis.diagnostics.length > 0) {
          failures.push(`${path.relative(root, file)}: analysed without a schema`);
        }
        continue;
      }
      analysed++;
      if (!largest || text.length > largest.text.length) {
        largest = { file, text };
      }
      for (const diagnostic of analysis.diagnostics) {
        failures.push(
          `${path.relative(root, file)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message} [${diagnostic.code}]`
        );
      }
    }
    expect(failures).toEqual([]);
    expect(analysed).toBeGreaterThan(60);
    const slowest = largest as { file: string; text: string };
    const uri = pathToFileURL(slowest.file).href;
    const elapsed = bestOf(3, () => analyzeText(slowest.text, { schemas }, uri));
    console.log(`library files analysed: ${analysed}; largest ${path.relative(root, slowest.file)} in ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(fileCeilingMs);
  }, 60_000);

  it("has checked the DLCs' scripts", () => {
    expect(dlcScripts).toBeGreaterThan(0);
  });

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
