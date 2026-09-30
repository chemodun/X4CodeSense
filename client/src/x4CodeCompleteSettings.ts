/**
 * The settings of X4CodeComplete, which X4CodeSense replaces, and of its Lua companion X4CodeComplete-Lua,
 * as X4CodeSense offers to take them. Free of the `vscode` module, so it is tested on its own.
 */
import * as path from 'node:path';

/** The settings scopes the language server reads: the user settings and the workspace settings. */
export type SettingsScope = 'user' | 'workspace';

/** A setting's own values per scope, as `WorkspaceConfiguration.inspect` gives them: undefined where it is not set. */
export type ScopedValues = Partial<Record<SettingsScope, unknown>>;

/** Reads a setting's own values per scope. */
export type Inspect = (section: string, key: string) => ScopedValues;

export interface OldSetting {
  scope: SettingsScope;
  /** The key under `x4CodeSense`. */
  key: string;
  /** The old setting: `x4CodeComplete.<key>` or `x4CodeComplete-lua.<key>`. */
  from: string;
  value: unknown;
}

export interface SkippedSetting extends OldSetting {
  reason: string;
}

export interface OldSettingsOffer {
  taken: OldSetting[];
  skipped: SkippedSetting[];
}

export const ourSection = 'x4CodeSense';

const scopes: readonly SettingsScope[] = ['user', 'workspace'];
const scopeNames: Record<SettingsScope, string> = { user: 'User settings', workspace: 'Workspace settings' };

type Kind = 'folder' | 'language' | 'boolean';

/** Our settings with an old counterpart under the same key, and the old sections that have it, the preferred first. */
const counterparts: readonly { key: string; kind: Kind; sections: readonly string[] }[] = [
  { key: 'unpackedFileLocation', kind: 'folder', sections: ['x4CodeComplete', 'x4CodeComplete-lua'] },
  { key: 'extensionsFolder', kind: 'folder', sections: ['x4CodeComplete', 'x4CodeComplete-lua'] },
  { key: 'languageNumber', kind: 'language', sections: ['x4CodeComplete', 'x4CodeComplete-lua'] },
  { key: 'limitLanguageOutput', kind: 'boolean', sections: ['x4CodeComplete', 'x4CodeComplete-lua'] },
  { key: 'validateXmlStructure', kind: 'boolean', sections: ['x4CodeComplete'] },
  { key: 'debug', kind: 'boolean', sections: ['x4CodeComplete'] },
];

/**
 * What to take from the old settings. At a scope where none of our settings has a value of its own and an
 * old one has, each old value that fits goes under our key at the same scope: X4CodeComplete's first,
 * X4CodeComplete-Lua's for what that left unset. Values that do not fit are skipped with the reason: a
 * folder that does not exist, a relative path (X4CodeComplete did not read it from the workspace folder,
 * as X4CodeSense does), a value of the wrong type. An empty value is as good as unset.
 */
export function oldSettingsOffer(inspect: Inspect, isFolder: (folder: string) => boolean): OldSettingsOffer {
  const offer: OldSettingsOffer = { taken: [], skipped: [] };
  for (const scope of scopes) {
    if (counterparts.some(({ key }) => isSet(inspect(ourSection, key)[scope]))) {
      continue;
    }
    for (const { key, kind, sections } of counterparts) {
      let taken: OldSetting | undefined;
      for (const section of sections) {
        const value = inspect(section, key)[scope];
        const fit = isSet(value) ? fitting(kind, value, isFolder) : undefined;
        if (!fit) {
          continue;
        }
        const from = `${section}.${key}`;
        if ('reason' in fit) {
          offer.skipped.push({ scope, key, from, value, reason: fit.reason });
        } else if (!taken) {
          taken = { scope, key, from, value: fit.value };
          offer.taken.push(taken);
        } else if (fit.value !== taken.value) {
          offer.skipped.push({ scope, key, from, value, reason: `${taken.from} is taken` });
        }
      }
    }
  }
  return offer;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** The value as our setting takes it, the reason it does not fit, or undefined when it is empty. */
function fitting(kind: Kind, value: unknown, isFolder: (folder: string) => boolean): { value: unknown } | { reason: string } | undefined {
  switch (kind) {
    case 'folder': {
      if (typeof value !== 'string') {
        return { reason: 'not a path' };
      }
      const folder = value.trim();
      if (folder === '') {
        return undefined;
      }
      if (!path.isAbsolute(folder)) {
        return { reason: 'a relative path, which X4CodeComplete did not read from the workspace folder' };
      }
      return isFolder(folder) ? { value: folder } : { reason: 'the folder does not exist' };
    }
    case 'language': {
      const language = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : undefined;
      if (language === '') {
        return undefined;
      }
      return language !== undefined && /^\d+$/.test(language) ? { value: language } : { reason: 'not a language number' };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { value } : { reason: 'not true or false' };
  }
}

/** How the notice names a taken setting. */
function described(setting: OldSetting): string {
  switch (setting.key) {
    case 'unpackedFileLocation':
      return `the game files ${String(setting.value)}`;
    case 'extensionsFolder':
      return `the extensions folder ${String(setting.value)}`;
    case 'languageNumber':
      return `language ${String(setting.value)}`;
    case 'limitLanguageOutput':
      return setting.value ? 'only the preferred language in hovers' : 'all languages in hovers';
    case 'validateXmlStructure':
      return setting.value ? 'the order of child elements checked' : 'the order of child elements not checked';
    default:
      return setting.value ? 'verbose logging' : 'no verbose logging';
  }
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The question of the notice, naming what would be taken per scope. */
export function offerMessage(offer: OldSettingsOffer): string {
  const parts = scopes
    .map((scope) => ({ scope, taken: offer.taken.filter((setting) => setting.scope === scope) }))
    .filter(({ taken }) => taken.length > 0)
    .map(({ scope, taken }) => `${scopeNames[scope]}: ${listed(taken.map(described))}.`);
  return `X4CodeSense replaces X4CodeComplete and found its settings. ${parts.join(' ')} Use them for X4CodeSense?`;
}

/** Every setting of the offer, taken and skipped, one per line, for the output channel. */
export function offerDetails(offer: OldSettingsOffer): string[] {
  const lines: string[] = [];
  for (const scope of scopes) {
    const taken = offer.taken.filter((setting) => setting.scope === scope);
    const skipped = offer.skipped.filter((setting) => setting.scope === scope);
    if (taken.length + skipped.length === 0) {
      continue;
    }
    lines.push(`${scopeNames[scope]}:`);
    lines.push(...taken.map((setting) => `  ${ourSection}.${setting.key} = ${JSON.stringify(setting.value)}, from ${setting.from}`));
    lines.push(...skipped.map((setting) => `  not taken: ${setting.from} = ${JSON.stringify(setting.value)}: ${setting.reason}`));
  }
  return lines;
}
