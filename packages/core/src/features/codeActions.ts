/**
 * Quick fixes for the diagnostics that have an obvious fix.
 *
 * Well-formedness: an unquoted value is put in quotes, an attribute without a value gets an empty one, a
 * repeated attribute is removed. Schema: the required attributes an element lacks are added, empty. A
 * name nothing knows (an element, an attribute, a value of an enumeration, a keyword, a property, a cue
 * or script, a label, an interrupt library item, a variable, a parameter of a call, an AI script or order a
 * call names) is changed to the known names closest in spelling. The known names are those completion
 * offers at the start of the name, so a fix offers what completion would, in a patch document as where
 * the content lands; a variable is offered only when something sets it.
 *
 * What nothing defines can also be created: a cue or library, a label, a parameter where the call's
 * target declares its parameters, in another file when it is defined there (see `createFixes.ts`). Tags
 * and children get theirs in `structureFixes.ts`: a value's closing quote, a start tag closed, an end tag
 * added, renamed or removed, a required child added, a child moved where the schema allows it. A step of
 * a patch path that selects nothing is changed to a name the file has there (`patchPathFixes.ts`).
 *
 * Fixes are worked out when the editor asks, for the diagnostics of the current analysis: a diagnostic
 * the analysis no longer has gets none. Fix all applies the preferred fixes of a whole document at once.
 */
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { CodeActionKind, CompletionItemKind, InsertTextFormat, Range, type CodeAction, type Diagnostic, type TextEdit } from 'vscode-languageserver-types';
import { diagnosticSource, type DocumentAnalysis } from '../analysis/analyzeDocument';
import { positionContext, schemaOf } from '../analysis/positionContext';
import type { GameData } from '../gameData';
import { elementWithStartTagAt, type XmlAttribute, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import { completionAt } from './completion';
import { creationFixes } from './createFixes';
import { patchedViewAt } from './patchContent';
import { patchPathFixes } from './patchPathFixes';
import { spellingSuggestions } from './spelling';
import { structureFixes } from './structureFixes';
import { variableAt } from './variables';

export { spellingSuggestions, type SpellingSuggestion } from './spelling';

/**
 * Diagnostics about a name nothing knows, whose fix is a known name close in spelling, with the kinds of
 * completion items that are names of that sort: a property of `md` is no script, though completion after
 * `md.` offers both.
 */
const misspellable: ReadonlyMap<string, readonly CompletionItemKind[]> = new Map([
  ['unknown-element', [CompletionItemKind.Class]],
  ['unknown-attribute', [CompletionItemKind.Property]],
  ['invalid-attribute-value', [CompletionItemKind.EnumMember]],
  ['expression-unknown-keyword', [CompletionItemKind.Keyword]],
  ['expression-unknown-property', [CompletionItemKind.Field, CompletionItemKind.EnumMember]],
  ['label-undefined', [CompletionItemKind.Reference]],
  // A bare name may be meant as a keyword or a cue; in `md.<Script>.<Cue>` a script or a cue.
  ['cue-undefined', [CompletionItemKind.Keyword, CompletionItemKind.Event, CompletionItemKind.Module]],
  ['library-undefined', [CompletionItemKind.Function]],
  ['variable-undefined', [CompletionItemKind.Variable]],
  // The parameters the call's target declares and the call does not pass yet.
  ['param-unknown', [CompletionItemKind.Variable]],
  ['aiscript-undefined', [CompletionItemKind.Module]],
  ['order-undefined', [CompletionItemKind.Function]],
]);

/** Diagnostics on a name inside quotes, whose completion inserts it with the quotes. */
const quotedNames = new Set(['aiscript-undefined', 'order-undefined']);

/** Identifies a diagnostic across the protocol, where it arrives as a copy. */
function keyOf(diagnostic: Diagnostic): string {
  const { start, end } = diagnostic.range;
  return `${String(diagnostic.code)}|${start.line}:${start.character}-${end.line}:${end.character}|${diagnostic.message}`;
}

interface Fix {
  title: string;
  /** Edits of the analysed document. */
  edits: { start: number; end: number; text: string }[];
  /** Edits of another file, where what is missing is created. */
  elsewhere?: { document: TextDocument; edits: { start: number; end: number; text: string }[] };
  preferred?: boolean;
  /** It inserts an empty value that is still to be written: the problem moves, it is not fixed. */
  placeholder?: boolean;
}

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

/** The element whose name starts at the offset. */
function elementNamedAt(structure: XmlStructure, offset: number): XmlElement | undefined {
  const element = elementWithStartTagAt(structure, offset);
  return element?.nameStart === offset ? element : undefined;
}

/** The attribute of the start tag around the offset for which the test holds. */
function attributeAt(structure: XmlStructure, offset: number, test: (attribute: XmlAttribute) => boolean): XmlAttribute | undefined {
  return elementWithStartTagAt(structure, offset)?.attributes.find(test);
}

function quoted(raw: string): string {
  if (!raw.includes('"')) {
    return `"${raw}"`;
  }
  return raw.includes("'") ? `"${raw.replace(/"/g, '&quot;')}"` : `'${raw}'`;
}

/** The fixes for the well-formedness problems of the document's own text. */
function wellFormednessFixes(code: string, structure: XmlStructure, text: string, start: number): Fix[] {
  switch (code) {
    case 'unquoted-attribute-value': {
      const attribute = attributeAt(structure, start, (candidate) => candidate.quote === '' && candidate.valueStart === start && candidate.valueEnd > start);
      return attribute
        ? [{ title: 'Put the value in quotes', edits: [{ start, end: attribute.valueEnd, text: quoted(attribute.rawValue) }], preferred: true }]
        : [];
    }
    case 'missing-attribute-value': {
      const attribute = attributeAt(structure, start, (candidate) => candidate.nameStart === start);
      if (!attribute) {
        return [];
      }
      // Right after the `=` when there is one: what follows it may be the next attribute.
      const equals = text.slice(attribute.nameEnd, attribute.valueStart).indexOf('=');
      const at = equals >= 0 ? attribute.nameEnd + equals + 1 : attribute.nameEnd;
      const edit = { start: at, end: at, text: equals >= 0 ? '""' : '=""' };
      return [{ title: `Give '${attribute.name}' an empty value`, edits: [edit], preferred: true, placeholder: true }];
    }
    case 'duplicate-attribute': {
      const attribute = attributeAt(structure, start, (candidate) => candidate.nameStart === start);
      if (!attribute) {
        return [];
      }
      let from = attribute.start;
      while (from > 0 && isSpace(text[from - 1])) {
        from--;
      }
      return [{ title: `Remove the repeated attribute '${attribute.name}'`, edits: [{ start: from, end: attribute.end, text: '' }] }];
    }
  }
  return [];
}

/** Adds the required attributes an element lacks, after its last attribute when every value is closed, else after its name. */
function requiredAttributeFixes(analysis: DocumentAnalysis, structure: XmlStructure, start: number, game: GameData | undefined): Fix[] {
  const element = elementNamedAt(structure, start);
  if (!element) {
    return [];
  }
  // The declaration, and the attributes the element has, where it lands when a patch brings it in.
  const view = patchedViewAt(analysis, start);
  const seen = view ? view.analysis : analysis;
  const context = positionContext(seen, view ? view.offset : start, schemaOf(game, seen));
  if (context.kind !== 'element-name' || !context.element || !context.declaration) {
    return [];
  }
  const present = new Set(context.element.attributes.map((attribute) => attribute.name));
  const missing = [...context.declaration.attributes].filter(([name, declared]) => declared.required && !present.has(name)).map(([name]) => name);
  if (missing.length === 0) {
    return [];
  }
  const last = element.attributes[element.attributes.length - 1];
  const at = last && element.attributes.every((attribute) => attribute.quote !== '' && attribute.closed) ? last.end : element.nameEnd;
  const names = missing.map((name) => `'${name}'`);
  const title =
    missing.length === 1
      ? `Add the required attribute ${names[0]}`
      : `Add the required attributes ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return [{ title, edits: [{ start: at, end: at, text: missing.map((name) => ` ${name}=""`).join('') }], preferred: true, placeholder: true }];
}

/** The names that are set in the table of the variable at the offset and the tables linked to it, written with `$`. */
function setVariables(analysis: DocumentAnalysis, offset: number): Set<string> {
  const view = patchedViewAt(analysis, offset);
  const seen = view ? view.analysis : analysis;
  const variables = seen.variables;
  const found = variableAt(seen, view ? view.offset : offset);
  const names = new Set<string>();
  if (!variables || !found) {
    return names;
  }
  for (const table of [found.variable.table, ...found.variable.table.links]) {
    for (const variable of table.variables.values()) {
      if (variables.isDefined(variable)) {
        names.add(`$${variable.name}`);
      }
    }
  }
  return names;
}

/** Changes a name nothing knows to the known names closest in spelling; an element's end tag changes with it. */
function spellingFixes(
  analysis: DocumentAnalysis,
  code: string,
  kinds: readonly CompletionItemKind[],
  structure: XmlStructure,
  start: number,
  end: number,
  game: GameData | undefined
): Fix[] {
  const written = analysis.document.getText().slice(start, end);
  if (written.trim() === '') {
    return [];
  }
  let known = completionAt(analysis, start, game).flatMap((item) => {
    const edit = item.textEdit;
    const inserted = edit && 'range' in edit ? edit.newText : undefined;
    const name = inserted && quotedNames.has(code) && /^'[^']*'$/.test(inserted) ? inserted.slice(1, -1) : inserted;
    // Snippets and placeholders such as `{$faction}` are no names to write instead.
    const isName = name && item.insertTextFormat !== InsertTextFormat.Snippet && !/[\s{}()<>"']/.test(name);
    return isName && item.kind !== undefined && kinds.includes(item.kind) ? [name] : [];
  });
  if (code === 'variable-undefined') {
    const set = setVariables(analysis, start);
    known = known.filter((name) => set.has(name));
  }
  const suggestions = spellingSuggestions(written, known);
  const endTag = code === 'unknown-element' ? elementNamedAt(structure, start)?.endTag : undefined;
  return suggestions.map((suggestion, index) => {
    const edits = [{ start, end, text: suggestion.name }];
    if (endTag && analysis.document.getText().slice(endTag.nameStart, endTag.nameEnd) === written) {
      edits.push({ start: endTag.nameStart, end: endTag.nameEnd, text: suggestion.name });
    }
    // The closest name is preferred when no other is as close.
    const preferred = index === 0 && (suggestions.length === 1 || suggestions[1].distance > suggestion.distance);
    return { title: `Change to '${suggestion.name}'`, edits, preferred };
  });
}

function fixesFor(analysis: DocumentAnalysis, structure: XmlStructure, diagnostic: Diagnostic, game: GameData | undefined): Fix[] {
  const code = String(diagnostic.code);
  const start = analysis.document.offsetAt(diagnostic.range.start);
  const end = analysis.document.offsetAt(diagnostic.range.end);
  if (code === 'missing-required-attribute') {
    return requiredAttributeFixes(analysis, structure, start, game);
  }
  const kinds = misspellable.get(code);
  if (kinds) {
    // The names it may be misspelt from first; what creates it unless one of them is clearly meant.
    const spelling = spellingFixes(analysis, code, kinds, structure, start, end, game);
    return spelling.some((fix) => fix.preferred) ? spelling : [...spelling, ...creationFixes(analysis, code, start, game)];
  }
  if (code === 'patch-no-match') {
    return game ? patchPathFixes(analysis, start, end, game) : [];
  }
  return [...wellFormednessFixes(code, structure, analysis.document.getText(), start), ...structureFixes(analysis, code, start, end)];
}

/**
 * Quick fixes for diagnostics of an analysed document, as the editor sends them with a code action
 * request. Diagnostics of other tools and those the analysis no longer has are passed over. Diagnostics
 * with the same fix (two required attributes of one element) share one action.
 */
export function quickFixes(analysis: DocumentAnalysis, diagnostics: readonly Diagnostic[], game: GameData | undefined): CodeAction[] {
  const document = analysis.document;
  const actions: CodeAction[] = [];
  const byEdit = new Map<string, CodeAction>();
  for (const { diagnostic, fix } of fixesOf(analysis, diagnostics, game)) {
    const changes: Record<string, TextEdit[]> = {};
    if (fix.edits.length > 0) {
      changes[document.uri] = textEdits(analysis.document, fix.edits);
    }
    if (fix.elsewhere) {
      changes[fix.elsewhere.document.uri] = textEdits(fix.elsewhere.document, fix.elsewhere.edits);
    }
    const key = `${fix.title}|${JSON.stringify(changes)}`;
    const shared = byEdit.get(key);
    if (shared) {
      shared.diagnostics?.push(diagnostic);
      continue;
    }
    const action: CodeAction = { title: fix.title, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic], edit: { changes } };
    if (fix.preferred) {
      action.isPreferred = true;
    }
    byEdit.set(key, action);
    actions.push(action);
  }
  return actions;
}

/**
 * Every preferred fix of the analysis's diagnostics in one action of the kind `source.fixAll`, for the
 * Source Action menu and `editor.codeActionsOnSave`. Fixes that only insert an empty value are left out,
 * and so is a fix whose edits touch those of a fix before it in the text: the next fix all takes it.
 * Undefined when there is nothing to fix.
 */
export function fixAll(analysis: DocumentAnalysis, game: GameData | undefined): CodeAction | undefined {
  const fixes = fixesOf(analysis, analysis.diagnostics, game).filter(({ fix }) => fix.preferred && !fix.placeholder && !fix.elsewhere && fix.edits.length > 0);
  fixes.sort((a, b) => Math.min(...a.fix.edits.map((edit) => edit.start)) - Math.min(...b.fix.edits.map((edit) => edit.start)));
  const taken: Edit[] = [];
  const diagnostics: Diagnostic[] = [];
  const edits: TextEdit[] = [];
  const seen = new Set<string>();
  for (const { diagnostic, fix } of fixes) {
    const key = JSON.stringify(fix.edits);
    if (seen.has(key)) {
      // The same fix for another diagnostic.
      diagnostics.push(diagnostic);
      continue;
    }
    if (fix.edits.some((edit) => taken.some((other) => touch(edit, other)))) {
      continue;
    }
    seen.add(key);
    taken.push(...fix.edits);
    diagnostics.push(diagnostic);
    edits.push(...textEdits(analysis.document, fix.edits));
  }
  if (edits.length === 0) {
    return undefined;
  }
  const count = seen.size;
  return {
    title: `Apply all preferred fixes in this file (${count})`,
    kind: CodeActionKind.SourceFixAll,
    diagnostics,
    edit: { changes: { [analysis.document.uri]: edits } },
  };
}

type Edit = Fix['edits'][number];

/** True when two edits overlap, or one inserts where the other starts or ends: the order would decide the result. */
function touch(a: Edit, b: Edit): boolean {
  return a.start === a.end || b.start === b.end ? a.start <= b.end && b.start <= a.end : a.start < b.end && b.start < a.end;
}

function textEdits(document: TextDocument, edits: readonly Edit[]): TextEdit[] {
  return edits.map((edit) => ({ range: Range.create(document.positionAt(edit.start), document.positionAt(edit.end)), newText: edit.text }));
}

/** The fixes of the diagnostics the analysis still has, with the diagnostic each is for. */
function fixesOf(analysis: DocumentAnalysis, diagnostics: readonly Diagnostic[], game: GameData | undefined): { diagnostic: Diagnostic; fix: Fix }[] {
  const structure = analysis.structure;
  if (!structure) {
    return [];
  }
  const current = new Set(analysis.diagnostics.map(keyOf));
  return diagnostics.flatMap((diagnostic) =>
    diagnostic.source === diagnosticSource && current.has(keyOf(diagnostic))
      ? fixesFor(analysis, structure, diagnostic, game).map((fix) => ({ diagnostic, fix }))
      : []
  );
}
