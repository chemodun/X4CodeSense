import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { catalogKey, Catalogs, catalogsIn, extensionCatalogs, gameCatalogs, readEntry, writeCatalog } from '../src';

const root = mkdtempSync(path.join(tmpdir(), 'x4-catalog-'));
let folders = 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A new empty folder under the test root. */
function folder(): string {
  const created = path.join(root, `f${++folders}`);
  mkdirSync(created);
  return created;
}

describe('writing and reading a catalog', () => {
  const at = folder();
  const catalog = path.join(at, '01.cat');
  writeCatalog(catalog, [
    { path: 'md/setup.xml', data: '<mdscript name="Setup"/>', time: 1700000000 },
    { path: 'aiscripts\\order.trade.xml', data: Buffer.from('<aiscript/>'), time: 1700000001 },
    { path: 'libraries/my file.xml', data: 'spaced', time: 1700000002 },
    { path: 't/0001-l044.xml', data: 'Grüße', time: 1700000003 },
  ]);
  const catalogs = Catalogs.open([catalog]);

  it('writes one line per file and the bytes back to back', () => {
    const lines = readFileSync(catalog, 'utf8').split('\n');
    expect(lines[0]).toBe(`md/setup.xml 24 1700000000 ${createHash('md5').update('<mdscript name="Setup"/>').digest('hex')}`);
    expect(lines[1].startsWith('aiscripts/order.trade.xml 11 1700000001 ')).toBe(true);
    expect(lines[2].startsWith('libraries/my file.xml 6 1700000002 ')).toBe(true);
    expect(lines.length).toBe(5);
    expect(lines[4]).toBe('');
    expect(readFileSync(path.join(at, '01.dat'), 'utf8')).toBe('<mdscript name="Setup"/><aiscript/>spacedGrüße');
  });

  it('finds every file with its size, time, offset and MD5', () => {
    expect(catalogs.size).toBe(4);
    expect(catalogs.catalogs).toEqual([catalog]);
    expect(catalogs.problems).toEqual([]);
    const entry = catalogs.entry('aiscripts/order.trade.xml');
    expect(entry).toMatchObject({ path: 'aiscripts/order.trade.xml', size: 11, time: 1700000001, offset: 24, catalog, data: path.join(at, '01.dat') });
    expect(entry?.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(catalogs.entry('t/0001-l044.xml')).toMatchObject({ size: Buffer.byteLength('Grüße'), offset: 24 + 11 + 6 });
  });

  it('reads the bytes and the text of a file', () => {
    expect(catalogs.readText('md/setup.xml')).toBe('<mdscript name="Setup"/>');
    expect(catalogs.read('aiscripts/order.trade.xml')?.toString()).toBe('<aiscript/>');
    expect(catalogs.readText('libraries/my file.xml')).toBe('spaced');
    expect(catalogs.readText('t/0001-l044.xml')).toBe('Grüße');
    expect(catalogs.read('md/absent.xml')).toBeUndefined();
  });

  it('takes paths in any case, with either slash and a leading ./ or /', () => {
    expect(catalogs.has('MD/Setup.XML')).toBe(true);
    expect(catalogs.readText('md\\setup.xml')).toBe('<mdscript name="Setup"/>');
    expect(catalogs.has('./md/setup.xml')).toBe(true);
    expect(catalogs.has('/md/setup.xml')).toBe(true);
    expect(catalogKey('.\\MD\\')).toBe('md');
    expect(catalogKey('.')).toBe('');
  });

  it('verifies the bytes against the MD5', () => {
    expect(catalogs.verify('md/setup.xml')).toBe(true);
    expect(catalogs.verify('t/0001-l044.xml')).toBe(true);
    expect(catalogs.verify('md/absent.xml')).toBe(false);
  });

  it('lists folders and files', () => {
    expect(catalogs.list('')).toEqual({ files: [], folders: ['aiscripts', 'libraries', 'md', 't'] });
    expect(catalogs.list('md')).toEqual({ files: ['setup.xml'], folders: [] });
    expect(catalogs.list('LIBRARIES/')).toEqual({ files: ['my file.xml'], folders: [] });
    expect(catalogs.list('absent')).toEqual({ files: [], folders: [] });
    expect(catalogs.isFolder('')).toBe(true);
    expect(catalogs.isFolder('Md')).toBe(true);
    expect(catalogs.isFolder('md/setup.xml')).toBe(false);
    expect(catalogs.isFolder('absent')).toBe(false);
  });

  it('gives the entries under a folder', () => {
    const paths = [...catalogs.entries()].map((entry) => entry.path);
    expect(paths).toEqual(['md/setup.xml', 'aiscripts/order.trade.xml', 'libraries/my file.xml', 't/0001-l044.xml']);
    expect([...catalogs.entries('md')].map((entry) => entry.path)).toEqual(['md/setup.xml']);
    expect([...catalogs.entries('m')]).toEqual([]);
  });
});

describe('catalogs in load order', () => {
  const at = folder();
  writeCatalog(path.join(at, '01.cat'), [
    { path: 'md/a.xml', data: 'first a' },
    { path: 'md/b.xml', data: 'first b' },
  ]);
  writeCatalog(path.join(at, '02.cat'), [
    { path: 'MD/A.xml', data: 'second a' },
    { path: 'md/c.xml', data: 'second c' },
  ]);
  const catalogs = Catalogs.open(gameCatalogs(at));

  it('lets the later catalog win for a path both list', () => {
    expect(catalogs.readText('md/a.xml')).toBe('second a');
    expect(catalogs.entry('md/a.xml')).toMatchObject({ path: 'MD/A.xml', catalog: path.join(at, '02.cat'), offset: 0 });
    expect(catalogs.readText('md/b.xml')).toBe('first b');
    expect(catalogs.readText('md/c.xml')).toBe('second c');
    expect(catalogs.size).toBe(3);
  });

  it('lists a folder once whatever case its files give it', () => {
    expect(catalogs.list('').folders).toEqual(['MD']);
    expect(catalogs.isFolder('md')).toBe(true);
    expect(catalogs.list('md').files).toEqual(['A.xml', 'b.xml', 'c.xml']);
  });

  it('lets a later line of the same catalog win and keeps the offsets after it', () => {
    const one = folder();
    writeCatalog(path.join(one, '01.cat'), [
      { path: 'x.xml', data: 'old' },
      { path: 'x.xml', data: 'newer' },
      { path: 'y.xml', data: 'why' },
    ]);
    const twice = Catalogs.open(gameCatalogs(one));
    expect(twice.readText('x.xml')).toBe('newer');
    expect(twice.readText('y.xml')).toBe('why');
  });
});

describe('what is kept and what is skipped', () => {
  it('keeps only the entries asked for and still counts the others for the offsets', () => {
    const at = folder();
    writeCatalog(path.join(at, '01.cat'), [
      { path: 'voice/a.ogg', data: 'x'.repeat(1000) },
      { path: 'md/kept.xml', data: 'kept' },
      { path: 'assets/b.xmf', data: 'y'.repeat(77) },
      { path: 'md/also.xml', data: 'also' },
    ]);
    const catalogs = Catalogs.open(gameCatalogs(at), { keep: (file) => file.startsWith('md/') });
    expect(catalogs.size).toBe(2);
    expect(catalogs.has('voice/a.ogg')).toBe(false);
    expect(catalogs.readText('md/kept.xml')).toBe('kept');
    expect(catalogs.readText('md/also.xml')).toBe('also');
    expect(catalogs.list('').folders).toEqual(['md']);
  });

  it('reads CRLF lines, skips blank lines, and lists lines that are no entry without counting them', () => {
    const at = folder();
    const md5 = '0123456789abcdef0123456789ABCDEF';
    writeFileSync(
      path.join(at, '01.cat'),
      [`md/a.xml 3 1 ${md5}`, '', '   ', 'no entry at all', `md/b.xml x 1 ${md5}`, `md/c.xml 2 1 ${md5.slice(1)}`, `md/d.xml 4 1 ${md5}`, ''].join('\r\n')
    );
    writeFileSync(path.join(at, '01.dat'), 'aaadddd');
    const catalogs = Catalogs.open(gameCatalogs(at));
    expect(catalogs.readText('md/a.xml')).toBe('aaa');
    expect(catalogs.readText('md/d.xml')).toBe('dddd');
    expect(catalogs.entry('md/d.xml')?.md5).toBe(md5.toLowerCase());
    expect(catalogs.problems).toEqual([
      { catalog: path.join(at, '01.cat'), line: 4, text: 'no entry at all' },
      { catalog: path.join(at, '01.cat'), line: 5, text: `md/b.xml x 1 ${md5}` },
      { catalog: path.join(at, '01.cat'), line: 6, text: `md/c.xml 2 1 ${md5.slice(1)}` },
    ]);
  });

  it('reads a last line without a newline', () => {
    const at = folder();
    writeFileSync(path.join(at, '01.cat'), `md/a.xml 3 1 ${'0'.repeat(32)}`);
    writeFileSync(path.join(at, '01.dat'), 'abc');
    expect(Catalogs.open(gameCatalogs(at)).readText('md/a.xml')).toBe('abc');
  });

  it('skips a catalog without its .dat', () => {
    const at = folder();
    writeCatalog(path.join(at, '01.cat'), [{ path: 'md/a.xml', data: 'a' }]);
    writeFileSync(path.join(at, '02.cat'), `md/a.xml 1 1 ${'0'.repeat(32)}\n`);
    const catalogs = Catalogs.open(gameCatalogs(at));
    expect(catalogs.catalogs).toEqual([path.join(at, '01.cat')]);
    expect(catalogs.readText('md/a.xml')).toBe('a');
  });

  it('tells bytes that do not match the MD5, and a .dat that ends too early', () => {
    const at = folder();
    writeCatalog(path.join(at, '01.cat'), [
      { path: 'md/a.xml', data: 'abc' },
      { path: 'md/b.xml', data: 'def' },
    ]);
    writeFileSync(path.join(at, '01.dat'), 'abX');
    const catalogs = Catalogs.open(gameCatalogs(at));
    expect(catalogs.verify('md/a.xml')).toBe(false);
    const entry = catalogs.entry('md/b.xml');
    expect(entry).toBeDefined();
    expect(() => readEntry(entry!)).toThrow(/ends before md\/b\.xml/);
  });
});

describe('finding the catalogs of a folder', () => {
  const at = folder();
  for (const name of ['02.cat', '01.cat', '01_sig.cat', '10.cat', 'ext_02.cat', 'ext_01.cat', 'ext_01_sig.cat', 'ext_v900.cat', 'subst_01.cat', 'notes.txt']) {
    writeFileSync(path.join(at, name), '');
  }

  it('finds the game catalogs in name order, without signatures', () => {
    expect(gameCatalogs(at).map((file) => path.basename(file))).toEqual(['01.cat', '02.cat', '10.cat']);
  });

  it("finds an extension's own catalogs, without signatures, substitutions or versions", () => {
    expect(extensionCatalogs(at).map((file) => path.basename(file))).toEqual(['ext_01.cat', 'ext_02.cat']);
  });

  it('finds others by a pattern, and nothing in a folder that is not there', () => {
    expect(catalogsIn(at, /^subst_\d+\.cat$/i).map((file) => path.basename(file))).toEqual(['subst_01.cat']);
    expect(gameCatalogs(path.join(at, 'absent'))).toEqual([]);
    expect(gameCatalogs(path.join(at, 'notes.txt'))).toEqual([]);
  });
});

describe('writing a catalog', () => {
  it('writes backslashes as slashes and refuses a path with a line break or nothing in it', () => {
    const at = folder();
    writeCatalog(path.join(at, 'ext_01.cat'), [{ path: 'md\\x.xml', data: 'x', time: 5 }]);
    expect(readFileSync(path.join(at, 'ext_01.cat'), 'utf8')).toMatch(/^md\/x\.xml 1 5 [0-9a-f]{32}\n$/);
    expect(() => writeCatalog(path.join(at, 'ext_02.cat'), [{ path: 'a\nb.xml', data: '' }])).toThrow(/Not a path/);
    expect(() => writeCatalog(path.join(at, 'ext_03.cat'), [{ path: ' ', data: '' }])).toThrow(/Not a path/);
  });

  it('writes an empty file and an empty catalog', () => {
    const at = folder();
    writeCatalog(path.join(at, '01.cat'), [{ path: 'md/empty.xml', data: '' }]);
    writeCatalog(path.join(at, '02.cat'), []);
    const catalogs = Catalogs.open(gameCatalogs(at));
    expect(catalogs.readText('md/empty.xml')).toBe('');
    expect(catalogs.verify('md/empty.xml')).toBe(true);
    expect(catalogs.catalogs.length).toBe(2);
  });
});
