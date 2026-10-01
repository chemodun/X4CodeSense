# x4-catalog

Reads the catalogs of X4: Foundations (`.cat`/`.dat`) in place, without extracting them, and writes new ones. No dependencies. Used by the X4CodeSense language server, the X4CodeSense VS Code extension and the `x4-script-check` command line tool to read the game's files straight from an installed game.

```ts
import { Catalogs, extensionCatalogs, gameCatalogs } from 'x4-catalog';

const game = Catalogs.open(gameCatalogs('C:/Games/X4 Foundations'), { keep: (path) => path.startsWith('md/') });
console.log(game.list('md').files.length, 'Mission Director scripts');
const setup = game.readText('md/setup.xml');

const boron = Catalogs.open(extensionCatalogs('C:/Games/X4 Foundations/extensions/ego_dlc_boron'));
console.log(boron.entry('md/story_boron.xml')?.size);
```

## The format

A `.cat` file is text, one line per file: `path size time md5`, the time in seconds since 1970, the MD5 in hex. The path may hold spaces, so a line is read from the right. The bytes of the files are in the `.dat` file of the same name, back to back in the order of the lines. `*_sig.cat` and `*_sig.dat` hold signatures. The game opens its catalogs in the order of their names, and for a path listed by several, the later one wins.

- The game: `01.cat`, `02.cat`, … in its folder, see `gameCatalogs(folder)`.
- An extension's own files: `ext_01.cat`, `ext_02.cat`, … in its folder, paths relative to it, see `extensionCatalogs(folder)`.

## Reading

`Catalogs.open(catalogFiles, { keep })` opens the given `.cat` files in load order. A catalog without its `.dat` is skipped. Lines that are no entry are listed in `problems` and skipped.

`keep` limits the entries kept in memory. The others still count for the offsets. The game's catalogs list over 460,000 files, mostly voice and assets: keeping all of them takes about 85 MB, and keeping a few folders takes well under 1 MB.

Paths are case-insensitive and may use `/` or `\`.

- `entry(path)`, `has(path)`: the entry, with its size, time, MD5, catalog, `.dat` file and offset.
- `read(path)`, `readText(path)`: the bytes, or the text as UTF-8, read from the `.dat` file when asked for.
- `verify(path)`: whether the bytes match the MD5 of the catalog.
- `list(folder)`, `isFolder(folder)`: the files and folders directly in a folder, `''` being the root.
- `entries(folder?)`: the entries kept, all of them or those under a folder.

## Writing

`writeCatalog(catalogFile, files)` writes a `.cat` file and the `.dat` file beside it, from paths and bytes (or text, written as UTF-8), in the order given.

This package has no dependency on VS Code. Before 1.0 its API may change in any minor version.

Part of [X4CodeSense](https://github.com/chemodun/X4CodeSense). Apache License 2.0.
