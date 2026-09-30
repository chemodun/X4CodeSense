/**
 * Corpus gate for texts in Lua files, over the Lua files of the extracted game (X4_EXTRACTED) and of a
 * folder of extensions (X4_MODS), never committed: every string and comment closes and every call of
 * `ReadText` has its `)`, the tokens in order and apart; every call of the game with two numbers names a
 * text of the game but for the known ones; the calls of the largest game file are found under the file
 * ceiling.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTexts, missingTextMessage, readTextCalls, scanLua, type ReadTextCall } from '../src';
import { bestOf, fileCeilingMs } from './timing';

const extracted = process.env.X4_EXTRACTED;
const mods = process.env.X4_MODS;

/** Texts the game's own Lua reads that no text file of the game defines, with the reason. */
const knownMissing = [
  // The "Venture Team Info" and "Send Team Invitation" buttons of the ventures, which the game no longer has texts for.
  '{50101, 11824} (helper.lua)',
  '{50101, 11827} (helper.lua)',
];

/**
 * The Lua files under the folders, `.xpl` ones included: the game loads those as Lua too. Dot folders
 * (`.git`) and `node_modules` are left out: listing them takes ten times as long as all the rest. Links
 * are not followed, so a linked folder is not read twice and cannot make a loop.
 */
function luaFiles(...folders: string[]): string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        walk(path.join(folder, entry.name));
      } else if (entry.isFile() && /\.(lua|xpl)$/i.test(entry.name)) {
        found.push(path.join(folder, entry.name));
      }
    }
  };
  folders.filter((folder) => existsSync(folder)).forEach(walk);
  return found;
}

/** The calls of one file, and the problems of its scan and calls as `file: problem`. */
function checked(file: string, text: string): { calls: ReadTextCall[]; problems: string[] } {
  const where = path.basename(file);
  const scanned = scanLua(text);
  const problems = scanned.unclosed.map((unclosed) => `${where}: an unclosed ${unclosed.kind} at ${unclosed.start}`);
  let end = 0;
  for (const token of scanned.tokens) {
    if (token.start < end || token.end <= token.start) {
      problems.push(`${where}: a token out of order at ${token.start}`);
    }
    end = token.end;
  }
  const calls = readTextCalls(text, scanned);
  for (const call of calls) {
    if (!call.closed) {
      problems.push(`${where}: a call without ')' at ${call.start}`);
    }
  }
  return { calls, problems };
}

describe.skipIf(!extracted)('ReadText in the Lua files of the corpus', { timeout: 120_000 }, () => {
  const root = extracted ?? '';
  const gameFiles = luaFiles(path.join(root, 'ui'), path.join(root, 'extensions'));

  it('scans every Lua file of the game and of the extensions, every string, comment and call closed', () => {
    const problems: string[] = [];
    for (const [name, files] of [
      ['game', gameFiles],
      ['extensions', mods ? luaFiles(mods) : []],
    ] as const) {
      let calls = 0;
      let known = 0;
      let throughNames = 0;
      for (const file of files) {
        const found = checked(file, readFileSync(file, 'utf8'));
        problems.push(...found.problems);
        for (const call of found.calls) {
          calls++;
          if (call.page.value !== undefined && call.id.value !== undefined) {
            known++;
            throughNames += call.page.constant || call.id.constant ? 1 : 0;
          }
        }
      }
      console.log(
        `ReadText in the Lua files of the ${name}: ${files.length} files, ${calls} calls, ${known} with page and id known, ${throughNames} of them through names`
      );
    }
    expect(gameFiles.length).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  });

  it('names a text of the game with every call of the game with page and id known, but for the known ones', () => {
    const texts = loadTexts(root);
    const missing: string[] = [];
    for (const file of gameFiles) {
      for (const call of readTextCalls(readFileSync(file, 'utf8'))) {
        const [page, id] = [call.page.value, call.id.value];
        if (page !== undefined && id !== undefined && missingTextMessage(texts, page, id)) {
          missing.push(`{${page}, ${id}} (${path.basename(file)})`);
        }
      }
    }
    expect(missing).toEqual(knownMissing);
  });

  it('finds the calls of the largest Lua file of the game under the file ceiling', () => {
    const largest = gameFiles.map((file) => readFileSync(file, 'utf8')).reduce((a, b) => (b.length > a.length ? b : a), '');
    const best = bestOf(5, () => readTextCalls(largest));
    console.log(
      `ReadText calls of the largest Lua file of the game (${largest.length} characters): best of 5 ${best.toFixed(1)} ms, ceiling ${fileCeilingMs} ms`
    );
    expect(best).toBeLessThan(fileCeilingMs);
  });
});
