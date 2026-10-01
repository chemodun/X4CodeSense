import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extensionsIn, findExtensions, inLoadOrder, readExtension, type ExtensionFolder } from '../src';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
const patching = path.join(fixtures, 'patching');

const extension = (id: string, dependencies: string[] = []): ExtensionFolder => ({ folder: `/extensions/${id}`, id, dependencies, bundled: false });
const ids = (extensions: readonly ExtensionFolder[]): string[] => extensions.map((found) => found.id);

describe('extensions', () => {
  it('reads the id and the dependencies of content.xml', () => {
    expect(readExtension(path.join(patching, 'a_dependent'))).toMatchObject({ id: 'dependent', dependencies: ['ws_base', 'not_installed'], bundled: false });
    expect(readExtension(path.join(patching, 'z_base'), true)).toMatchObject({ id: 'ws_base', dependencies: [], bundled: true });
    expect(readExtension(path.join(fixtures, 'extensions', 'my_mod'))).toMatchObject({ id: 'my_mod', dependencies: [] });
  });

  it('loads every extension after the ones it depends on, and keeps the found order otherwise', () => {
    expect(ids(inLoadOrder([extension('a', ['b']), extension('b', ['c']), extension('c')]))).toEqual(['c', 'b', 'a']);
    expect(ids(inLoadOrder([extension('x'), extension('a', ['C']), extension('y'), extension('c')]))).toEqual(['x', 'c', 'a', 'y']);
    expect(ids(inLoadOrder([extension('a', ['missing']), extension('b')]))).toEqual(['a', 'b']);
    // A cycle is broken where it closes.
    expect(ids(inLoadOrder([extension('a', ['b']), extension('b', ['a'])]))).toEqual(['b', 'a']);
  });

  it('finds the game extensions first, then the extensions of each folder once', () => {
    expect(ids(findExtensions(undefined, [patching, path.join(patching, 'z_base')]))).toEqual(['ws_base', 'dependent']);
    const bundled = findExtensions(fixtures);
    expect(bundled.map((found) => [found.id, found.bundled])).toEqual([['my_mod', true]]);
    expect(findExtensions(path.join(fixtures, 'nowhere'), [path.join(fixtures, 'nowhere')])).toEqual([]);
  });
});

describe('workspace layouts', () => {
  let root: string;
  const at = (...parts: string[]): string => path.join(root, ...parts);
  const make = (...parts: string[]): void => {
    const file = at(...parts);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, parts[parts.length - 1] === 'content.xml' ? `<content id="${parts[parts.length - 2]}"/>` : '<language/>');
  };
  const relative = (folders: readonly string[]): string[] => folders.map((folder) => path.relative(root, folder).split(path.sep).join('/'));

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'x4codesense-layouts-'));
    // A folder of mods, one of them without content.xml yet.
    make('mods', 'first', 'content.xml');
    make('mods', 'second', 't', '0001-l044.xml');
    make('mods', 'notes', 'readme.txt');
    // A repository with its mod two levels down, and a dependency folder that must not count.
    make('repo', 'src', 'my_mod', 'content.xml');
    make('repo', 'src', 'my_mod', 'md', 'Script.xml');
    make('repo', 'node_modules', 'fake', 'content.xml');
    make('repo', '.git', 'fake', 'content.xml');
    // A game installation opened as a workspace.
    make('game', 't', '0001-l044.xml');
    make('game', 'extensions', 'ego_dlc_test', 'md', 'Dlc.xml');
    // A mod linked into a folder of mods, as modders and mod managers do (a junction needs no rights on Windows).
    make('elsewhere', 'linked_mod', 'content.xml');
    mkdirSync(at('links'));
    symlinkSync(at('elsewhere', 'linked_mod'), at('links', 'linked_mod'), 'junction');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the mods of a folder of mods, not the folder itself', () => {
    expect(relative(extensionsIn(at('mods')))).toEqual(['mods/first', 'mods/second']);
  });

  it('finds a mod linked into a folder of mods', () => {
    expect(relative(extensionsIn(at('links')))).toEqual(['links/linked_mod']);
  });

  it('finds one mod opened on its own, and a mod deeper in a repository', () => {
    expect(relative(extensionsIn(at('repo', 'src', 'my_mod')))).toEqual(['repo/src/my_mod']);
    expect(relative(extensionsIn(at('repo')))).toEqual(['repo/src/my_mod']);
  });

  it('does not guess upwards: a folder inside a mod names it through configuration, such as `..`', () => {
    expect(extensionsIn(at('repo', 'src', 'my_mod', 'md'))).toEqual([]);
    expect(extensionsIn(at('mods', 'notes'))).toEqual([]);
    expect(extensionsIn(at('nowhere'))).toEqual([]);
  });

  it('never counts the game itself as an extension', () => {
    const found = findExtensions(at('game'), [at('game'), at('mods')]);
    expect(found.map((extension) => [extension.id, extension.bundled])).toEqual([
      ['ego_dlc_test', true],
      ['first', false],
      ['second', false],
    ]);
  });
});
