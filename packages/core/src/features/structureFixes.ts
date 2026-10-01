/**
 * Quick fixes for an element's tags and children: a value's closing quote, the end of a start tag, an end
 * tag that is missing or matches nothing, a child the schema requires, and a child in a place the schema
 * does not allow it. Each keeps the structure the tolerant scanner already sees: a start tag cut off is
 * closed as the empty element it is taken for, an end tag goes where the element was taken to end.
 */
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { elementWithStartTagAt, type XmlElement, type XmlStructure } from '../xml/xmlStructure';
import type { XsdElement } from '../xsd/schema';
import { spellingSuggestions } from './spelling';
import { Layout, type TextChange } from './textLayout';

export interface StructureFix {
  title: string;
  edits: TextChange[];
  preferred?: boolean;
  /** It inserts what is still to be filled in: the problem moves, it is not fixed. */
  placeholder?: boolean;
}

/** The most children offered as fixes for a missing one: beyond that, completion lists them better. */
const maximumChildren = 3;

/** The element whose start tag starts at the offset. */
function elementStartingAt(structure: XmlStructure, offset: number): XmlElement | undefined {
  const element = elementWithStartTagAt(structure, offset);
  return element?.start === offset ? element : undefined;
}

/** The element whose name starts at the offset. */
function elementNamedAt(structure: XmlStructure, offset: number): XmlElement | undefined {
  const element = elementWithStartTagAt(structure, offset);
  return element?.nameStart === offset ? element : undefined;
}

/** The closing quote of a value, where the scanner took the value to end. */
function closingQuoteFixes(structure: XmlStructure, start: number): StructureFix[] {
  const attribute = elementWithStartTagAt(structure, start)?.attributes.find((candidate) => candidate.valueStart === start + 1 && !candidate.closed);
  if (!attribute || attribute.quote === '') {
    return [];
  }
  return [
    {
      title: `Close the value of '${attribute.name}'`,
      edits: [{ start: attribute.valueEnd, end: attribute.valueEnd, text: attribute.quote }],
      preferred: true,
    },
  ];
}

/** A start tag cut off closed as the empty element the scanner takes it for, after its last attribute. */
function startTagFixes(structure: XmlStructure, start: number): StructureFix[] {
  const element = elementStartingAt(structure, start);
  if (!element || element.startTagClosed) {
    return [];
  }
  const last = element.attributes[element.attributes.length - 1];
  const at = last ? Math.max(last.end, element.nameEnd) : element.nameEnd;
  // A value cut off with its tag gets its quote too.
  const quote = last && !last.closed && last.quote !== '' && last.end === at ? last.quote : '';
  return [{ title: "Close the start tag with '/>'", edits: [{ start: at, end: at, text: `${quote}/>` }] }];
}

/** The end tag of an element where the scanner took it to end: after its content, on a line of its own. */
function endTagFixes(analysis: DocumentAnalysis, structure: XmlStructure, start: number): StructureFix[] {
  const element = elementStartingAt(structure, start);
  if (!element || element.endTag || element.selfClosing || !element.startTagClosed) {
    return [];
  }
  const text = analysis.document.getText();
  const layout = new Layout(text);
  let at = element.end;
  while (at > element.startTagEnd && /\s/.test(text[at - 1])) {
    at--;
  }
  const indent = layout.indentOf(element);
  const tag = `</${element.name}>`;
  return [{ title: `Add the end tag ${tag}`, edits: [{ start: at, end: at, text: indent === undefined ? tag : `${layout.newline}${indent}${tag}` }] }];
}

/**
 * An end tag that no start tag opened: renamed to the element left open where it stands when the names
 * are close (`</set_valeu>` for `<set_value>`), else removed, with its line when it stands alone.
 */
function unexpectedEndTagFixes(analysis: DocumentAnalysis, structure: XmlStructure, start: number, end: number): StructureFix[] {
  const text = analysis.document.getText();
  const written = /^<\/\s*([^\s>]*)/.exec(text.slice(start, end));
  if (!written) {
    return [];
  }
  const name = written[1];
  const fixes: StructureFix[] = [];
  // The innermost element still open at the tag, which the scanner closes later without an end tag.
  const open = structure.elements.filter((element) => element.start < start && element.end >= end && !element.endTag && !element.selfClosing).pop();
  if (open && name !== '' && spellingSuggestions(name, [open.name]).length > 0) {
    const nameStart = start + written[0].length - name.length;
    fixes.push({
      title: `Change the end tag to </${open.name}>`,
      edits: [{ start: nameStart, end: nameStart + name.length, text: open.name }],
      preferred: true,
    });
  }
  const layout = new Layout(text);
  const lineStart = layout.lineStart(start);
  const lineEnd = layout.nextLineStart(end);
  const alone = /^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t]*\r?\n?$/.test(text.slice(end, lineEnd));
  fixes.push({ title: `Remove the end tag </${name}>`, edits: [alone ? { start: lineStart, end: lineEnd, text: '' } : { start, end, text: '' }] });
  return fixes;
}

/** The required children an element lacks at its end, each as its own fix when few may stand there. */
function requiredChildFixes(analysis: DocumentAnalysis, structure: XmlStructure, start: number): StructureFix[] {
  const element = elementNamedAt(structure, start);
  const model = element && analysis.declarations.get(element)?.contentModel;
  if (!element || !model) {
    return [];
  }
  const missing = model.validate(element.children.map((child) => child.name)).find((problem) => problem.index >= element.children.length);
  const expected = missing?.expected ?? [];
  if (expected.length === 0 || expected.length > maximumChildren) {
    return [];
  }
  const layout = new Layout(analysis.document.getText());
  return expected.flatMap((name) => {
    const declaration: XsdElement | undefined = model.declarations.get(name);
    const required = [...(declaration?.attributes ?? [])].filter(([, attribute]) => attribute.required).map(([attribute]) => ` ${attribute}=""`);
    const edit = layout.lastChild(element, [[0, `<${name}${required.join('')}/>`]]);
    return edit ? [{ title: `Add the required child <${name}>`, edits: [edit], preferred: expected.length === 1, placeholder: true }] : [];
  });
}

/**
 * A child where the schema does not allow it, moved to the nearest place among its siblings where it
 * is: its lines cut and put before or after a sibling, when it stands on lines of its own.
 */
function moveChildFixes(analysis: DocumentAnalysis, structure: XmlStructure, start: number): StructureFix[] {
  const child = elementNamedAt(structure, start);
  const parent = child?.parent;
  const model = parent && analysis.declarations.get(parent)?.contentModel;
  if (!child || !parent || !model || !model.declarations.has(child.name)) {
    return [];
  }
  const layout = new Layout(analysis.document.getText());
  const lines = layout.linesOf(child);
  if (!lines || !layout.isWhole(child)) {
    return [];
  }
  const siblings = parent.children.filter((sibling) => sibling !== child);
  const from = parent.children.indexOf(child);
  const before = model.validate(parent.children.map((sibling) => sibling.name)).length;
  const fits = [...siblings.keys(), siblings.length]
    .filter((at) => at !== from)
    .filter((at) => model.validate([...siblings.slice(0, at), child, ...siblings.slice(at)].map((element) => element.name)).length < before)
    .sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
  const at = fits[0];
  if (at === undefined) {
    return [];
  }
  const block = layout.text.slice(lines.start, lines.end);
  const cut = { start: lines.start, end: lines.end, text: '' };
  if (at < siblings.length) {
    const next = siblings[at];
    const place = layout.linesOf(next);
    return place ? [{ title: `Move <${child.name}> before <${next.name}>`, edits: [cut, { start: place.start, end: place.start, text: block }] }] : [];
  }
  const previous = siblings[siblings.length - 1];
  const place = previous && layout.linesOf(previous);
  // The block's own line break goes first when the sibling's line has none (the end of the text).
  const text = place && !/\n$/.test(layout.text.slice(place.start, place.end)) ? `${layout.newline}${block.replace(/\r?\n$/, '')}` : block;
  return place ? [{ title: `Move <${child.name}> after <${previous.name}>`, edits: [cut, { start: place.end, end: place.end, text }] }] : [];
}

/** The fixes of a diagnostic about the tags and children of an element. */
export function structureFixes(analysis: DocumentAnalysis, code: string, start: number, end: number): StructureFix[] {
  const structure = analysis.structure;
  if (!structure) {
    return [];
  }
  switch (code) {
    case 'unclosed-attribute':
      return closingQuoteFixes(structure, start);
    case 'unclosed-start-tag':
      return startTagFixes(structure, start);
    case 'missing-end-tag':
      return endTagFixes(analysis, structure, start);
    case 'unexpected-end-tag':
      return unexpectedEndTagFixes(analysis, structure, start, end);
    case 'missing-child-element':
      // The children of an element a patch brings in are the patched file's: not fixed from the patch.
      return analysis.detection.isDiff ? [] : requiredChildFixes(analysis, structure, start);
    case 'invalid-child-element':
      return analysis.detection.isDiff ? [] : moveChildFixes(analysis, structure, start);
  }
  return [];
}
