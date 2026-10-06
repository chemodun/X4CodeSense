import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { writeCatalog } from 'x4-catalog';
import { checkFile, diskFiles, findExtensions, loadGameData, withInstalledMods, type AnalysisContext, type GameData } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));

const root = mkdtempSync(path.join(tmpdir(), 'x4codesense-mods-'));
// An installed game with mods; its game files come from the extracted fixture, as with both settings set.
const install = path.join(root, 'X4 Foundations');
const installed = (...parts: string[]): string => path.join(install, 'extensions', ...parts);
// The extensions being written.
const workspace = path.join(root, 'workspace');
const local = (...parts: string[]): string => path.join(workspace, ...parts);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const content = (id: string, dependencies: string[] = []): string =>
  `<content id="${id}" name="${id}">${dependencies.map((dependency) => `<dependency id="${dependency}"/>`).join('')}</content>`;
const script = (name: string, cue: string): string => `<mdscript name="${name}"><cues><cue name="${cue}"><actions/></cue></cues></mdscript>`;

write(path.join(install, 'version.dat'), '900');
mkdirSync(path.join(install, 'extensions'), { recursive: true });
// A packed mod: its scripts and texts in ext_01.cat; a loose copy of a script the catalog has, which loses;
// catalogs for versions: the 9.00 ones count, the 8.00 one does not.
write(installed('api_mod', 'content.xml'), content('ws_api', ['deep_mod']));
writeCatalog(installed('api_mod', 'ext_01.cat'), [
  { path: 'md/api.xml', data: script('Api', 'Hello') },
  { path: 'md/versioned.xml', data: script('Versioned', 'Numbered') },
  { path: 'md/diffed.xml', data: script('Diffed', 'Numbered') },
  { path: 't/0001-l044.xml', data: '<language id="44"><page id="9001"><t id="1">From the API</t></page></language>' },
  { path: 'libraries/wares.xml', data: '<diff><add sel="/wares"><ware id="api_ware"/></add></diff>' },
]);
write(installed('api_mod', 'md', 'api.xml'), script('Api', 'LooseLoses'));
writeCatalog(installed('api_mod', 'ext_01_diff_v800.cat'), [{ path: 'md/diffed.xml', data: script('Diffed', 'Up to 800') }]);
writeCatalog(installed('api_mod', 'ext_01_diff_v950.cat'), [{ path: 'md/diffed.xml', data: script('Diffed', 'From 950') }]);
writeCatalog(installed('api_mod', 'ext_v800.cat'), [{ path: 'md/versioned.xml', data: script('Versioned', 'For800') }]);
writeCatalog(installed('api_mod', 'ext_v900.cat'), [{ path: 'md/versioned.xml', data: script('Versioned', 'For900') }]);
// What the packed mod depends on, loose: needed through it.
write(installed('deep_mod', 'content.xml'), content('deep_mod'));
write(installed('deep_mod', 'md', 'deep.xml'), script('Deep', 'Below'));
// A mod nothing needs, an installed copy of a mod being written, and a DLC: none of them is read as installed.
write(installed('unrelated', 'content.xml'), content('unrelated'));
write(installed('unrelated', 'md', 'other.xml'), script('Unrelated', 'Elsewhere'));
write(installed('shared', 'content.xml'), content('shared'));
write(installed('shared', 'md', 'shared.xml'), script('Shared', 'Installed'));
write(installed('ego_dlc_x', 'content.xml'), content('ego_dlc_x'));

// The extension being written: it depends on the packed mod and on a mod it has a copy of, patches the
// packed mod's script and library, and uses the packed mod's cue and text.
write(local('my_ext', 'content.xml'), content('my_ext', ['ws_api', 'shared']));
write(
  local('my_ext', 'md', 'main.xml'),
  '<mdscript name="Main"><cues><cue name="Start"><actions><signal_cue_instantly cue="md.Api.Hello"/><set_value name="$t" exact="{9001, 1}"/></actions></cue></cues></mdscript>'
);
write(
  local('my_ext', 'extensions', 'api_mod', 'md', 'api.xml'),
  `<diff><add sel="//cue[@name='Hello']/actions"><set_value name="$x" exact="1"/></add><remove sel="//cue[@name='NoSuchCue']"/></diff>`
);
write(local('my_ext', 'libraries', 'wares.xml'), '<diff><add sel="/wares"><ware id="my_ware"/></add></diff>');
write(local('shared', 'content.xml'), content('shared'));
write(local('shared', 'md', 'shared.xml'), script('Shared', 'Local'));

function gameWith(names: boolean): GameData {
  return loadGameData(unpacked, { files: withInstalledMods(install, diskFiles, names), extensionFolders: [workspace], index: true });
}

function findings(game: GameData, file: string): string[] {
  const context: AnalysisContext = { schemas: game.schemas, texts: game.texts };
  if (game.index) {
    context.index = game.index;
  }
  if (game.properties) {
    context.properties = game.properties;
  }
  return checkFile(file, 'md', context, game).findings.map((finding) => `${finding.code}: ${finding.message}`);
}

describe('mods installed in the game', () => {
  const files = withInstalledMods(install);

  it('reads a packed mod from its catalogs, an entry before a loose file, the versioned ones of the game version', () => {
    expect(files.installedMods?.version).toBe('900');
    expect(files.readText(installed('api_mod', 'md', 'api.xml'))).toContain('Hello');
    expect(files.inCatalogs?.(installed('api_mod', 'md', 'api.xml'))).toBe(true);
    // ext_v900 after the numbered ones; ext_v800 is for 8.00 only.
    expect(files.readText(installed('api_mod', 'md', 'versioned.xml'))).toContain('For900');
    // ext_01_diff_v800 counts on 9.00, ext_01_diff_v950 does not yet.
    expect(files.readText(installed('api_mod', 'md', 'diffed.xml'))).toContain('Up to 800');
    expect(
      files
        .list(installed('api_mod', 'md'))
        .map((entry) => entry.name)
        .sort()
    ).toEqual(['api.xml', 'diffed.xml', 'versioned.xml']);
    // The loose mods and the content.xml of a packed one come from the disk.
    expect(files.readText(installed('deep_mod', 'md', 'deep.xml'))).toContain('Below');
    expect(files.inCatalogs?.(installed('deep_mod', 'md', 'deep.xml'))).toBe(false);
  });

  it('adds the installed mods the extensions need, with what those need, in load order; a local copy wins', () => {
    const found = findExtensions(unpacked, [workspace], files);
    // my_ext's dependencies before it, in the order it names them: ws_api after its own, then shared.
    expect(found.map((extension) => `${extension.id}${extension.installed ? ' (installed)' : ''}`)).toEqual([
      'deep_mod (installed)',
      'ws_api (installed)',
      'shared',
      'my_ext',
    ]);
    expect(found.find((extension) => extension.id === 'shared')?.folder).toBe(local('shared'));
  });

  it('reads them for the patches only: the file a patch changes, and the patches before it', () => {
    const game = gameWith(false);
    const patch = local('my_ext', 'extensions', 'api_mod', 'md', 'api.xml');
    expect(game.index?.patchTarget(patch)?.file).toBe(installed('api_mod', 'md', 'api.xml'));
    expect(findings(game, patch)).toEqual(["patch-no-match: No matching node in extensions/api_mod/md/api.xml: 'cue[@name='NoSuchCue']' selects nothing"]);
    // The packed mod's library patch loads before the extension's.
    const library = local('my_ext', 'libraries', 'wares.xml');
    const target = game.index?.patchTarget(library)?.file ?? '';
    expect(game.index?.patchesBefore(library, target).map((earlier) => earlier.source)).toEqual(['ws_api']);
    // Their names and texts do not count.
    expect(findings(game, local('my_ext', 'md', 'main.xml')).map((finding) => finding.split(':')[0])).toEqual(['cue-undefined', 'text-undefined']);
  });

  it('with their names, resolves the cues and texts of the mods the extensions depend on', () => {
    const game = gameWith(true);
    expect(findings(game, local('my_ext', 'md', 'main.xml'))).toEqual([]);
    expect(game.texts.pick(9001, 1, '44')?.text).toBe('From the API');
    // A mod nothing needs is not read.
    expect(game.index?.scriptOf(installed('unrelated', 'md', 'other.xml'))).toBeUndefined();
  });

  it('reads no installed mods without the extensions needing them, nor without a game folder holding them', () => {
    expect(findExtensions(unpacked, [local('shared')], files).map((extension) => extension.id)).toEqual(['shared']);
    expect(findExtensions(unpacked, [workspace]).some((extension) => extension.installed)).toBe(false);
  });
});
