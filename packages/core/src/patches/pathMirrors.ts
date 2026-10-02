/**
 * The places in the paths of patches that repeat places of files.
 *
 * A step `name[@attr='literal']` selects the elements whose `attr` has that value, so the literal is a copy
 * of the value of every element it selects: a name written in that value, `$count` in
 * `set_value[@name='$count']`, `$Faction` in `do_elseif[@value='$Faction == faction.split']`, a cue in
 * `include_actions[@ref='md.Setup.Lib']`, is written in the literal too. A rename that changes the value
 * must change the literal alike, or the path selects nothing; find references lists it. Which elements a
 * literal selects is worked out on the target's tree as its operation finds it, after the earlier patches
 * and the patch's operations before it.
 */
import * as path from 'node:path';
import type { ScriptIndex } from '../project/scriptIndex';
import { attributeNamed, rangeInValue, type XmlAttribute, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import { evaluateXPath, parseXPath, parseXPathCondition, type XPath, type XPathLiteral, type XPathPredicate, type XPathSubject } from '../xml/xpath';
import { eachOperationTree } from './patchAnalysis';
import type { PatchNode, PatchSource } from './patchTree';

/** Offsets in a file's text. */
export interface FilePlace {
  file: string;
  start: number;
  end: number;
}

/** A place in a patch's path that repeats `of`. */
export interface PathMirror extends FilePlace {
  of: FilePlace;
}

/** The current document, whose text the index may not have. */
export interface MirrorDocument {
  file: string;
  text: string;
  structure: XmlStructure;
}

function keyOf(file: string): string {
  return path.resolve(file).toLowerCase();
}

/** The literals a step compares an attribute, or `.` of an attribute, with by `=`: those a selected node's value equals. */
function equalLiterals(predicate: XPathPredicate): { subject: XPathSubject; value: XPathLiteral }[] {
  switch (predicate.kind) {
    case 'compare':
      return predicate.operator === '=' && predicate.subject.kind !== 'child' ? [{ subject: predicate.subject, value: predicate.value }] : [];
    case 'and':
    case 'or':
      return predicate.operands.flatMap(equalLiterals);
    default:
      return [];
  }
}

/** The value a selection compares with a literal: an element's attribute, or the attribute selected. */
function comparedAttribute(subject: XPathSubject, node: PatchNode, selected?: string): { owner: PatchNode; name: string } | undefined {
  if (subject.kind === 'attribute' && selected === undefined) {
    return { owner: node, name: subject.name };
  }
  return subject.kind === 'self' && selected !== undefined ? { owner: node, name: selected } : undefined;
}

/** The `sel` and `if` of an operation with their paths. */
function pathsOf(operation: XmlElement): [XmlAttribute, XPath][] {
  const paths: [XmlAttribute, XPath][] = [];
  const sel = attributeNamed(operation, 'sel');
  const condition = attributeNamed(operation, 'if');
  if (sel && sel.quote !== '') {
    paths.push([sel, parseXPath(sel.value)]);
  }
  if (condition && condition.quote !== '') {
    paths.push([condition, parseXPathCondition(condition.value).path]);
  }
  return paths;
}

/** Where an attribute's value is written: in its file, or in the text of the operation that set it. */
function valueRegion(owner: PatchNode, name: string): { source: PatchSource; start: number; end: number } | undefined {
  const attribute = owner.attributes.find((candidate) => candidate.name === name);
  if (attribute?.setBy) {
    const operation = attribute.setBy.operation;
    return operation.endTag ? { source: attribute.setBy.source, start: operation.startTagEnd, end: operation.endTag.start } : undefined;
  }
  const written = attribute?.written;
  return written ? { source: owner.source, start: written.valueStart, end: written.valueEnd } : undefined;
}

/**
 * The places in patches' paths that repeat the given places: for each literal of a `sel` or `if` step
 * that an element's value equals, the places inside that value, at the same offsets in the literal. Only
 * where the literal is written as the value is, character for character. Patches looked at: those of a
 * file with places, and of the file a patch with places changes.
 */
export function pathMirrors(places: readonly FilePlace[], index: ScriptIndex, current?: MirrorDocument): PathMirror[] {
  const textOf = (file: string): { text: string; structure: XmlStructure } | undefined =>
    current && keyOf(current.file) === keyOf(file) ? current : index.parsedFile(file);
  const byFile = new Map<string, FilePlace[]>();
  for (const place of places) {
    const list = byFile.get(keyOf(place.file)) ?? [];
    list.push(place);
    byFile.set(keyOf(place.file), list);
  }
  const candidates = new Map<string, string>();
  for (const list of byFile.values()) {
    const file = list[0].file;
    const target = index.patchTarget(file)?.file;
    for (const patched of target === undefined ? [file] : [file, target]) {
      for (const patch of index.patchesOf(patched)) {
        candidates.set(keyOf(patch.file), patch.file);
      }
    }
    if (target !== undefined) {
      candidates.set(keyOf(file), file);
    }
  }
  const words = [...new Set(places.map((place) => textOf(place.file)?.text.slice(place.start, place.end) ?? '').filter((word) => word !== ''))];
  // The offsets of the places are those of the text of their file they were found in: a node is mapped only when it was read from that text.
  const counted = new Map<PatchSource, boolean>();
  const sameText = (source: PatchSource): boolean => {
    let same = counted.get(source);
    if (same === undefined) {
      same = source.text === textOf(source.file)?.text;
      counted.set(source, same);
    }
    return same;
  };
  const mirrors: PathMirror[] = [];
  const seen = new Set<string>();
  for (const file of candidates.values()) {
    const source = textOf(file);
    const root = source?.structure.roots[0];
    const target = index.patchTarget(file)?.file;
    if (!source || root?.name !== 'diff' || target === undefined) {
      continue;
    }
    // What its paths select comes from the target, the patches before it, or itself.
    const seenBy = [target, file, ...index.patchesBefore(file, target).map((earlier) => earlier.file)];
    if (!seenBy.some((seenFile) => byFile.has(keyOf(seenFile)))) {
      continue;
    }
    // Only the operations whose paths hold the text of a place can repeat one.
    const holding = new Set(
      root.children.filter((operation) => pathsOf(operation).some(([attribute]) => words.some((word) => attribute.value.includes(word))))
    );
    if (holding.size === 0) {
      continue;
    }
    eachOperationTree({ file, ...source }, target, index, (element, tree) => {
      if (!holding.has(element)) {
        return;
      }
      for (const [attribute, xpath] of pathsOf(element)) {
        if (xpath.problem) {
          continue;
        }
        for (const [number, step] of xpath.steps.entries()) {
          const literals = step.predicates.flatMap(equalLiterals).filter((literal) => words.some((word) => literal.value.value.includes(word)));
          if (literals.length === 0) {
            continue;
          }
          const selections = evaluateXPath(xpath, tree, number + 1);
          for (const literal of literals) {
            const range = rangeInValue(attribute, literal.value.start + 1, literal.value.end - 1);
            const written = source.text.slice(range.start, range.end);
            for (const selection of selections) {
              const compared =
                selection.kind === 'node'
                  ? comparedAttribute(literal.subject, selection.node)
                  : selection.kind === 'attribute'
                    ? comparedAttribute(literal.subject, selection.owner, selection.name)
                    : undefined;
              const region =
                compared && compared.owner.attribute(compared.name) === literal.value.value ? valueRegion(compared.owner, compared.name) : undefined;
              const inFile = region && byFile.get(keyOf(region.source.file));
              if (!region || !inFile || !sameText(region.source) || region.source.text.slice(region.start, region.end) !== written) {
                continue;
              }
              for (const place of inFile) {
                if (place.start < region.start || place.end > region.end) {
                  continue;
                }
                const start = range.start + place.start - region.start;
                const key = `${keyOf(file)}|${start}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  mirrors.push({ file, start, end: start + place.end - place.start, of: place });
                }
              }
            }
          }
        }
      }
    });
  }
  return mirrors;
}
