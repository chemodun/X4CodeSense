/**
 * The mods installed in a game's `extensions` folder, those that are not part of the game (its DLCs), read
 * in place when the extensions being written need them: the ones they depend on, and the ones whose files
 * their patches change. A packed mod is read from its catalogs as the game reads them: `ext_01.cat`, …, for
 * the game's version also `ext_NN_diff_vNNN.cat` and `ext_vNNN.cat`; an entry of its catalogs wins over a
 * loose file of the same path. `subst_*.cat` stand in for other files than scripts, texts and libraries,
 * and are not read. A mod of the same id among the extensions being written replaces the installed one.
 */
import * as path from 'node:path';
import { Catalogs, extensionCatalogs, type CatalogProblem } from 'x4-catalog';
import { readExtension, type ExtensionFolder } from '../extensions/extensions';
import { diskFiles, subfolderNames, withoutByteOrderMark, type FileSource, type FolderEntry, type InstalledMods } from './fileSource';

/** The folders the analysis reads; the catalogs keep only their files. */
const readFolders = /^(md|aiscripts|libraries|t)\//i;

/** The extensions of an installed game that are part of it, its DLCs, by the start of their folder names. */
export const dlcPrefix = 'ego_dlc_';

/** The text of `version.dat` in the game folder, undefined without it. */
export function gameVersionIn(folder: string, files: FileSource = diskFiles): string | undefined {
  try {
    return files.readText(path.join(folder, 'version.dat')).trim() || undefined;
  } catch {
    return undefined;
  }
}

class ModFiles implements FileSource {
  readonly installedMods: InstalledMods;
  private readonly extensions: string;
  /** The catalogs of each packed mod by its folder name in lower case, opened when first read; null for a loose one. */
  private readonly catalogs = new Map<string, Catalogs | null>();
  private readonly catalogProblems: string[] = [];

  constructor(
    folder: string,
    names: boolean,
    private readonly base: FileSource
  ) {
    const game = path.resolve(folder);
    this.extensions = path.join(game, 'extensions');
    const version = gameVersionIn(game, base);
    const mods = subfolderNames(base, this.extensions)
      .filter((name) => !name.toLowerCase().startsWith(dlcPrefix))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => readExtension(path.join(this.extensions, name), false, base));
    const byName = new Map<string, ExtensionFolder>();
    for (const mod of mods) {
      byName.set(path.basename(mod.folder).toLowerCase(), mod);
    }
    for (const mod of mods) {
      if (!byName.has(mod.id.toLowerCase())) {
        byName.set(mod.id.toLowerCase(), mod);
      }
    }
    this.installedMods = { folder: game, version, names, mods, find: (name) => byName.get(name.toLowerCase()) };
  }

  /** The base's problems, and those of the catalogs read so far. */
  get problems(): readonly string[] {
    return [...(this.base.problems ?? []), ...this.catalogProblems];
  }

  get bundledExtensions(): readonly string[] | undefined {
    return this.base.bundledExtensions;
  }

  /** The catalogs of the installed mod a path is in, and the path in them; undefined outside a packed mod. */
  private locate(file: string): { catalogs: Catalogs; inner: string } | undefined {
    const relative = path.relative(this.extensions, path.resolve(file));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }
    const [mod, ...rest] = relative.split(/[\\/]+/);
    const key = mod.toLowerCase();
    if (key.startsWith(dlcPrefix)) {
      return undefined;
    }
    let catalogs = this.catalogs.get(key);
    if (catalogs === undefined) {
      const files = extensionCatalogs(path.join(this.extensions, mod), this.installedMods.version);
      catalogs = files.length > 0 ? Catalogs.open(files, { keep: (entry) => readFolders.test(entry) }) : null;
      this.catalogs.set(key, catalogs);
      const problemText = (problem: CatalogProblem): string => `${problem.catalog}:${problem.line}: not a catalog entry: ${problem.text}`;
      this.catalogProblems.push(...(catalogs?.problems.map(problemText) ?? []));
    }
    return catalogs ? { catalogs, inner: rest.join('/') } : undefined;
  }

  inCatalogs(file: string): boolean {
    const at = this.locate(file);
    return (at !== undefined && at.inner !== '' && at.catalogs.has(at.inner)) || (this.base.inCatalogs?.(file) ?? false);
  }

  readText(file: string): string {
    const at = this.locate(file);
    const text = at && at.inner !== '' ? at.catalogs.readText(at.inner) : undefined;
    return text !== undefined ? withoutByteOrderMark(text) : this.base.readText(file);
  }

  exists(file: string): boolean {
    const at = this.locate(file);
    return (at !== undefined && at.inner !== '' && (at.catalogs.has(at.inner) || at.catalogs.isFolder(at.inner))) || this.base.exists(file);
  }

  isDirectory(file: string): boolean {
    const at = this.locate(file);
    return (at !== undefined && at.inner !== '' && at.catalogs.isFolder(at.inner)) || this.base.isDirectory(file);
  }

  list(folder: string): FolderEntry[] {
    const at = this.locate(folder);
    if (!at) {
      return this.base.list(folder);
    }
    const listed = at.catalogs.list(at.inner);
    const entries: FolderEntry[] = [...listed.folders.map((name) => ({ name, directory: true })), ...listed.files.map((name) => ({ name, directory: false }))];
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
    return [...entries, ...this.base.list(folder).filter((entry) => !names.has(entry.name.toLowerCase()))];
  }
}

/**
 * The files of `base` and the mods installed in the game folder's `extensions`. `names`: whether the
 * scripts and texts of the installed mods the extensions depend on count for names, or only for patches.
 */
export function withInstalledMods(gameFolder: string, base: FileSource = diskFiles, names = false): FileSource {
  return new ModFiles(gameFolder, names, base);
}
