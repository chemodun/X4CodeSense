/**
 * Where the game data and the scripts are read from. The disk for an extracted game and for extensions;
 * an installed game reads its own files from its catalogs (`installedGame.ts`). Paths are absolute in both:
 * a file of an installed game has the path it would have if it were extracted (`<game>/md/setup.xml`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { ExtensionFolder } from '../extensions/extensions';

/** A file or folder in a folder. */
export interface FolderEntry {
  name: string;
  directory: boolean;
}

export interface FileSource {
  /**
   * Reads a file as UTF-8 without a byte order mark, as an editor gives its text, so positions agree with
   * the editor's; throws when it cannot be read, as `readFileSync` does.
   */
  readText(file: string): string;
  /** Whether a file or folder is there. */
  exists(file: string): boolean;
  isDirectory(file: string): boolean;
  /** What a folder holds, in no particular order; empty when it is no folder or cannot be read. */
  list(folder: string): FolderEntry[];
  /**
   * For an installed game: the folders of the extensions that are part of it, its DLCs. Without it, every
   * folder in the game folder's `extensions` is one, as in an extracted game.
   */
  readonly bundledExtensions?: readonly string[];
  /** For an installed game: whether a file is read from its catalogs, so there is no such file on the disk to change. */
  inCatalogs?(file: string): boolean;
  /** Problems met while opening it, for logging. */
  readonly problems?: readonly string[];
  /** The mods installed in the game, read when the extensions being written need them (`installedMods.ts`). */
  readonly installedMods?: InstalledMods;
}

/** The mods installed in a game's `extensions` folder that are not part of the game. */
export interface InstalledMods {
  /** The game folder, the one holding `extensions`. */
  readonly folder: string;
  /** The game's version as its `version.dat` gives it, `900` for 9.00; the versioned catalogs need it. */
  readonly version: string | undefined;
  /** Whether the scripts and texts of the installed mods count for names, or only for patches. */
  readonly names: boolean;
  /** The installed mods, in the order of their folder names. */
  readonly mods: readonly ExtensionFolder[];
  /** An installed mod by its id or its folder name, without case. */
  find(name: string): ExtensionFolder | undefined;
}

function isDirectoryOnDisk(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** A text without the byte order mark it may start with. */
export function withoutByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The files on the disk. */
export const diskFiles: FileSource = {
  readText: (file) => withoutByteOrderMark(readFileSync(file, 'utf8')),
  exists: (file) => existsSync(file),
  isDirectory: isDirectoryOnDisk,
  list: (folder) => {
    try {
      return readdirSync(folder, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        // A linked folder (mod managers link extensions into the game's folder) is a folder as well.
        directory: entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryOnDisk(path.join(folder, entry.name))),
      }));
    } catch {
      return [];
    }
  },
};

/** The names of the folders in a folder. */
export function subfolderNames(files: FileSource, folder: string): string[] {
  return files
    .list(folder)
    .filter((entry) => entry.directory)
    .map((entry) => entry.name);
}

/** The names of the files in a folder. */
export function fileNames(files: FileSource, folder: string): string[] {
  return files
    .list(folder)
    .filter((entry) => !entry.directory)
    .map((entry) => entry.name);
}
