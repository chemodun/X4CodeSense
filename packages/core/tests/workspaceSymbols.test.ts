import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SymbolKind, type WorkspaceSymbol } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import { loadScriptIndex, workspaceSymbols } from '../src';

const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const gameFolder = path.join(project, 'game');
const modsFolder = path.join(project, 'mods');
const index = loadScriptIndex(gameFolder, [modsFolder]);

/** `name [container]` per symbol, in the order given. */
const shown = (symbols: readonly WorkspaceSymbol[]): string[] => symbols.map((symbol) => `${symbol.name} [${symbol.containerName}]`);

/** The text at a symbol's range, read from its file. */
function textAt(symbol: WorkspaceSymbol): string {
  const location = symbol.location as { uri: string; range: Parameters<TextDocument['getText']>[0] };
  const file = fileURLToPath(location.uri);
  return TextDocument.create(location.uri, 'xml', 0, readFileSync(file, 'utf8')).getText(location.range);
}

describe('workspace symbols', () => {
  it('names the scripts, cues, libraries and interrupt library items of the index, where they are defined', () => {
    const all = workspaceSymbols(index, '');
    expect(shown(all).sort()).toEqual(
      [
        'Added [md.Setup (game, added by my_mod)]',
        'CheckTarget [lib.target (game)]',
        'Inner [md.Setup (game)]',
        'Mine [my_mod]',
        'Own [md.Mine (my_mod)]',
        'Reward [md.Setup (game)]',
        'Setup [game]',
        'Start [md.Setup (game)]',
        'TargetConditions [lib.target (game)]',
        'TargetInvalidHandler [lib.target (game)]',
        'lib.target [game]',
        'order.mine [my_mod]',
      ].sort()
    );
    const kinds = new Map(all.map((symbol) => [symbol.name, symbol.kind]));
    expect(['Setup', 'Start', 'Reward', 'CheckTarget', 'TargetConditions', 'TargetInvalidHandler'].map((name) => kinds.get(name))).toEqual([
      SymbolKind.Module,
      SymbolKind.Event,
      SymbolKind.Function,
      SymbolKind.Function,
      SymbolKind.Function,
      SymbolKind.Event,
    ]);
    // Each range covers the name where it is defined: the cue a patch adds lies in the patch.
    expect(all.map(textAt)).toEqual(all.map((symbol) => symbol.name));
    const added = all.find((symbol) => symbol.name === 'Added');
    expect(fileURLToPath((added?.location as { uri: string }).uri)).toBe(path.join(modsFolder, 'my_mod', 'md', 'setup.xml'));
  });

  it('matches the query in order without case, whole names first, then prefixes, then names containing it', () => {
    expect(shown(workspaceSymbols(index, 'in'))).toEqual([
      'Inner [md.Setup (game)]',
      'Mine [my_mod]',
      'order.mine [my_mod]',
      'TargetInvalidHandler [lib.target (game)]',
      // Only as characters in order: i...n.
      'TargetConditions [lib.target (game)]',
    ]);
    expect(shown(workspaceSymbols(index, 'START'))).toEqual(['Start [md.Setup (game)]']);
    // Characters in order, not side by side.
    expect(workspaceSymbols(index, 'chtg').map((symbol) => symbol.name)).toEqual(['CheckTarget']);
    expect(workspaceSymbols(index, 'xyz')).toEqual([]);
  });

  it('matches a query with a dot against the name as other scripts write it', () => {
    expect(shown(workspaceSymbols(index, 'md.setup.start'))).toEqual(['Start [md.Setup (game)]']);
    // The script itself, then its cues by length and name.
    expect(workspaceSymbols(index, 'md.setup').map((symbol) => symbol.name)).toEqual(['Setup', 'Added', 'Inner', 'Start', 'Reward']);
    expect(workspaceSymbols(index, 'lib.target.check').map((symbol) => symbol.name)).toEqual(['CheckTarget']);
  });

  it('puts the workspace before the game among equal matches, and gives no more than the limit', () => {
    const preferred = workspaceSymbols(index, '', { preferredFolders: [path.join(modsFolder, 'my_mod')] });
    expect(preferred.slice(0, 4).map((symbol) => symbol.name)).toEqual(['Own', 'Mine', 'Added', 'order.mine']);
    expect(workspaceSymbols(index, '', { limit: 2 })).toHaveLength(2);
  });

  describe('while typing', () => {
    it('names what the open document has so far, a name being typed as far as it goes', () => {
      const copy = loadScriptIndex(gameFolder, [modsFolder]);
      const file = path.join(modsFolder, 'my_mod', 'md', 'mine.xml');
      copy.setText(file, '<mdscript name="Mine">\n  <cues>\n    <cue name="Half">\n      <cue name="Typ', 'my_mod');
      expect(shown(workspaceSymbols(copy, 'half').concat(workspaceSymbols(copy, 'typ')))).toEqual(['Half [md.Mine (my_mod)]', 'Typ [md.Mine (my_mod)]']);
      expect(workspaceSymbols(copy, 'own')).toEqual([]);
      copy.setText(file, '<mdscript name="Mine', 'my_mod');
      expect(() => workspaceSymbols(copy, '')).not.toThrow();
    });
  });
});
