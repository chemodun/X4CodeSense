/**
 * Find references and rename, in the document and, with the script index, across files.
 *
 * In one document: variables, labels, cues and interrupt library items, as the document's models relate
 * them. Across files, what a name in the text ties to another file: a Mission Director script
 * (`<mdscript name>`, `md.Script`), a cue or library (its name, its bare references in its own script,
 * `md.Script.Cue` anywhere), a variable of a cue written `md.Script.Cue.$x`, and an interrupt library
 * item (its definition and every reference in any AI script). The current document's occurrences come
 * from its analysis, those of other files from the index.
 *
 * A rename always may edit the current document; other files only inside the editable folders (the
 * workspace) and outside the game folder, or it is refused. It is refused too when the script is
 * defined more than once, when a file changed since it was indexed, and when a variable is tied to
 * another file in a way no name in the text shows: set or read by a library of another file, or in a
 * table other scripts fill. Renaming only this file would break that tie without a word.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Location, Range, type TextEdit, type WorkspaceEdit } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { GameData } from '../gameData';
import { relatedOccurrences, type NamedOccurrence } from '../names/namedItems';
import { mdReferenceAt, mdReferencesOf } from '../project/mdReferences';
import type { IndexedFileModel, IndexedLibraryKind, IndexedPosition, ScriptIndex } from '../project/scriptIndex';
import type { ScriptVariable, VariableTable } from '../variables/variables';
import { attributeNamed, attributeWithValueAt, elementWithStartTagAt, type XmlElement } from '../xml/xmlStructure';
import { isExpressionAttribute } from '../xsd/schema';
import { namedItemAt } from './namedItems';
import { remoteCueOf, renameVariable, variableAt, variableOccurrences, variableReferences } from './variables';

export interface RenameOptions {
  /** Folders whose files a rename may edit besides the current document: the workspace folders. Without them, only the current document. */
  editableFolders?: readonly string[];
}

/** A rename that is not done, with the reason to show. */
export interface RenameRefusal {
  refused: string;
}

/** Something a name in the text ties to other files. */
type Target =
  | { kind: 'script'; script: string }
  | { kind: 'cue'; script: string; cue: string }
  | { kind: 'variable'; script: string; cue: string; variable: ScriptVariable }
  | { kind: IndexedLibraryKind; name: string };

/** A name written in another file: where it starts and what is written there. */
interface Elsewhere {
  file: string;
  line: number;
  character: number;
  text: string;
}

interface Occurrences {
  /** Text offsets in the current document. */
  here: { start: number; end: number }[];
  there: Elsewhere[];
}

function fileOf(uri: string): string | undefined {
  if (!uri.startsWith('file:')) {
    return undefined;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function sameFile(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isInside(file: string, folder: string): boolean {
  const relative = path.relative(path.resolve(folder).toLowerCase(), path.resolve(file).toLowerCase());
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function rangeOf(analysis: DocumentAnalysis, occurrence: { start: number; end: number }): Range {
  return Range.create(analysis.document.positionAt(occurrence.start), analysis.document.positionAt(occurrence.end));
}

function rangeElsewhere(place: Elsewhere): Range {
  return Range.create(place.line, place.character, place.line, place.character + place.text.length);
}

/** The value of the root's `name` when the caret is on it, trimmed, with its text offsets. */
function rootNameAt(analysis: DocumentAnalysis, element: XmlElement, offset: number): { start: number; end: number } | undefined {
  const attribute = attributeNamed(element, 'name');
  if (element !== analysis.structure?.roots[0] || !attribute || attribute.quote === '') {
    return undefined;
  }
  const name = attribute.value.trim();
  const start = attribute.valueStart + attribute.value.indexOf(name);
  return name !== '' && offset >= start && offset <= start + name.length ? { start, end: start + name.length } : undefined;
}

/** What the name under the caret ties to other files, or undefined when it is this document's alone. */
function targetAt(analysis: DocumentAnalysis, offset: number, game: GameData | undefined): Target | undefined {
  const script = analysis.detection.script;
  if (!game?.index || !script) {
    return undefined;
  }
  const found = variableAt(analysis, offset);
  if (found) {
    const variable = found.variable;
    const remote = script.schema === 'md' ? remoteCueOf(variable.table) : undefined;
    if (remote) {
      return { kind: 'variable', ...remote, variable };
    }
    const table = variable.table;
    return script.schema === 'md' && (table.kind === 'cue' || table.kind === 'library') && script.name !== ''
      ? { kind: 'variable', script: script.name, cue: table.name, variable }
      : undefined;
  }
  const named = namedItemAt(analysis, offset);
  if (named) {
    if (named.kind === 'label') {
      return undefined;
    }
    if (named.kind === 'cue') {
      const defined = !named.external && named.items.some((item) => item.definitions.length > 0);
      return defined && script.name !== '' ? { kind: 'cue', script: script.name, cue: named.name } : undefined;
    }
    return { kind: named.kind, name: named.name };
  }
  const element = analysis.structure && elementWithStartTagAt(analysis.structure, offset);
  const attribute = element && attributeWithValueAt(element, offset);
  if (!element || !attribute || script.schema !== 'md') {
    return undefined;
  }
  if (element.name === 'mdscript' && attribute.name === 'name') {
    return rootNameAt(analysis, element, offset) ? { kind: 'script', script: script.name } : undefined;
  }
  const declaration = analysis.declarations.get(element) ?? game.schemas.schemas.md?.anyDeclaration(element.name);
  if (!isExpressionAttribute(declaration?.attributes.get(attribute.name))) {
    return undefined;
  }
  const md = mdReferenceAt(element, attribute, offset);
  if (!md) {
    return undefined;
  }
  const { reference, part } = md;
  return part === 'script' || reference.cue === undefined
    ? { kind: 'script', script: reference.script }
    : { kind: 'cue', script: reference.script, cue: reference.cue };
}

/** The occurrences of a named item of a model: those related to its first definition or reference. */
function modelItemOccurrences(model: IndexedFileModel, kind: NamedOccurrence['kind'], name: string): NamedOccurrence[] {
  const item = model.names.items.find((candidate) => candidate.kind === kind && candidate.name === name && candidate.scope === 'script');
  const first = item?.definitions[0] ?? item?.references[0];
  return first ? relatedOccurrences(first) : [];
}

/** The table of a cue or library of a script. */
function cueTable(tables: readonly VariableTable[], cue: string): VariableTable | undefined {
  return tables.find((table) => (table.kind === 'cue' || table.kind === 'library') && table.name === cue);
}

/** Every place the target is written: in the current document from its analysis, in other files from the index. */
function occurrencesOf(target: Target, analysis: DocumentAnalysis, game: GameData, index: ScriptIndex): Occurrences {
  const current = fileOf(analysis.document.uri);
  const isCurrent = (file: string): boolean => current !== undefined && sameFile(file, current);
  const here: { start: number; end: number }[] = [];
  const there: Elsewhere[] = [];
  const indexed = (position: IndexedPosition, text: string): void => {
    if (!isCurrent(position.file)) {
      there.push({ file: position.file, line: position.line, character: position.character, text });
    }
  };
  const modelled = (model: IndexedFileModel, start: number, end: number): void => {
    there.push({ file: model.file, ...model.positionAt(start), text: model.text.slice(start, end) });
  };
  const own = analysis.detection.script;
  const ownMd = own?.schema === 'md' ? own.name : undefined;
  const xsd = game.schemas.schemas.md;
  // Scripts of the name besides the current document: their own occurrences come from their models.
  const scriptsOf = (script: string): { file: string }[] => index.scripts('md', script).filter((entry) => !isCurrent(entry.file));
  const inScriptOf = (script: string, file: string): boolean => index.scripts('md', script).some((entry) => sameFile(entry.file, file));
  switch (target.kind) {
    case 'script': {
      const root = analysis.structure?.roots[0];
      const name = root && ownMd === target.script ? attributeNamed(root, 'name') : undefined;
      if (name) {
        const start = name.valueStart + name.value.indexOf(target.script);
        here.push({ start, end: start + target.script.length });
      }
      if (own?.schema === 'md') {
        for (const reference of mdReferencesOf(analysis, xsd)) {
          if (reference.script === target.script) {
            here.push({ start: reference.scriptStart, end: reference.scriptEnd });
          }
        }
      }
      for (const script of index.scripts('md', target.script)) {
        if (script.namePosition) {
          indexed(script.namePosition, target.script);
        }
      }
      for (const reference of index.scriptReferences(target.script)) {
        indexed(reference.position, target.script);
      }
      break;
    }
    case 'cue': {
      if (ownMd === target.script) {
        const item = analysis.names?.items.find((candidate) => candidate.kind === 'cue' && candidate.name === target.cue && candidate.scope === 'script');
        const first = item?.definitions[0] ?? item?.references[0];
        here.push(...(first ? relatedOccurrences(first) : []));
      } else if (own?.schema === 'md') {
        for (const reference of mdReferencesOf(analysis, xsd)) {
          if (reference.script === target.script && reference.cue === target.cue && reference.cueStart !== undefined && reference.cueEnd !== undefined) {
            here.push({ start: reference.cueStart, end: reference.cueEnd });
          }
        }
      }
      for (const script of scriptsOf(target.script)) {
        const model = index.fileModel(script.file);
        if (model) {
          for (const occurrence of modelItemOccurrences(model, 'cue', target.cue)) {
            modelled(model, occurrence.start, occurrence.end);
          }
        }
      }
      for (const cue of index.cues(target.script, target.cue)) {
        if (cue.patch) {
          indexed(cue.namePosition, target.cue);
        }
      }
      for (const reference of index.cueReferences(target.script, target.cue)) {
        if (!inScriptOf(target.script, reference.position.file)) {
          indexed(reference.position, target.cue);
        }
      }
      break;
    }
    case 'variable': {
      here.push(...variableOccurrences(target.variable));
      const name = target.variable.name;
      for (const script of scriptsOf(target.script)) {
        const model = index.fileModel(script.file);
        const variable = model && cueTable(model.variables.tables, target.cue)?.variables.get(name);
        if (model && variable) {
          for (const occurrence of variableOccurrences(variable)) {
            modelled(model, occurrence.start, occurrence.end);
          }
        }
      }
      for (const reference of index.cueVariableReferences(target.script, target.cue, name)) {
        if (!inScriptOf(target.script, reference.position.file)) {
          indexed(reference.position, `$${name}`);
        }
      }
      break;
    }
    default: {
      const item = analysis.names?.items.find((candidate) => candidate.kind === target.kind && candidate.name === target.name && candidate.scope === 'script');
      const first = item?.definitions[0] ?? item?.references[0];
      here.push(...(first ? relatedOccurrences(first) : []));
      for (const defined of index.libraryItems(target.kind, target.name)) {
        indexed(defined.namePosition, target.name);
      }
      for (const reference of index.libraryReferences(target.kind, target.name)) {
        indexed(reference.position, target.name);
      }
    }
  }
  const seenHere = new Set<number>();
  const seenThere = new Set<string>();
  return {
    here: here.filter((occurrence) => !seenHere.has(occurrence.start) && seenHere.add(occurrence.start)).sort((a, b) => a.start - b.start),
    there: there
      .filter((place) => {
        const key = `${path.resolve(place.file).toLowerCase()}|${place.line}|${place.character}`;
        return !seenThere.has(key) && seenThere.add(key);
      })
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character),
  };
}

/** What the target is called in a message. */
function describeTarget(target: Target): string {
  switch (target.kind) {
    case 'script':
      return `script ${target.script}`;
    case 'cue':
      return `cue ${target.cue} of ${target.script}`;
    case 'variable':
      return `$${target.variable.name}`;
    default:
      return `interrupt ${target.kind} ${target.name}`;
  }
}

/** Why the occurrences in other files cannot all be edited, or undefined when they can. */
function editRefusal(target: Target, occurrences: Occurrences, game: GameData, index: ScriptIndex, options: RenameOptions): string | undefined {
  const script = target.kind === 'script' || target.kind === 'cue' || target.kind === 'variable' ? target.script : undefined;
  const scripts = script === undefined ? [] : index.scripts('md', script);
  if (scripts.length > 1) {
    return `Mission Director script ${script} is defined ${scripts.length} times (${scripts.map((entry) => path.basename(entry.file)).join(', ')}): its references cannot tell which one they mean`;
  }
  const byFile = new Map<string, Elsewhere[]>();
  for (const place of occurrences.there) {
    const list = byFile.get(place.file) ?? [];
    list.push(place);
    byFile.set(place.file, list);
  }
  for (const file of byFile.keys()) {
    const name = path.basename(file);
    if (isInside(file, game.folder)) {
      return `${describeTarget(target)} is also written in ${name} of the game, which cannot be renamed`;
    }
    if (!(options.editableFolders ?? []).some((folder) => isInside(file, folder))) {
      return `${describeTarget(target)} is also written in ${name} (${index.sourceOf(file) ?? 'unknown source'}), outside the workspace`;
    }
  }
  for (const [file, places] of byFile) {
    const lines = index.currentText(file)?.split('\n');
    if (!lines || places.some((place) => lines[place.line]?.slice(place.character, place.character + place.text.length) !== place.text)) {
      return `${path.basename(file)} changed since it was indexed; save it and try again`;
    }
  }
  return undefined;
}

/** The first cue of the element or its ancestors. */
function enclosingCue(element: XmlElement): XmlElement | undefined {
  for (let current: XmlElement | undefined = element; current; current = current.parent) {
    if (current.name === 'cue' || current.name === 'library') {
      return current;
    }
  }
  return undefined;
}

/**
 * Why renaming the variable would break a tie to another file that no name in the text shows, or
 * undefined when there is none the index knows of.
 */
function variableTie(variable: ScriptVariable, analysis: DocumentAnalysis, index: ScriptIndex | undefined): string | undefined {
  const name = `$${variable.name}`;
  const elsewhere = variable.elsewhere[0];
  if (elsewhere) {
    return `${name} is also set by ${elsewhere.via} in ${path.basename(elsewhere.position.file)}, which a rename here does not change`;
  }
  const table = variable.table;
  if (table.opaque) {
    return `${name} is in ${table.kind} ${table.name}, whose variables scripts elsewhere set`;
  }
  const script = analysis.detection.script;
  if (!index || !script) {
    return undefined;
  }
  const variables = analysis.variables;
  const names = analysis.names;
  if (script.schema === 'md') {
    if (table.kind === 'library' && (index.isUsedByOtherScripts(script.name, table.name) || index.isIncludedByOtherScripts(script.name, table.name))) {
      return `${name} is in library ${table.name}, which other scripts use`;
    }
    for (const element of analysis.structure?.elements ?? []) {
      const remote = element.name === 'include_actions' ? /^md\.(\w+)\.(\w+)$/.exec(attributeNamed(element, 'ref')?.value.trim() ?? '') : null;
      if (!remote || remote[1] === script.name || !variables) {
        continue;
      }
      const including = enclosingCue(element);
      const tables = [variables.tableOf(element), ...variables.tables.filter((candidate) => candidate.owner !== undefined && candidate.owner === including)];
      if (tables.includes(table) && index.cueVariableUses(remote[1], remote[2]).has(variable.name)) {
        return `${name} is also used by library ${remote[2]} of ${remote[1]}, included here, which a rename here does not change`;
      }
    }
    return undefined;
  }
  if (table.kind !== 'script' || !names) {
    return undefined;
  }
  const current = fileOf(analysis.document.uri);
  const isCurrent = (file: string): boolean => current !== undefined && sameFile(file, current);
  if (variableOccurrences(variable).some((occurrence) => occurrence.external)) {
    for (const item of names.items) {
      if (item.kind === 'label' || item.kind === 'cue' || item.definitions.length === 0) {
        continue;
      }
      if (index.libraryReferences(item.kind, item.name).some((reference) => !isCurrent(reference.position.file))) {
        return `${name} is used in the interrupt library, which runs in the scripts that use it, such as the one using ${item.kind} ${item.name}`;
      }
    }
  }
  const checked = new Set<string>();
  for (const occurrence of names.occurrences) {
    const kind = occurrence.kind;
    if (occurrence.role !== 'reference' || kind === 'label' || kind === 'cue' || checked.has(`${kind}:${occurrence.name}`)) {
      continue;
    }
    checked.add(`${kind}:${occurrence.name}`);
    for (const item of index.libraryItems(kind, occurrence.name)) {
      if (!isCurrent(item.position.file) && index.libraryItemUses(item).has(variable.name)) {
        return `${name} is also used by interrupt ${kind} ${item.name} in ${path.basename(item.position.file)}, which a rename here does not change`;
      }
    }
  }
  return undefined;
}

/** All occurrences of the variable or named item under the caret; with the script index, also those in other files. */
export function referencesAt(analysis: DocumentAnalysis, offset: number, game?: GameData): Location[] {
  const target = targetAt(analysis, offset, game);
  if (target && game?.index) {
    const occurrences = occurrencesOf(target, analysis, game, game.index);
    return [
      ...occurrences.here.map((occurrence) => Location.create(analysis.document.uri, rangeOf(analysis, occurrence))),
      ...occurrences.there.map((place) => Location.create(pathToFileURL(place.file).toString(), rangeElsewhere(place))),
    ];
  }
  const variable = variableAt(analysis, offset);
  if (variable) {
    return variableReferences(variable.variable, analysis.document);
  }
  const named = namedItemAt(analysis, offset);
  return named ? relatedOccurrences(named).map((occurrence) => Location.create(analysis.document.uri, rangeOf(analysis, occurrence))) : [];
}

/** Why a rename at the caret is not done, or undefined when it may go ahead. */
function renameRefusal(analysis: DocumentAnalysis, offset: number, game: GameData | undefined, options: RenameOptions): string | undefined {
  const variable = variableAt(analysis, offset)?.variable;
  const tie = variable && variableTie(variable, analysis, game?.index);
  if (tie) {
    return tie;
  }
  const target = targetAt(analysis, offset, game);
  return target && game?.index ? editRefusal(target, occurrencesOf(target, analysis, game, game.index), game, game.index, options) : undefined;
}

/**
 * The range and current text of the variable or named item under the caret, for a rename prompt; or
 * why it cannot be renamed.
 */
export function prepareRenameAt(
  analysis: DocumentAnalysis,
  offset: number,
  game?: GameData,
  options: RenameOptions = {}
): { range: Range; placeholder: string } | RenameRefusal | undefined {
  const found = variableAt(analysis, offset)?.occurrence ?? namedItemAt(analysis, offset) ?? mdNameAt(analysis, offset, game);
  if (!found) {
    return undefined;
  }
  const refused = renameRefusal(analysis, offset, game, options);
  if (refused) {
    return { refused };
  }
  return { range: rangeOf(analysis, found), placeholder: analysis.document.getText().slice(found.start, found.end) };
}

/** The script name of `<mdscript name>`, or the script or cue name of `md.Script.Cue`, under the caret, with its text offsets. */
function mdNameAt(analysis: DocumentAnalysis, offset: number, game: GameData | undefined): { start: number; end: number } | undefined {
  const target = targetAt(analysis, offset, game);
  const element = analysis.structure && elementWithStartTagAt(analysis.structure, offset);
  if ((target?.kind !== 'script' && target?.kind !== 'cue') || !element) {
    return undefined;
  }
  const root = rootNameAt(analysis, element, offset);
  if (root) {
    return root;
  }
  const attribute = attributeWithValueAt(element, offset);
  const md = attribute && mdReferenceAt(element, attribute, offset);
  if (!md) {
    return undefined;
  }
  const { reference, part } = md;
  return part === 'cue' && reference.cueStart !== undefined && reference.cueEnd !== undefined
    ? { start: reference.cueStart, end: reference.cueEnd }
    : { start: reference.scriptStart, end: reference.scriptEnd };
}

/**
 * Edits that rename the variable or named item under the caret: in the document and, with the script
 * index, in other files; or why it cannot be renamed. A label named by a handler for several attention
 * blocks renames all of them together, so the handler keeps finding each.
 */
export function renameAt(
  analysis: DocumentAnalysis,
  offset: number,
  newName: string,
  game?: GameData,
  options: RenameOptions = {}
): WorkspaceEdit | RenameRefusal | undefined {
  const name = newName.trim().replace(/^\$/, '');
  if (name === '') {
    return undefined;
  }
  const refused = renameRefusal(analysis, offset, game, options);
  if (refused) {
    return { refused };
  }
  const uri = analysis.document.uri;
  const target = targetAt(analysis, offset, game);
  if (target && game?.index) {
    const occurrences = occurrencesOf(target, analysis, game, game.index);
    const text = analysis.document.getText();
    const renamed = (written: string): string => (written.startsWith('$') ? `$${name}` : name);
    const changes: Record<string, TextEdit[]> = {};
    if (occurrences.here.length > 0) {
      changes[uri] = occurrences.here.map((occurrence) => ({
        range: rangeOf(analysis, occurrence),
        newText: renamed(text.slice(occurrence.start, occurrence.end)),
      }));
    }
    for (const place of occurrences.there) {
      const edits = (changes[pathToFileURL(place.file).toString()] ??= []);
      edits.push({ range: rangeElsewhere(place), newText: renamed(place.text) });
    }
    return Object.keys(changes).length > 0 ? { changes } : undefined;
  }
  const variable = variableAt(analysis, offset);
  if (variable) {
    return { changes: { [uri]: renameVariable(variable.variable, name, analysis.document) } };
  }
  const named = namedItemAt(analysis, offset);
  if (!named) {
    return undefined;
  }
  return { changes: { [uri]: relatedOccurrences(named).map((occurrence) => ({ range: rangeOf(analysis, occurrence), newText: name })) } };
}
