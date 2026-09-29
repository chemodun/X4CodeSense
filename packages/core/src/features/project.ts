import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompletionItemKind, Location, Range, type CompletionItem } from 'vscode-languageserver-types';
import type { MdReference } from '../project/mdReferences';
import type { IndexedCue, IndexedLibraryItem, IndexedPosition, IndexedScript, ScriptIndex } from '../project/scriptIndex';
import { escapeMarkdown, inlineCode } from './markdown';

/** An LSP location for a place in an indexed file. */
export function indexedLocation(position: IndexedPosition): Location {
  return Location.create(pathToFileURL(position.file).toString(), Range.create(position.line, position.character, position.line, position.character));
}

/** Where an indexed definition is, for a hover: the file, its source, the line, and the patch that adds it. */
function where(position: IndexedPosition, source: string, patch?: string): string {
  const file = escapeMarkdown(path.basename(position.file));
  return patch
    ? `Added by the patch ${file} of ${inlineCode(source)}, line ${position.line + 1}`
    : `In ${file} of ${inlineCode(source)}, line ${position.line + 1}`;
}

function sourceOf(index: ScriptIndex, position: IndexedPosition): string {
  return index.sourceOf(position.file) ?? '?';
}

function cueFacts(cue: IndexedCue): string[] {
  const facts: string[] = [];
  if (cue.instantiate) {
    facts.push('Instantiated');
  }
  if (cue.namespace) {
    facts.push(`Namespace ${inlineCode(cue.namespace)}`);
  }
  if (cue.ref) {
    facts.push(`Instance of ${inlineCode(cue.ref)}`);
  }
  if (cue.purpose) {
    facts.push(`Purpose ${inlineCode(cue.purpose)}`);
  }
  if (cue.params.length > 0) {
    facts.push(`Parameters: ${cue.params.map(inlineCode).join(', ')}`);
  }
  return facts;
}

/** Hover text for the script or the cue part of `md.<Script>.<Cue>`. */
export function describeMdReference(index: ScriptIndex, reference: MdReference, part: 'script' | 'cue'): string {
  const scripts = index.scripts('md', reference.script);
  const scriptName = escapeMarkdown(reference.script);
  if (part === 'script' || reference.cue === undefined) {
    if (scripts.length === 0) {
      return `**${scriptName}**\n\nNo Mission Director script of this name is known`;
    }
    const lines = [`**${scriptName}** *(Mission Director script)*`, ''];
    for (const script of scripts) {
      lines.push(`${where(script.position, script.source)} · ${index.cuesOf(script).length} cues and libraries  `);
    }
    if (scripts.length > 1) {
      lines.push('', `Defined ${scripts.length} times`);
    }
    return lines.join('\n').trimEnd();
  }
  const cueName = escapeMarkdown(reference.cue);
  const cues = index.cues(reference.script, reference.cue);
  if (cues.length === 0) {
    return `**${cueName}**\n\n${scripts.length === 0 ? `No Mission Director script ${scriptName} is known` : `Script ${scriptName} has no cue ${cueName}`}`;
  }
  const first = cues[0];
  const lines = [`**${cueName}** *(${first.kind} of ${scriptName})*`];
  const facts = cueFacts(first);
  if (facts.length > 0) {
    lines.push('', facts.join(' · '));
  }
  lines.push('', ...cues.map((cue) => `${where(cue.position, sourceOf(index, cue.position), cue.patch)}  `));
  return lines.join('\n').trimEnd();
}

/** Where the script or cue of `md.<Script>.<Cue>` is defined. */
export function mdReferenceDefinitions(index: ScriptIndex, reference: MdReference, part: 'script' | 'cue'): Location[] {
  if (part === 'script' || reference.cue === undefined) {
    return index.scripts('md', reference.script).map((script) => indexedLocation(script.position));
  }
  return index.cues(reference.script, reference.cue).map((cue) => indexedLocation(cue.position));
}

/** Hover lines for interrupt library items that other scripts define. */
export function describeLibraryDefinitions(index: ScriptIndex, items: readonly IndexedLibraryItem[]): string {
  return items.map((item) => `${where(item.position, sourceOf(index, item.position), item.patch)} (script ${inlineCode(item.script)})  `).join('\n');
}

/** Completion items for the script names after `md.`. */
export function mdScriptCompletionItems(index: ScriptIndex, range: Range, prefix: string): CompletionItem[] {
  return index
    .scriptNames('md')
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const script = index.scripts('md', name)[0] as IndexedScript;
      return {
        label: name,
        kind: CompletionItemKind.Module,
        detail: `${path.basename(script.file)} (${script.source})`,
        textEdit: { range, newText: name },
      };
    });
}

/** Completion items for the cue names after `md.<Script>.`. */
export function mdCueCompletionItems(index: ScriptIndex, scriptName: string, range: Range, prefix: string): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const script of index.scripts('md', scriptName)) {
    for (const cue of index.cuesOf(script)) {
      if (seen.has(cue.name) || !cue.name.startsWith(prefix)) {
        continue;
      }
      seen.add(cue.name);
      items.push({ label: cue.name, kind: CompletionItemKind.Event, detail: `${cue.kind} of ${scriptName}`, textEdit: { range, newText: cue.name } });
    }
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}
