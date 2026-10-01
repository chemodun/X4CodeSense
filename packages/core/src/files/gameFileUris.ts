/**
 * The documents of the game's files that have no file on disk, those read from an installed game's
 * catalogs: `x4codesense-game:/md/setup.xml`, the path the file would have in the game folder if extracted.
 */
import * as path from 'node:path';
import { gameFileScheme } from '../protocol';

/** The path of a file inside a folder, `''` for the folder itself; undefined outside it. */
function relativeInside(folder: string, file: string): string | undefined {
  const relative = path.relative(path.resolve(folder), path.resolve(file));
  return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : relative;
}

/** The game document of a file in the game folder; undefined for the folder itself or a file outside it. */
export function gameFileUri(gameFolder: string, file: string): string | undefined {
  const relative = relativeInside(gameFolder, file);
  if (!relative) {
    return undefined;
  }
  const parts = relative.split(/[\\/]+/).map(encodeURIComponent);
  return `${gameFileScheme}:/${parts.join('/')}`;
}

/** The file in the game folder a game document stands for; undefined for any other uri, or a path that leaves the folder. */
export function gameFileOf(gameFolder: string, uri: string): string | undefined {
  if (!uri.startsWith(`${gameFileScheme}:`)) {
    return undefined;
  }
  let parts: string[];
  try {
    parts = decodeURIComponent(new URL(uri).pathname)
      .split('/')
      .filter((part) => part !== '');
  } catch {
    return undefined;
  }
  const file = path.resolve(gameFolder, ...parts);
  return relativeInside(gameFolder, file) ? file : undefined;
}
