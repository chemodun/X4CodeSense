/**
 * The game and the extensions the tools answer from. They are loaded as the checker loads them, and kept
 * up to date with the extensions' files on disk, which an agent changes between its calls: watchers of
 * the extension folders name the files changed, and a call first reads those again.
 */
import { statSync, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import {
  diskFiles,
  isInside,
  isInstalledGame,
  languageOfTextFile,
  loadGameData,
  openInstalledGame,
  scriptFolders,
  textFolders,
  xmlFilesOf,
  type AnalysisContext,
  type FileSource,
  type GameData,
} from 'x4-script-core';

export interface WorkspaceOptions {
  /** The extracted game files, whose `libraries` folder holds the schemas. */
  unpacked?: string;
  /** The installed game, read from its catalogs when no extracted files are given. */
  game?: string;
  /** The folders of the extensions written and of those they refer to: each an extension or a folder of extensions. */
  extensions: string[];
  /** The language number texts are shown in first. */
  language: string;
  /** Check the order and completeness of child elements. */
  structure: boolean;
  /** Guess what actions write into variables from their names and documentation. */
  typeGuesses: boolean;
}

/** A file as last read: its path, and its modification time and size. */
interface Stamp {
  file: string;
  stamp: string;
}

/** A path as the sets of this module hold it. */
function keyOf(file: string): string {
  return path.resolve(file).toLowerCase();
}

export class Workspace {
  /** Undefined without game files, or when they could not be read. */
  game: GameData | undefined;
  context: AnalysisContext = {};
  /** The extension folders, resolved. */
  readonly extensionFolders: string[];
  /** What went wrong reading the game and the extensions. */
  problems: string[] = [];
  /** How long the last full load took, in milliseconds. */
  loadTime = 0;
  private loaded = false;
  /** The script and text folders of the extensions, as last read; when they change, everything is read again. */
  private layout = '';
  /** The extensions' script and text folders, by key, whose XML files are read again when they change. */
  private watchedFolders = new Map<string, string>();
  /** The files of those folders, by key, with their modification time and size when last read. */
  private stamps = new Map<string, Stamp>();
  private watchers: FSWatcher[] = [];
  /** What the watchers reported since the last call; `all` when they could not say, or there are none. */
  private changed: Set<string> | 'all' = 'all';

  constructor(readonly options: WorkspaceOptions) {
    this.extensionFolders = options.extensions.map((folder) => path.resolve(folder));
  }

  /** The game folder, when one is given. */
  get gameFolder(): string | undefined {
    const folder = this.options.unpacked ?? this.options.game;
    return folder === undefined ? undefined : path.resolve(folder);
  }

  /** Reads the game and the extensions on the first call, what changed in the extensions on the others. */
  current(): void {
    if (this.loaded) {
      this.refresh();
    } else {
      this.load();
    }
  }

  /** Stops watching. */
  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.changed = 'all';
  }

  /** Reads the game and the extensions. */
  load(): void {
    const started = performance.now();
    this.loaded = true;
    this.game = undefined;
    this.problems = [];
    this.context = { validateStructure: this.options.structure, guessVariableTypes: this.options.typeGuesses };
    this.layout = '';
    this.watchedFolders = new Map();
    this.stamps = new Map();
    const gameFolder = this.gameFolder;
    let files: FileSource = diskFiles;
    if (this.options.unpacked !== undefined && gameFolder !== undefined) {
      const libraries = path.join(gameFolder, 'libraries');
      if (!diskFiles.isDirectory(libraries)) {
        this.problems.push(`Not a folder: ${libraries}`);
        return;
      }
    } else if (gameFolder !== undefined) {
      if (!isInstalledGame(gameFolder)) {
        this.problems.push(`Not an installed game, it has no 01.cat: ${gameFolder}`);
        return;
      }
      files = openInstalledGame(gameFolder);
    }
    for (const folder of this.extensionFolders) {
      if (!diskFiles.isDirectory(folder)) {
        this.problems.push(`Not a folder: ${folder}`);
      }
    }
    if (gameFolder === undefined) {
      return;
    }
    // Before reading: what changes meanwhile is read again on the next call.
    this.watch();
    const game = loadGameData(gameFolder, { files, extensionFolders: this.extensionFolders, index: true });
    this.problems.push(...game.problems);
    if (Object.keys(game.schemas.schemas).length === 0) {
      return;
    }
    this.game = game;
    this.context.schemas = game.schemas;
    this.context.texts = game.texts;
    if (game.index) {
      this.context.index = game.index;
    }
    if (game.properties) {
      this.context.properties = game.properties;
    }
    this.layout = this.currentLayout(game);
    this.watchedFolders = this.foldersToWatch(game);
    this.stamps = this.currentStamps();
    this.loadTime = performance.now() - started;
  }

  /** Watches the extension folders, once; without watchers every call looks at every file. */
  private watch(): void {
    if (this.watchers.length > 0) {
      return;
    }
    this.changed = new Set();
    for (const folder of this.extensionFolders) {
      try {
        const watcher = watch(folder, { recursive: true }, (_event, name) => {
          if (name === null) {
            this.changed = 'all';
          } else if (this.changed !== 'all') {
            this.changed.add(path.join(folder, name.toString()));
          }
        });
        watcher.on('error', () => {
          this.changed = 'all';
        });
        // The server ends when its client goes; a watcher does not keep it.
        watcher.unref();
        this.watchers.push(watcher);
      } catch {
        this.dispose();
        return;
      }
    }
  }

  /**
   * Reads what changed in the extensions since the last call: the XML files of their script and text
   * folders the watchers named; every file when they named a folder that came or went, a `content.xml`,
   * or nothing usable; and everything when the extensions' folders changed, an extension added or its
   * `content.xml` naming other dependencies.
   */
  refresh(): void {
    const game = this.game;
    const changed = this.watchers.length > 0 ? this.changed : 'all';
    if (!game || (changed !== 'all' && changed.size === 0)) {
      return;
    }
    this.changed = this.watchers.length > 0 ? new Set() : 'all';
    if (changed !== 'all' && [...changed].every((file) => this.affectsFilesOnly(file))) {
      this.touch(changed);
      return;
    }
    if (this.currentLayout(game) !== this.layout) {
      this.load();
      return;
    }
    const current = this.currentStamps();
    for (const [key, { file, stamp }] of current) {
      if (this.stamps.get(key)?.stamp !== stamp) {
        this.reread(game, file, true);
      }
    }
    for (const [key, { file }] of this.stamps) {
      if (!current.has(key)) {
        this.reread(game, file, false);
      }
    }
    this.stamps = current;
  }

  /**
   * Reads the XML files of the watched folders among these again, those changed, created or deleted since
   * they were last read. A call does so for the files it names: they are current even before a watcher
   * tells of them.
   */
  touch(files: Iterable<string>): void {
    const game = this.game;
    if (!game) {
      return;
    }
    for (const given of files) {
      const file = path.resolve(given);
      const key = keyOf(file);
      if (!this.watchedFolders.has(keyOf(path.dirname(file))) || !key.endsWith('.xml')) {
        continue;
      }
      const stamp = stampOf(file);
      if (stamp === this.stamps.get(key)?.stamp) {
        continue;
      }
      this.reread(game, file, stamp !== undefined);
      if (stamp === undefined) {
        this.stamps.delete(key);
      } else {
        this.stamps.set(key, { file, stamp });
      }
    }
  }

  /**
   * True when a path a watcher named changes no more than a file: an XML file, but no `content.xml`; a
   * file of another kind; a watched folder still there, whose entries changed. A folder that came or went
   * may be an extension or a script folder, and a path that is gone may have been one.
   */
  private affectsFilesOnly(file: string): boolean {
    // Hidden folders, `.git` and others, hold nothing the game reads.
    const root = this.extensionFolders.find((folder) => isInside(file, folder));
    const segments = root === undefined ? [] : path.relative(root, file).split(path.sep);
    if (segments.some((segment) => segment.startsWith('.'))) {
      return true;
    }
    const name = path.basename(file).toLowerCase();
    if (name.endsWith('.xml')) {
      return name !== 'content.xml';
    }
    try {
      return statSync(file).isFile() || this.watchedFolders.has(keyOf(file));
    } catch {
      return false;
    }
  }

  /** The folders whose files are watched, the extensions' own: the game's and its DLCs' do not change. */
  private foldersToWatch(game: GameData): Map<string, string> {
    const scripts = scriptFolders(game.folder, this.extensionFolders, game.files)
      .filter((folder) => folder.source !== 'game' && !folder.bundled)
      .map((folder) => folder.folder);
    const texts = textFolders(game.folder, this.extensionFolders, game.files).filter((folder) =>
      this.extensionFolders.some((extensions) => isInside(folder, extensions))
    );
    return new Map([...scripts, ...texts].map((folder) => [keyOf(folder), folder]));
  }

  private currentLayout(game: GameData): string {
    return JSON.stringify([scriptFolders(game.folder, this.extensionFolders, game.files), textFolders(game.folder, this.extensionFolders, game.files)]);
  }

  /** The XML files of the watched folders on disk, by key, with their modification time and size. */
  private currentStamps(): Map<string, Stamp> {
    const stamps = new Map<string, Stamp>();
    for (const folder of this.watchedFolders.values()) {
      for (const file of xmlFilesOf(diskFiles, folder)) {
        const stamp = stampOf(file);
        if (stamp !== undefined) {
          stamps.set(keyOf(file), { file: path.resolve(file), stamp });
        }
      }
    }
    return stamps;
  }

  /** Reads a file of the index or the texts again from disk, or forgets it. */
  private reread(game: GameData, file: string, exists: boolean): void {
    let text: string | undefined;
    try {
      text = exists ? diskFiles.readText(file) : undefined;
    } catch {
      text = undefined;
    }
    const isText = languageOfTextFile(path.basename(file)) !== undefined && path.basename(path.dirname(file)).toLowerCase() === 't';
    if (isText) {
      if (text === undefined) {
        game.texts.removeFile(file);
      } else {
        game.texts.setFile(file, text);
      }
    }
    const source = game.index?.sourceOf(file);
    if (game.index && source !== undefined) {
      if (text === undefined) {
        game.index.removeFile(file);
      } else {
        game.index.setText(file, text, source);
      }
    }
  }
}

/** A file's modification time and size; undefined when it is gone. */
function stampOf(file: string): string | undefined {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}
