import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { offerDetails, offerMessage, oldSettingsOffer, type ScopedValues } from '../src/x4CodeCompleteSettings';

const game = path.resolve('/x4/extracted');
const oldGame = path.resolve('/x4/extracted.750');
const mods = path.resolve('/x4/mods');
const folders = new Set([game, oldGame, mods]);

/** An offer from settings given as `section.key` to their values per scope. */
function offerOf(settings: Record<string, ScopedValues>) {
  return oldSettingsOffer(
    (section, key) => settings[`${section}.${key}`] ?? {},
    (folder) => folders.has(folder)
  );
}

describe('the settings of X4CodeComplete', () => {
  it('takes each old value under our key at its scope, X4CodeComplete before X4CodeComplete-Lua', () => {
    const offer = offerOf({
      'x4CodeComplete.unpackedFileLocation': { user: game },
      'x4CodeComplete-lua.unpackedFileLocation': { user: game },
      'x4CodeComplete-lua.extensionsFolder': { user: mods },
      'x4CodeComplete.limitLanguageOutput': { user: true, workspace: false },
      'x4CodeComplete-lua.languageNumber': { workspace: '49' },
      'x4CodeComplete.debug': { user: true },
      'x4CodeComplete.reloadLanguageData': { user: true },
      'x4CodeComplete-lua.loadLuaFunctionsFromWiki': { user: false },
    });
    expect(offer.taken).toEqual([
      { scope: 'user', key: 'unpackedFileLocation', from: 'x4CodeComplete.unpackedFileLocation', value: game },
      { scope: 'user', key: 'extensionsFolder', from: 'x4CodeComplete-lua.extensionsFolder', value: mods },
      { scope: 'user', key: 'limitLanguageOutput', from: 'x4CodeComplete.limitLanguageOutput', value: true },
      { scope: 'user', key: 'debug', from: 'x4CodeComplete.debug', value: true },
      { scope: 'workspace', key: 'languageNumber', from: 'x4CodeComplete-lua.languageNumber', value: '49' },
      { scope: 'workspace', key: 'limitLanguageOutput', from: 'x4CodeComplete.limitLanguageOutput', value: false },
    ]);
    expect(offer.skipped).toEqual([]);
  });

  it('offers nothing at a scope where one of our settings is set', () => {
    const offer = offerOf({
      'x4CodeSense.languageNumber': { user: '44' },
      'x4CodeComplete.unpackedFileLocation': { user: game, workspace: game },
      'x4CodeComplete.validateXmlStructure': { user: false },
    });
    expect(offer.taken).toEqual([{ scope: 'workspace', key: 'unpackedFileLocation', from: 'x4CodeComplete.unpackedFileLocation', value: game }]);
    expect(offerOf({ 'x4CodeSense.debug': { user: false, workspace: true }, 'x4CodeComplete.debug': { user: true } })).toEqual({ taken: [], skipped: [] });
  });

  it('skips a missing folder, a relative path and a value of the wrong type, with the reason', () => {
    const missing = path.resolve('/x4/gone');
    const offer = offerOf({
      'x4CodeComplete.unpackedFileLocation': { user: missing },
      'x4CodeComplete-lua.unpackedFileLocation': { user: oldGame },
      'x4CodeComplete.extensionsFolder': { user: 'mods' },
      'x4CodeComplete.languageNumber': { user: 'English' },
      'x4CodeComplete.limitLanguageOutput': { user: 'yes' },
    });
    expect(offer.taken).toEqual([{ scope: 'user', key: 'unpackedFileLocation', from: 'x4CodeComplete-lua.unpackedFileLocation', value: oldGame }]);
    expect(offer.skipped.map((setting) => `${setting.from}: ${setting.reason}`)).toEqual([
      'x4CodeComplete.unpackedFileLocation: the folder does not exist',
      'x4CodeComplete.extensionsFolder: a relative path, which X4CodeComplete did not read from the workspace folder',
      'x4CodeComplete.languageNumber: not a language number',
      'x4CodeComplete.limitLanguageOutput: not true or false',
    ]);
  });

  it('lists a different value of X4CodeComplete-Lua as not taken', () => {
    const offer = offerOf({
      'x4CodeComplete.unpackedFileLocation': { user: game },
      'x4CodeComplete-lua.unpackedFileLocation': { user: oldGame },
    });
    expect(offer.taken.map((setting) => setting.value)).toEqual([game]);
    expect(offer.skipped).toEqual([
      {
        scope: 'user',
        key: 'unpackedFileLocation',
        from: 'x4CodeComplete-lua.unpackedFileLocation',
        value: oldGame,
        reason: 'x4CodeComplete.unpackedFileLocation is taken',
      },
    ]);
  });

  it('takes empty and null values as unset, trims paths and takes a language number given as a number', () => {
    const offer = offerOf({
      'x4CodeComplete.unpackedFileLocation': { user: `  ${game} ` },
      'x4CodeComplete.extensionsFolder': { user: '' },
      'x4CodeComplete-lua.extensionsFolder': { user: null },
      'x4CodeComplete.languageNumber': { user: 49 },
      'x4CodeComplete-lua.languageNumber': { workspace: ' ' },
    });
    expect(offer.taken.map((setting) => [setting.key, setting.value])).toEqual([
      ['unpackedFileLocation', game],
      ['languageNumber', '49'],
    ]);
    expect(offer.skipped).toEqual([]);
  });

  it('names what it would take in the notice, and lists every setting for the output', () => {
    const offer = offerOf({
      'x4CodeComplete.unpackedFileLocation': { user: game },
      'x4CodeComplete-lua.unpackedFileLocation': { user: oldGame },
      'x4CodeComplete.limitLanguageOutput': { user: true },
      'x4CodeComplete.debug': { user: false },
      'x4CodeComplete.extensionsFolder': { workspace: mods },
    });
    expect(offerMessage(offer)).toBe(
      `X4CodeSense replaces X4CodeComplete and found its settings. User settings: the game files ${game}, only the preferred language in hovers and no verbose logging. Workspace settings: the extensions folder ${mods}. Use them for X4CodeSense?`
    );
    expect(offerDetails(offer)).toEqual([
      'User settings:',
      `  x4CodeSense.unpackedFileLocation = ${JSON.stringify(game)}, from x4CodeComplete.unpackedFileLocation`,
      '  x4CodeSense.limitLanguageOutput = true, from x4CodeComplete.limitLanguageOutput',
      '  x4CodeSense.debug = false, from x4CodeComplete.debug',
      `  not taken: x4CodeComplete-lua.unpackedFileLocation = ${JSON.stringify(oldGame)}: x4CodeComplete.unpackedFileLocation is taken`,
      'Workspace settings:',
      `  x4CodeSense.extensionsFolder = ${JSON.stringify(mods)}, from x4CodeComplete.extensionsFolder`,
    ]);
  });

  it('offers nothing without old settings', () => {
    expect(offerOf({})).toEqual({ taken: [], skipped: [] });
  });
});
