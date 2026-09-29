/**
 * Corpus gate for the script properties against the extracted vanilla game (X4_EXTRACTED, never committed):
 * the real scriptproperties.xml and its imports must load cleanly, and the property chains written in
 * vanilla scripts must resolve against the model. Cross-file references (`md.Script.Cue`, cue names) are
 * not resolved yet, so the gate asks for a high share rather than all of them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeText, chainAtToken, isExpressionAttribute, loadGameData, resolveChain, tokenize, type GameData, type ScriptSchema } from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;

function xmlFilesIn(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.xml'))
    .map((name) => path.join(folder, name));
}

describe.skipIf(!extracted)('script properties on the vanilla corpus', () => {
  const root = extracted ?? '';
  let game: GameData;

  beforeAll(() => {
    const started = performance.now();
    game = loadGameData(root);
    console.log(`loaded game data in ${(performance.now() - started).toFixed(0)} ms`);
  });

  it('loads scriptproperties.xml and every import without problems', () => {
    expect(game.problems).toEqual([]);
    const properties = game.properties;
    expect(properties).toBeDefined();
    if (!properties) {
      return;
    }
    expect(properties.datatypes.size).toBeGreaterThan(150);
    expect(properties.keywords.length).toBeGreaterThan(80);
    expect(properties.keyword('class', 'md')?.properties.size).toBeGreaterThan(50);
    expect(properties.keyword('ware', 'md')?.properties.size).toBeGreaterThan(1000);
    expect(properties.keyword('this', 'md')?.typeName).toBe('cue');
    expect(properties.keyword('this', 'aiscripts')?.typeName).toBe('entity');
    expect(properties.keyword('inputfunction', 'md')?.properties.size).toBeGreaterThan(100);
  });

  it('resolves the keyword chains vanilla scripts use', () => {
    const properties = game.properties;
    expect(properties).toBeDefined();
    if (!properties) {
      return;
    }
    let chains = 0;
    let resolved = 0;
    const started = performance.now();
    for (const schema of ['md', 'aiscripts'] as ScriptSchema[]) {
      for (const file of xmlFilesIn(path.join(root, schema))) {
        const analysis = analyzeText(readFileSync(file, 'utf8'), { schemas: game.schemas });
        for (const element of analysis.structure?.elements ?? []) {
          const declaration = analysis.declarations.get(element);
          if (!declaration) {
            continue;
          }
          for (const attribute of element.attributes) {
            if (!isExpressionAttribute(declaration.attributes.get(attribute.name))) {
              continue;
            }
            const value = attribute.value;
            const tokens = tokenize(value);
            for (let index = 0; index + 2 < tokens.length; index++) {
              // A chain head: an identifier that is not preceded by a dot and is followed by `.name`.
              if (tokens[index].kind !== 'identifier' || (index > 0 && tokens[index - 1].kind === 'dot')) {
                continue;
              }
              if (tokens[index + 1].kind !== 'dot' || tokens[index + 2].kind !== 'identifier') {
                continue;
              }
              if (tokens[index].text === 'md') {
                continue;
              }
              const found = chainAtToken(value, tokens[index + 2].start);
              if (!found) {
                continue;
              }
              chains++;
              const chain = resolveChain(found.chain, properties, schema);
              const last = chain.steps[chain.steps.length - 1];
              if (chain.steps[0].keyword && (last.property || last.candidates)) {
                resolved++;
              }
            }
          }
        }
      }
    }
    const share = resolved / chains;
    console.log(`resolved ${resolved} of ${chains} two-step keyword chains (${(share * 100).toFixed(1)}%) in ${(performance.now() - started).toFixed(0)} ms`);
    expect(chains).toBeGreaterThan(10000);
    expect(share).toBeGreaterThan(0.85);
  }, 60_000);

  it('analyses the largest file with the script properties within the ceiling', () => {
    const texts = [...xmlFilesIn(path.join(root, 'md')), ...xmlFilesIn(path.join(root, 'aiscripts'))].map((file) => ({
      file,
      text: readFileSync(file, 'utf8'),
    }));
    const largest = texts.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const best = bestOf(10, () => analyzeText(largest.text, { schemas: game.schemas, properties: game.properties }));
    console.log(`${path.basename(largest.file)} (${largest.text.length} characters): best of 10 ${best.toFixed(1)} ms, ceiling ${fileCeilingMs} ms`);
    expect(best).toBeLessThan(fileCeilingMs);
  }, 60_000);
});
