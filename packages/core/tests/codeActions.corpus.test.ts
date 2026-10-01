/**
 * Corpus gate for the quick fixes, over every script and patch of the extracted game with its DLCs
 * (X4_EXTRACTED) and of a folder of extensions (X4_MODS), never committed: every fix offered for a
 * finding, applied, removes that finding and brings no new one to its line. A required attribute is
 * added empty, to be filled in, so its empty value may be reported; a cue is created empty, so the
 * variables read on it may be reported as never set there. A fix that changes another file only (a cue
 * created in another script, a parameter declared where the call's target is) is left to the unit tests.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData, quickFixes, type AnalysisContext, type DocumentAnalysis } from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

const lineOf = (analysis: DocumentAnalysis, line: number): string[] =>
  analysis.diagnostics.filter((diagnostic) => diagnostic.range.start.line === line).map((diagnostic) => `${String(diagnostic.code)}|${diagnostic.message}`);

describe.skipIf(!extracted)('quick fixes on the corpus', { timeout: 300_000 }, () => {
  const game = loadGameData(extracted ?? '', { extensionFolders: mods ? [mods] : [], index: true });
  const context: AnalysisContext = { schemas: game.schemas, properties: game.properties, texts: game.texts };
  if (game.index) {
    context.index = game.index;
  }

  it('fixes each finding it offers a fix for, and only that', () => {
    const problems: string[] = [];
    const counts = { files: 0, findings: 0, withFix: 0, fixes: 0 };
    let slowest = { ms: 0, analysis: undefined as DocumentAnalysis | undefined, diagnostic: undefined as Diagnostic | undefined };
    for (const entry of game.index?.entries() ?? []) {
      const text = readFileSync(entry.file, 'utf8');
      const uri = pathToFileURL(entry.file).toString();
      const analysis = analyzeText(text, context, uri);
      counts.files++;
      for (const diagnostic of analysis.diagnostics) {
        counts.findings++;
        const started = performance.now();
        const actions = quickFixes(analysis, [diagnostic], game);
        const ms = performance.now() - started;
        if (ms > slowest.ms) {
          slowest = { ms, analysis, diagnostic };
        }
        if (actions.length > 0) {
          counts.withFix++;
        }
        const line = diagnostic.range.start.line;
        const finding = `${String(diagnostic.code)}|${diagnostic.message}`;
        const before = lineOf(analysis, line);
        for (const action of actions) {
          const edits = action.edit?.changes?.[uri];
          if (!edits) {
            continue;
          }
          counts.fixes++;
          const after = analyzeText(TextDocument.applyEdits(analysis.document, edits), context, uri);
          const now = lineOf(after, line);
          const still = now.filter((item) => item === finding).length >= before.filter((item) => item === finding).length;
          const created = /^Create (?:cue|library) '([^']+)'$/.exec(action.title)?.[1];
          const expected = (item: string): boolean =>
            (diagnostic.code === 'missing-required-attribute' && item.startsWith("invalid-attribute-value|Invalid value ''")) ||
            (created !== undefined && item.startsWith('variable-undefined|') && item.endsWith(` in cue '${created}'`));
          const added = now.filter((item) => !before.includes(item) && !expected(item));
          if (still || added.length > 0) {
            problems.push(
              `${path.basename(entry.file)}:${line + 1} ${diagnostic.message} -> ${action.title}: ${still ? 'still there' : ''} ${added.join('; ')}`
            );
          }
        }
      }
    }
    const { analysis, diagnostic } = slowest;
    const best = analysis && diagnostic ? bestOf(5, () => quickFixes(analysis, [diagnostic], game)) : 0;
    console.log(
      `quick fixes: ${counts.files} files, ${counts.findings} findings, ${counts.withFix} with a fix, ${counts.fixes} fixes applied; slowest request ${best.toFixed(1)} ms best of 5`
    );
    expect(counts.files).toBeGreaterThan(600);
    expect(counts.withFix).toBeGreaterThan(0);
    expect(problems).toEqual([]);
    expect(best).toBeLessThan(fileCeilingMs);
  });
});
