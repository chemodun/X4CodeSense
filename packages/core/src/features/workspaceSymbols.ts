/**
 * Go to Symbol in Workspace: the scripts, cues, libraries and interrupt library items of the index, which
 * holds the game's, its DLCs', the extensions' and the workspace's scripts, the open documents as the
 * editor has them. Labels are left out: they are names inside one file, which the outline shows.
 *
 * A name matches when the query's characters occur in it in order, without case; a query with a dot is
 * matched against the qualified name (`md.Setup.Start`, `interrupt.library.Patrol`). Editors filter and
 * sort again, so the answer is the best `limit` matches: whole names before prefixes, before names that
 * contain the query, before the rest; then the preferred files (the workspace's), then shorter names.
 */
import { pathToFileURL } from 'node:url';
import { Location, Range, SymbolKind, type WorkspaceSymbol } from 'vscode-languageserver-types';
import type { IndexedPosition, ScriptIndex } from '../project/scriptIndex';
import { isInside } from './project';

export interface WorkspaceSymbolOptions {
  /** Most symbols to give; 256 by default. */
  limit?: number;
  /** Folders whose symbols come first among equal matches: the workspace folders. */
  preferredFolders?: readonly string[];
}

interface Candidate {
  name: string;
  /** The name as written elsewhere to reach it: `md.Setup.Start`. */
  qualified: string;
  kind: SymbolKind;
  container: string;
  position: IndexedPosition;
}

/** How well the text matches the query, best first; undefined when it does not. */
function matchRank(text: string, query: string): number | undefined {
  const lower = text.toLowerCase();
  if (lower === query) {
    return 0;
  }
  if (lower.startsWith(query)) {
    return 1;
  }
  if (lower.includes(query)) {
    return 2;
  }
  let at = 0;
  for (const character of query) {
    at = lower.indexOf(character, at);
    if (at < 0) {
      return undefined;
    }
    at++;
  }
  return 3;
}

function candidates(index: ScriptIndex): Candidate[] {
  const result: Candidate[] = [];
  // Per file, not per name: a source is looked up by a normalised path.
  const sources = new Map<string, string>();
  const sourceOf = (file: string): string => {
    let source = sources.get(file);
    if (source === undefined) {
      source = index.sourceOf(file) ?? '?';
      sources.set(file, source);
    }
    return source;
  };
  for (const entry of index.entries()) {
    if (entry.kind === 'script' && entry.name !== '') {
      const source = sourceOf(entry.file);
      const script = entry.schema === 'md' ? `md.${entry.name}` : entry.name;
      result.push({ name: entry.name, qualified: script, kind: SymbolKind.Module, container: source, position: entry.namePosition ?? entry.position });
      const own = `${script} (${source})`;
      const byPatch = new Map<string, string>();
      for (const cue of entry.schema === 'md' ? index.cuesOf(entry) : []) {
        let container = own;
        if (cue.patch) {
          container = byPatch.get(cue.patch) ?? `${script} (${source}, added by ${sourceOf(cue.patch)})`;
          byPatch.set(cue.patch, container);
        }
        result.push({
          name: cue.name,
          qualified: `${script}.${cue.name}`,
          kind: cue.kind === 'cue' ? SymbolKind.Event : SymbolKind.Function,
          container,
          position: cue.namePosition,
        });
      }
    }
    // Interrupt library items, also those a patch adds to an AI script: named by that script, as the index does.
    const target = entry.kind === 'patch' ? index.scriptOf(index.patchTarget(entry.file)?.file ?? '') : entry;
    if (!target || target.schema !== entry.schema) {
      continue;
    }
    const where = entry === target ? sourceOf(entry.file) : `${sourceOf(target.file)}, added by ${sourceOf(entry.file)}`;
    for (const item of entry.libraryItems) {
      result.push({
        name: item.name,
        qualified: `${target.name}.${item.name}`,
        kind: item.kind === 'handler' ? SymbolKind.Event : SymbolKind.Function,
        container: `${target.name} (${where})`,
        position: item.namePosition,
      });
    }
  }
  return result;
}

/** The symbols of the index that match the query, the best first; every symbol for an empty query, up to the limit. */
export function workspaceSymbols(index: ScriptIndex, query: string, options: WorkspaceSymbolOptions = {}): WorkspaceSymbol[] {
  const wanted = query.trim().toLowerCase();
  const qualified = wanted.includes('.');
  const folders = options.preferredFolders ?? [];
  // Per file: a few hundred files hold all the names.
  const preferredFiles = new Map<string, boolean>();
  const isPreferred = (file: string): boolean => {
    let preferred = preferredFiles.get(file);
    if (preferred === undefined) {
      preferred = folders.some((folder) => isInside(file, folder));
      preferredFiles.set(file, preferred);
    }
    return preferred;
  };
  // Grouped by rank, preference and name length, so only the groups that make the limit are sorted:
  // a short query matches most of the 25,000 names of the game and its DLCs.
  const groups = new Map<number, Candidate[]>();
  for (const candidate of candidates(index)) {
    const rank = wanted === '' ? 3 : matchRank(qualified ? candidate.qualified : candidate.name, wanted);
    if (rank !== undefined) {
      const key = (rank * 2 + (isPreferred(candidate.position.file) ? 0 : 1)) * 1024 + Math.min(candidate.name.length, 1023);
      const group = groups.get(key);
      if (group) {
        group.push(candidate);
      } else {
        groups.set(key, [candidate]);
      }
    }
  }
  const limit = options.limit ?? 256;
  const chosen: Candidate[] = [];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const group = (groups.get(key) as Candidate[]).sort(
      (a, b) =>
        // A script before the cues called like it.
        Number(b.kind === SymbolKind.Module) - Number(a.kind === SymbolKind.Module) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
    chosen.push(...group.slice(0, limit - chosen.length));
    if (chosen.length >= limit) {
      break;
    }
  }
  return chosen.map((candidate) => {
    const { line, character, file } = candidate.position;
    return {
      name: candidate.name,
      kind: candidate.kind,
      location: Location.create(pathToFileURL(file).toString(), Range.create(line, character, line, character + candidate.name.length)),
      containerName: candidate.container,
    };
  });
}
