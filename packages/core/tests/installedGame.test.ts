import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { writeCatalog, type CatalogFile } from 'x4-catalog';
import {
  analyzeText,
  isGameFile,
  isInstalledGame,
  loadGameData,
  loadScriptIndex,
  loadTexts,
  openInstalledGame,
  scriptFolders,
  sourcesOf,
  type DocumentAnalysis,
  type GameData,
} from '../src';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
const unpacked = path.join(fixtures, 'unpacked');
const project = path.join(fixtures, 'project');

const root = mkdtempSync(path.join(tmpdir(), 'x4codesense-installed-'));
const install = path.join(root, 'X4 Foundations');
const dlc = path.join(install, 'extensions', 'ego_dlc_test');
const mod = path.join(install, 'extensions', 'my_mod');

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The files of a folder as catalog files, their paths starting with `prefix`. */
function filesOf(folder: string, prefix: string): CatalogFile[] {
  return readdirSync(folder).map((name) => ({ path: `${prefix}/${name}`, data: readFileSync(path.join(folder, name)) }));
}

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// The game: the fixture's libraries and texts in 01.cat, an old Setup there as well, the real one and the AI script in 02.cat.
mkdirSync(install, { recursive: true });
writeCatalog(path.join(install, '01.cat'), [
  ...filesOf(path.join(unpacked, 'libraries'), 'libraries'),
  ...filesOf(path.join(unpacked, 't'), 't'),
  { path: 'md/setup.xml', data: '<mdscript name="Old"/>' },
  { path: 'voice-l044/0001.ogg', data: 'not kept' },
]);
writeCatalog(path.join(install, '02.cat'), [
  ...filesOf(path.join(project, 'game', 'md'), 'md'),
  ...filesOf(path.join(project, 'game', 'aiscripts'), 'aiscripts'),
]);
appendFileSync(path.join(install, '02.cat'), 'no entry\n');
// A signature catalog, never read.
writeCatalog(path.join(install, '02_sig.cat'), [{ path: 'md/setup.xml', data: '<mdscript name="Signature"/>' }]);
// Loose files in the game folder: the game reads none of its own.
write(path.join(install, 't', '0001-l044.xml'), '<language id="44"><page id="1001"><t id="1">Loose</t></page></language>');
write(path.join(install, 'md', 'loose.xml'), '<mdscript name="Loose"/>');
write(path.join(install, 'version.dat'), '900');
// A DLC: its content.xml loose, its scripts in its catalog.
write(path.join(dlc, 'content.xml'), '<content id="ego_dlc_test" name="Test DLC"/>');
writeCatalog(path.join(dlc, 'ext_01.cat'), [{ path: 'md/dlc.xml', data: '<mdscript name="Dlc"><cues><cue name="Go"><actions/></cue></cues></mdscript>' }]);
// A mod of the player, loose in the game's extensions folder.
cpSync(path.join(project, 'mods', 'my_mod'), mod, { recursive: true });

const files = openInstalledGame(install);
const at = (...parts: string[]): string => path.join(install, ...parts);
const names = (folder: string): string[] =>
  files
    .list(folder)
    .map((entry) => `${entry.name}${entry.directory ? '/' : ''}`)
    .sort();

describe('an installed game read in place', () => {
  it('is told by its catalogs', () => {
    expect(isInstalledGame(install)).toBe(true);
    expect(isInstalledGame(unpacked)).toBe(false);
    expect(files.folder).toBe(path.resolve(install));
  });

  it("reads the game's files from its catalogs, the later catalog winning, never a signature", () => {
    expect(files.readText(at('md', 'setup.xml'))).toBe(readFileSync(path.join(project, 'game', 'md', 'setup.xml'), 'utf8'));
    expect(files.readText(at('libraries', 'md.xsd'))).toBe(readFileSync(path.join(unpacked, 'libraries', 'md.xsd'), 'utf8'));
    expect(files.inCatalogs(at('md', 'setup.xml'))).toBe(true);
    expect(files.isDirectory(at('libraries'))).toBe(true);
    expect(files.exists(at('aiscripts', 'lib.target.xml'))).toBe(true);
  });

  it('reads no loose file in the folders the catalogs hold, and only what the analysis reads', () => {
    expect(files.readText(at('t', '0001-l044.xml'))).toBe(readFileSync(path.join(unpacked, 't', '0001-l044.xml'), 'utf8'));
    expect(names(at('md'))).toEqual(['setup.xml']);
    expect(files.exists(at('md', 'loose.xml'))).toBe(false);
    expect(() => files.readText(at('md', 'loose.xml'))).toThrow(/not in the game's catalogs/);
    expect(files.exists(at('voice-l044', '0001.ogg'))).toBe(false);
  });

  it('reads everything else from the disk', () => {
    expect(files.readText(at('version.dat'))).toBe('900');
    expect(files.inCatalogs(at('version.dat'))).toBe(false);
    const catalogs = ['01.cat', '01.dat', '02.cat', '02.dat', '02_sig.cat', '02_sig.dat'];
    expect(names(install)).toEqual([...catalogs, 'aiscripts/', 'extensions/', 'libraries/', 'md/', 't/', 'version.dat']);
    expect(files.readText(path.join(mod, 'md', 'mine.xml'))).toBe(readFileSync(path.join(project, 'mods', 'my_mod', 'md', 'mine.xml'), 'utf8'));
    expect(files.inCatalogs(path.join(mod, 'md', 'mine.xml'))).toBe(false);
    expect(files.list(path.join(root, 'nowhere'))).toEqual([]);
  });

  it('takes the folders named ego_dlc_ as its DLCs, read from their catalogs and their loose files', () => {
    expect(files.bundledExtensions).toEqual([dlc]);
    expect(names(dlc)).toEqual(['content.xml', 'ext_01.cat', 'ext_01.dat', 'md/']);
    expect(files.readText(path.join(dlc, 'md', 'dlc.xml'))).toContain('name="Dlc"');
    expect(files.readText(path.join(dlc, 'content.xml'))).toContain('Test DLC');
    expect(files.inCatalogs(path.join(dlc, 'md', 'dlc.xml'))).toBe(true);
    expect(names(path.join(install, 'extensions'))).toEqual(['ego_dlc_test/', 'my_mod/']);
  });

  it('lists the lines of its catalogs that are no entry', () => {
    expect(files.problems).toEqual([`${path.join(install, '02.cat')}:3: not a catalog entry: no entry`]);
  });
});

describe('the game data of an installed game', () => {
  const extracted = loadGameData(unpacked);
  const installed = loadGameData(install, { files, index: true });

  it('is the game data of the extracted files', () => {
    expect(Object.keys(installed.schemas.schemas).sort()).toEqual(Object.keys(extracted.schemas.schemas).sort());
    expect(installed.schemas.diff).toBeDefined();
    expect(installed.properties).toBeDefined();
    expect(installed.files).toBe(files);
    expect(installed.texts.pages()).toEqual(loadTexts(unpacked).pages());
    expect(installed.texts.textCount).toBe(loadTexts(unpacked).textCount);
    expect(installed.texts.languageNames.get('49')).toBe('Deutsch');
    expect(installed.problems).toEqual([...files.problems, ...extracted.problems]);
  });

  it('indexes the scripts of the game and its DLCs, not the mods in its extensions folder', () => {
    const index = installed.index!;
    expect(index.scriptOf(at('md', 'setup.xml'))).toMatchObject({ name: 'Setup', source: 'game' });
    expect(index.scriptOf(at('aiscripts', 'lib.target.xml'))?.source).toBe('game');
    expect(index.scriptOf(path.join(dlc, 'md', 'dlc.xml'))).toMatchObject({ name: 'Dlc', source: 'ego_dlc_test' });
    expect(index.scriptOf(path.join(mod, 'md', 'mine.xml'))).toBeUndefined();
    expect(index.scriptOf(at('md', 'loose.xml'))).toBeUndefined();
  });

  it('reads the file a patch changes from the catalogs, and checks the patch as against the extracted game', () => {
    const withMods = loadGameData(install, { files, index: true, extensionFolders: [path.join(install, 'extensions')] });
    const patch = path.join(mod, 'md', 'setup.xml');
    expect(withMods.index?.patchTarget(patch)).toEqual({ file: at('md', 'setup.xml'), name: 'md/setup.xml' });
    expect(sourcesOf(scriptFolders(install, [path.join(install, 'extensions')], files))).toEqual({ dlcs: ['ego_dlc_test'], extensions: ['my_mod'] });

    const messages = (game: GameData, file: string): string[] => {
      const context = { schemas: game.schemas, properties: game.properties, texts: game.texts, index: game.index };
      const analysis: DocumentAnalysis = analyzeText(readFileSync(file, 'utf8'), context, pathToFileURL(file).toString());
      return analysis.diagnostics.map((diagnostic) => `${diagnostic.range.start.line}:${diagnostic.range.start.character} ${diagnostic.message}`);
    };
    const projectGame: GameData = { ...extracted, index: loadScriptIndex(path.join(project, 'game'), [path.join(project, 'mods')], extracted.schemas) };
    for (const name of ['setup.xml', 'mine.xml']) {
      expect(messages(withMods, path.join(mod, 'md', name))).toEqual(messages(projectGame, path.join(project, 'mods', 'my_mod', 'md', name)));
    }
  });

  it("tells the game's files from the mods in its extensions folder", () => {
    expect(isGameFile(at('md', 'setup.xml'), installed)).toBe(true);
    expect(isGameFile(path.join(dlc, 'md', 'dlc.xml'), installed)).toBe(true);
    expect(isGameFile(path.join(mod, 'md', 'mine.xml'), installed)).toBe(false);
    expect(isGameFile(path.join(install, 'extensions'), installed)).toBe(false);
    expect(isGameFile(path.join(root, 'elsewhere.xml'), installed)).toBe(false);
    expect(isGameFile(install, installed)).toBe(false);
    // In an extracted game every extension is one of its DLCs.
    expect(isGameFile(path.join(unpacked, 'extensions', 'any', 'md', 'a.xml'), extracted)).toBe(true);
  });
});
