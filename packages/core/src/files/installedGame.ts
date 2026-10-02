/**
 * An installed game read in place: its own files and those of its DLCs come from their catalogs
 * (`01.cat` … in the game folder, `ext_01.cat` … in a DLC's folder), nothing is extracted. Paths are
 * the ones the files would have if extracted, so everything that works with an extracted game works the
 * same. Only the folders the analysis reads are kept from the catalogs: `md`, `aiscripts`, `libraries`
 * and `t`; the game reads no loose files of its own folder, so there they come from the catalogs only.
 * Everything else, a DLC's `content.xml`, the extensions in the game's `extensions` folder that are no
 * DLC, any other folder, is read from the disk.
 */
import * as path from 'node:path';
import { Catalogs, extensionCatalogs, gameCatalogs, type CatalogProblem } from 'x4-catalog';
import { diskFiles, subfolderNames, withoutByteOrderMark, type FileSource, type FolderEntry } from './fileSource';

/** The folders of the game the analysis reads; the catalogs keep only their files (they list over 460,000). */
const readFolders = /^(md|aiscripts|libraries|t)\//i;

/** The extensions of an installed game that are part of it, its DLCs, by the start of their folder names (Chem's decision, 4bm). */
const dlcPrefix = 'ego_dlc_';

export interface InstalledGame extends FileSource {
  /** The game folder, the one holding `01.cat`. */
  readonly folder: string;
  /** The game's version as its `version.dat` gives it, `900` for 9.00; undefined without that file. */
  readonly version: string | undefined;
  readonly bundledExtensions: readonly string[];
  inCatalogs(file: string): boolean;
  readonly problems: readonly string[];
}

/** Whether a folder is an installed game: it holds the game's catalogs. */
export function isInstalledGame(folder: string): boolean {
  return gameCatalogs(folder).length > 0;
}

interface Located {
  catalogs: Catalogs;
  /** The path in the catalogs, `''` for the folder they belong to. */
  inner: string;
  /** In a DLC's folder, where loose files are read as well. */
  loose: boolean;
}

/** The text of `version.dat` in the game folder, undefined without it. */
function versionIn(folder: string, disk: FileSource): string | undefined {
  try {
    return disk.readText(path.join(folder, 'version.dat')).trim() || undefined;
  } catch {
    return undefined;
  }
}

class CatalogGame implements InstalledGame {
  readonly folder: string;
  readonly version: string | undefined;
  readonly bundledExtensions: readonly string[];
  readonly problems: readonly string[];
  private readonly base: Catalogs;
  /** The catalogs of each DLC, by its folder name in lower case. */
  private readonly dlcs = new Map<string, Catalogs>();

  constructor(
    folder: string,
    private readonly disk: FileSource
  ) {
    this.folder = path.resolve(folder);
    this.version = versionIn(this.folder, disk);
    const keep = (file: string): boolean => readFolders.test(file);
    const catalogFiles = gameCatalogs(this.folder);
    this.base = Catalogs.open(catalogFiles, { keep });
    const extensions = path.join(this.folder, 'extensions');
    const dlcFolders = subfolderNames(disk, extensions)
      .filter((name) => name.toLowerCase().startsWith(dlcPrefix))
      .sort()
      .map((name) => path.join(extensions, name));
    for (const dlc of dlcFolders) {
      this.dlcs.set(path.basename(dlc).toLowerCase(), Catalogs.open(extensionCatalogs(dlc), { keep }));
    }
    this.bundledExtensions = dlcFolders;
    const problemText = (problem: CatalogProblem): string => `${problem.catalog}:${problem.line}: not a catalog entry: ${problem.text}`;
    const notInstalled = catalogFiles.length === 0 ? [`${this.folder}: not an installed game, it has no 01.cat`] : [];
    this.problems = [...notInstalled, ...[this.base, ...this.dlcs.values()].flatMap((catalogs) => catalogs.problems.map(problemText))];
  }

  /** The catalogs a path belongs to, and the path in them; undefined outside the game and its DLCs. */
  private locate(file: string): Located | undefined {
    const relative = path.relative(this.folder, path.resolve(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }
    const parts = relative === '' ? [] : relative.split(/[\\/]+/);
    if (parts.length > 0 && parts[0].toLowerCase() === 'extensions') {
      const catalogs = parts.length > 1 ? this.dlcs.get(parts[1].toLowerCase()) : undefined;
      return catalogs && { catalogs, inner: parts.slice(2).join('/'), loose: true };
    }
    return { catalogs: this.base, inner: parts.join('/'), loose: false };
  }

  /** Whether only the catalogs answer for a path: the game's own read folders. */
  private onlyCatalogs(at: Located): boolean {
    return !at.loose && readFolders.test(`${at.inner}/`);
  }

  inCatalogs(file: string): boolean {
    const at = this.locate(file);
    return at !== undefined && at.inner !== '' && at.catalogs.has(at.inner);
  }

  readText(file: string): string {
    const at = this.locate(file);
    if (at && at.inner !== '') {
      const text = at.catalogs.readText(at.inner);
      if (text !== undefined) {
        return withoutByteOrderMark(text);
      }
      if (this.onlyCatalogs(at)) {
        throw new Error(`${file}: not in the game's catalogs`);
      }
    }
    return this.disk.readText(file);
  }

  exists(file: string): boolean {
    const at = this.locate(file);
    if (at && at.inner !== '') {
      if (at.catalogs.has(at.inner) || at.catalogs.isFolder(at.inner)) {
        return true;
      }
      if (this.onlyCatalogs(at)) {
        return false;
      }
    }
    return this.disk.exists(file);
  }

  isDirectory(file: string): boolean {
    const at = this.locate(file);
    if (at && at.inner !== '') {
      if (at.catalogs.isFolder(at.inner)) {
        return true;
      }
      if (this.onlyCatalogs(at)) {
        return false;
      }
    }
    return this.disk.isDirectory(file);
  }

  list(folder: string): FolderEntry[] {
    const at = this.locate(folder);
    if (!at) {
      return this.disk.list(folder);
    }
    const listed = at.catalogs.list(at.inner);
    const entries: FolderEntry[] = [...listed.folders.map((name) => ({ name, directory: true })), ...listed.files.map((name) => ({ name, directory: false }))];
    if (at.inner !== '' && this.onlyCatalogs(at)) {
      return entries;
    }
    // The game folder, a DLC's folders and the others: the disk's entries as well, those of the catalogs first.
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
    return [...entries, ...this.disk.list(folder).filter((entry) => !names.has(entry.name.toLowerCase()))];
  }
}

/** Opens an installed game: its catalogs and those of its DLCs, keeping the folders the analysis reads. */
export function openInstalledGame(folder: string, disk: FileSource = diskFiles): InstalledGame {
  return new CatalogGame(folder, disk);
}
