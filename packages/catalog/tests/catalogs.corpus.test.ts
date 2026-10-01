/**
 * Corpus gate on an installed game (X4_GAME, never committed): its catalogs and those of its DLCs open without a
 * line that is no entry, every file of the script folders has the bytes its MD5 gives, and, with the extracted game
 * (X4_EXTRACTED) at hand, every such file the extraction has from the same build (the same time) has the same bytes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Catalogs, extensionCatalogs, gameCatalogs } from '../src';

const game = process.env.X4_GAME;
const extracted = process.env.X4_EXTRACTED;
const scriptFolders = (file: string): boolean => /^(md|aiscripts|libraries|t)\//i.test(file);

interface Opened {
  /** Where the catalogs' paths start: the game folder or a DLC folder. */
  readonly folder: string;
  /** The same folder in the extraction. */
  readonly extractedFolder: string | undefined;
  readonly catalogs: Catalogs;
  readonly milliseconds: number;
}

function opened(folder: string, catalogFiles: string[], extractedFolder: string | undefined): Opened {
  const started = performance.now();
  const catalogs = Catalogs.open(catalogFiles, { keep: scriptFolders });
  return { folder, extractedFolder, catalogs, milliseconds: performance.now() - started };
}

describe.skipIf(!game)('the catalogs of the installed game', { timeout: 120_000 }, () => {
  const root = game ?? '';
  let all: Opened[] = [];

  beforeAll(() => {
    const extensions = path.join(root, 'extensions');
    const dlcs = existsSync(extensions)
      ? readdirSync(extensions)
          .filter((name) => name.toLowerCase().startsWith('ego_dlc_'))
          .sort()
      : [];
    all = [opened(root, gameCatalogs(root), extracted)];
    for (const dlc of dlcs) {
      const folder = path.join(extensions, dlc);
      all.push(opened(folder, extensionCatalogs(folder), extracted && path.join(extracted, 'extensions', dlc)));
    }
    for (const { folder, catalogs, milliseconds } of all) {
      console.log(`${path.basename(folder)}: ${catalogs.catalogs.length} catalogs, ${catalogs.size} files kept in ${milliseconds.toFixed(0)} ms`);
    }
  });

  it('opens the game catalogs quickly, every line an entry', () => {
    const [base, ...dlcs] = all;
    expect(base.catalogs.catalogs.length).toBeGreaterThan(0);
    const folders = base.catalogs.list('').folders.map((name) => name.toLowerCase());
    expect(folders.sort()).toEqual(['aiscripts', 'libraries', 'md', 't']);
    expect(base.milliseconds).toBeLessThan(1000);
    for (const opened of all) {
      expect(opened.catalogs.problems).toEqual([]);
    }
    for (const dlc of dlcs) {
      expect(dlc.catalogs.catalogs.length).toBeGreaterThan(0);
    }
  });

  it('reads every file of the script folders with the bytes its MD5 gives', () => {
    const wrong: string[] = [];
    let files = 0;
    for (const { folder, catalogs } of all) {
      for (const entry of catalogs.entries()) {
        files++;
        if (!catalogs.verify(entry.path)) {
          wrong.push(path.join(folder, entry.path));
        }
      }
    }
    console.log(`verified ${files} files`);
    expect(files).toBeGreaterThan(500);
    expect(wrong).toEqual([]);
  });

  it.skipIf(!extracted)('gives the bytes of the extraction for every file of the same build', () => {
    const differ: string[] = [];
    let same = 0;
    let otherBuild = 0;
    let notExtracted = 0;
    for (const { extractedFolder, catalogs } of all) {
      for (const entry of catalogs.entries()) {
        const file = path.join(extractedFolder ?? '', entry.path);
        if (!existsSync(file)) {
          notExtracted++;
          continue;
        }
        if (Math.floor(statSync(file).mtimeMs / 1000) !== entry.time) {
          otherBuild++;
          continue;
        }
        if (Buffer.compare(readFileSync(file), catalogs.read(entry.path)!) === 0) {
          same++;
        } else {
          differ.push(file);
        }
      }
    }
    console.log(`the same as extracted: ${same}; of another build: ${otherBuild}; not extracted: ${notExtracted}`);
    expect(same).toBeGreaterThan(500);
    expect(differ).toEqual([]);
  });
});
