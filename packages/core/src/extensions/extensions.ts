/**
 * Extensions and the order the game loads them in. An extension is a folder with a `content.xml` that
 * names its `id` and the `<dependency id="…">` extensions it needs; a dependency without an id
 * (`<dependency version="900"/>`) is the game version. A folder with `t`, `md` or `aiscripts` inside
 * counts as well, so a mod still being written is found before it has a `content.xml`. The game loads
 * an extension after the ones it depends on, so their texts and patches come first and the dependent's
 * win.
 *
 * A folder to look in may be laid out in any way a mod author works: a folder of extensions (the game's
 * `extensions` folder, a workspace with several mods), one extension (a workspace per mod), or a folder
 * holding an extension deeper down (a repository with `src/<mod>` or `extensions/<mod>`). Which folders
 * to look in is configuration: see the server's `x4CodeSense.extensionsFolder`.
 *
 * Where nothing orders two extensions, they keep the order they were found in: the game's bundled
 * extensions (the DLCs) first, then each folder's extensions by path. That is the order to keep for
 * such ties; it only matters when two unrelated extensions change the same thing.
 *
 * The bundled extensions are the folders in the game folder's `extensions`; for an installed game, whose
 * `extensions` holds the player's mods as well, its file source names them (its DLCs).
 */
import * as path from 'node:path';
import { diskFiles, subfolderNames, type FileSource } from '../files/fileSource';
import { attributeNamed, parseXml } from '../xml/xmlStructure';

export interface ExtensionFolder {
  /** Absolute path of the extension. */
  folder: string;
  /** The `id` of its `content.xml`, or the folder name without one. */
  id: string;
  /** Ids of the extensions it depends on. */
  dependencies: string[];
  /** True for an extension shipped with the game, in the game's `extensions` folder. */
  bundled: boolean;
  /** True for a mod installed in the game, read because the extensions being written need it. */
  installed?: boolean;
}

/** How deep below a given folder extensions are looked for: `<folder>/src/<mod>` is two levels down. */
const searchDepth = 3;
/** Folders that never hold an extension a script refers to. */
const skippedFolders: ReadonlySet<string> = new Set(['node_modules', 'out', 'dist']);

function subfolders(files: FileSource, folder: string): string[] {
  return subfolderNames(files, folder)
    .filter((name) => !name.startsWith('.') && !skippedFolders.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(folder, name));
}

/** True for a folder that is an extension: it has a `content.xml`, or a `t`, `md` or `aiscripts` folder. */
export function isExtensionFolder(folder: string, files: FileSource = diskFiles): boolean {
  return files.exists(path.join(folder, 'content.xml')) || ['t', 'md', 'aiscripts'].some((sub) => files.isDirectory(path.join(folder, sub)));
}

/** Reads the id and the dependencies of an extension folder from its `content.xml`, if it has one. */
export function readExtension(folder: string, bundled = false, files: FileSource = diskFiles): ExtensionFolder {
  const extension: ExtensionFolder = { folder: path.resolve(folder), id: path.basename(folder), dependencies: [], bundled };
  let text: string;
  try {
    text = files.readText(path.join(folder, 'content.xml'));
  } catch {
    return extension;
  }
  const root = parseXml(text).roots[0];
  if (!root || root.name !== 'content') {
    return extension;
  }
  const id = attributeNamed(root, 'id')?.value.trim();
  if (id) {
    extension.id = id;
  }
  for (const child of root.children) {
    const dependency = child.name === 'dependency' ? attributeNamed(child, 'id')?.value.trim() : undefined;
    if (dependency) {
      extension.dependencies.push(dependency);
    }
  }
  return extension;
}

/** Puts every extension after the ones it depends on, keeping the found order where nothing decides. */
export function inLoadOrder(extensions: readonly ExtensionFolder[]): ExtensionFolder[] {
  const byId = new Map<string, ExtensionFolder>();
  for (const extension of extensions) {
    const key = extension.id.toLowerCase();
    if (!byId.has(key)) {
      byId.set(key, extension);
    }
  }
  const ordered: ExtensionFolder[] = [];
  const state = new Map<ExtensionFolder, 'visiting' | 'done'>();
  const visit = (extension: ExtensionFolder): void => {
    if (state.has(extension)) {
      return;
    }
    state.set(extension, 'visiting');
    for (const id of extension.dependencies) {
      const dependency = byId.get(id.toLowerCase());
      // A dependency cycle is broken where it closes.
      if (dependency && state.get(dependency) !== 'visiting') {
        visit(dependency);
      }
    }
    state.set(extension, 'done');
    ordered.push(extension);
  };
  for (const extension of extensions) {
    visit(extension);
  }
  return ordered;
}

/** The folder itself when it is an extension, else the extensions it holds, not looking inside an extension. */
export function extensionsIn(folder: string, files: FileSource = diskFiles): string[] {
  const found: string[] = [];
  const search = (current: string, depth: number): void => {
    if (isExtensionFolder(current, files)) {
      found.push(current);
      return;
    }
    if (depth > 0) {
      for (const sub of subfolders(files, current)) {
        search(sub, depth - 1);
      }
    }
  };
  if (!files.isDirectory(folder)) {
    return found;
  }
  search(folder, searchDepth);
  return found;
}

/** The extensions that are part of the game: those its file source names, else every folder in its `extensions`. */
export function bundledExtensionsOf(gameFolder: string, files: FileSource = diskFiles): readonly string[] {
  return files.bundledExtensions ?? subfolders(files, path.join(gameFolder, 'extensions'));
}

/**
 * The mods installed in the game that the extensions need, and that are not among them: the ones they depend
 * on, and the ones whose files they patch (`extensions/<mod>/…` in an extension), with what those depend on
 * in turn. An extension of the same id or folder name among the given ones replaces the installed mod.
 */
function neededInstalledMods(extensions: readonly ExtensionFolder[], files: FileSource): ExtensionFolder[] {
  const mods = files.installedMods;
  if (!mods) {
    return [];
  }
  const known = new Set(extensions.flatMap((extension) => [extension.id.toLowerCase(), path.basename(extension.folder).toLowerCase()]));
  const wanted = extensions
    .filter((extension) => !extension.bundled)
    .flatMap((extension) => [...extension.dependencies, ...subfolderNames(files, path.join(extension.folder, 'extensions'))]);
  const needed: ExtensionFolder[] = [];
  for (let next = wanted.shift(); next !== undefined; next = wanted.shift()) {
    const mod = known.has(next.toLowerCase()) ? undefined : mods.find(next);
    if (!mod || known.has(mod.id.toLowerCase())) {
      continue;
    }
    known.add(mod.id.toLowerCase());
    known.add(path.basename(mod.folder).toLowerCase());
    needed.push({ ...mod, installed: true });
    wanted.push(...mod.dependencies);
  }
  return needed;
}

/**
 * The extensions of a game installation and of other folders, each once, in load order, with the mods
 * installed in the game that they need when the file source reads those. The game's own folder is never one
 * of them, even when a workspace is opened on it.
 */
export function findExtensions(gameFolder: string | undefined, extensionFolders: readonly string[] = [], files: FileSource = diskFiles): ExtensionFolder[] {
  const found: ExtensionFolder[] = [];
  const seen = new Set<string>();
  if (gameFolder) {
    seen.add(path.resolve(gameFolder).toLowerCase());
  }
  const add = (folder: string, bundled: boolean): void => {
    const key = path.resolve(folder).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(readExtension(folder, bundled, files));
    }
  };
  if (gameFolder) {
    for (const folder of bundledExtensionsOf(gameFolder, files)) {
      add(folder, true);
    }
  }
  for (const folder of extensionFolders) {
    for (const extension of extensionsIn(folder, files)) {
      add(extension, false);
    }
  }
  for (const mod of neededInstalledMods(found, files)) {
    const key = mod.folder.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(mod);
    }
  }
  return inLoadOrder(found);
}
