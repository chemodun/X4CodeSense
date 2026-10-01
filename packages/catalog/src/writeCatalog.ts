import { createHash } from 'node:crypto';
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { dataFileOf } from './catalogs';

/** A file to write into a catalog. */
export interface CatalogFile {
  /** The path in the catalog (`md/setup.xml`); `\` is written as `/`. */
  readonly path: string;
  /** The bytes; a string is written as UTF-8. */
  readonly data: Buffer | string;
  /** Modification time, seconds since 1970; now when not given. */
  readonly time?: number;
}

/**
 * Writes a catalog and its `.dat` (the `.cat` path given, the `.dat` beside it): the files' bytes back to back,
 * one line `path size time md5` each, in the order given, as the game's catalogs are written.
 */
export function writeCatalog(catalogFile: string, files: Iterable<CatalogFile>): void {
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [];
  const handle = openSync(dataFileOf(catalogFile), 'w');
  try {
    for (const file of files) {
      const name = file.path.replace(/\\/g, '/');
      if (name.trim() === '' || /[\r\n]/.test(name)) {
        throw new Error(`Not a path a catalog can hold: '${name}'`);
      }
      const bytes = typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : file.data;
      let done = 0;
      while (done < bytes.length) {
        done += writeSync(handle, bytes, done, bytes.length - done);
      }
      lines.push(`${name} ${bytes.length} ${file.time ?? now} ${createHash('md5').update(bytes).digest('hex')}\n`);
    }
  } finally {
    closeSync(handle);
  }
  writeFileSync(catalogFile, lines.join(''));
}
