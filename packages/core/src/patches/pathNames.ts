/**
 * The names a patch document's paths select by: `cue[@name='X']` and `library[@name='X']` in a patch of a
 * Mission Director script, `actions`, `handler` and `conditions[@name='X']` in a patch of an AI script.
 * Such a path breaks when the cue or interrupt library item is renamed, so find references and rename
 * count them with the other places that name it.
 */
import type { ScriptSchema } from '../types';
import { rangeInValue, type XmlStructure } from '../xml/xmlStructure';
import { parseXPath, parseXPathCondition, type XPathLiteral, type XPathPredicate } from '../xml/xpath';

export type PathNameKind = 'cue' | 'actions' | 'handler' | 'conditions';

/** A name in a path, with its offsets in the patch document. */
export interface PathName {
  /** `cue` for a cue or library of the patched script, else the kind of interrupt library item. */
  kind: PathNameKind;
  name: string;
  start: number;
  end: number;
}

const operations: ReadonlySet<string> = new Set(['add', 'replace', 'remove']);
const libraryKinds: ReadonlySet<string> = new Set(['actions', 'handler', 'conditions']);

/** The kind of name a step's `@name` compares with, for the elements whose names other files use. */
export function pathNameKind(elementName: string, schema: ScriptSchema): PathNameKind | undefined {
  if (schema === 'md') {
    return elementName === 'cue' || elementName === 'library' ? 'cue' : undefined;
  }
  return libraryKinds.has(elementName) ? (elementName as PathNameKind) : undefined;
}

/** The strings a predicate compares `@name` with, also inside `and` and `or`. */
export function nameLiterals(predicate: XPathPredicate): XPathLiteral[] {
  switch (predicate.kind) {
    case 'compare':
      return predicate.subject.kind === 'attribute' && predicate.subject.name === 'name' && predicate.operator === '=' ? [predicate.value] : [];
    case 'and':
    case 'or':
      return predicate.operands.flatMap(nameLiterals);
    default:
      return [];
  }
}

/** The names the `sel` and `if` paths of a patch document select cues, libraries or interrupt library items by. */
export function pathNamesOf(structure: XmlStructure, schema: ScriptSchema): PathName[] {
  const root = structure.roots[0];
  if (root?.name !== 'diff') {
    return [];
  }
  const names: PathName[] = [];
  for (const operation of root.children) {
    if (!operations.has(operation.name)) {
      continue;
    }
    for (const attribute of operation.attributes) {
      if ((attribute.name !== 'sel' && attribute.name !== 'if') || attribute.quote === '') {
        continue;
      }
      const path = attribute.name === 'sel' ? parseXPath(attribute.value) : parseXPathCondition(attribute.value).path;
      for (const step of path.steps) {
        const kind = step.test.kind === 'element' ? pathNameKind(step.test.name, schema) : undefined;
        if (!kind) {
          continue;
        }
        for (const literal of step.predicates.flatMap(nameLiterals)) {
          const name = literal.value;
          if (name === '' || name.trim() !== name) {
            continue;
          }
          const range = rangeInValue(attribute, literal.start + 1, literal.end - 1);
          names.push({ kind, name, start: range.start, end: range.end });
        }
      }
    }
  }
  return names;
}
