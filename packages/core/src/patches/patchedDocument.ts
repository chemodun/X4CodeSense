/**
 * The patched target written out as text, with the file each piece of the text comes from.
 *
 * A subtree no patch changed is copied as written, from the target or from the patch that inserted it. A
 * changed element keeps its start tag when its attributes are unchanged, and gets one rebuilt from its
 * attributes otherwise: each attribute copied from where it was written, a value a patch set from the
 * text of the operation, its name from the operation's `type` or `sel`. An element that is not complete in
 * its file (a start tag cut off, an end tag missing, as while typing) is written like a changed one, so
 * that it closes where it ends and does not take in the nodes after it; a cut-off start tag whose values
 * are all closed is copied as written, with the whitespace after them, where a caret may be. Between
 * children, the text that separated them in their file is kept when they were neighbours there; otherwise
 * the line breaks and indentation the next one has before it in its file are added. Added text (line
 * breaks, indentation, `>`, quotes, the end tag of an element that had none) comes from no file.
 *
 * The text is analysed as the target script; the pieces take what the analysis finds back to the files,
 * and a caret in a file to its place in the text.
 */
import { attributeNamed, type XmlAttribute, type XmlElement, type XmlRegion } from '../xml/xmlStructure';
import type { PatchNode, PatchNodeAttribute, PatchSource } from './patchTree';

/** A stretch of the written text copied from a file. */
export interface PatchedPiece {
  /** Offsets in the written text. */
  start: number;
  end: number;
  source: PatchSource;
  /** Offsets in the source's text; as long as the piece, except for a value that had to be escaped. */
  sourceStart: number;
  sourceEnd: number;
}

export interface PatchedText {
  text: string;
  /** The copied pieces in text order; the text between them was added. */
  pieces: PatchedPiece[];
  /**
   * Where the start tag of each element node written piece by piece begins in the text: those a patch
   * changed and those not complete in their file. Unchanged subtrees are copied whole.
   */
  starts: Map<PatchNode, number>;
}

class Writer {
  private readonly parts: string[] = [];
  private length = 0;
  readonly pieces: PatchedPiece[] = [];
  readonly starts = new Map<PatchNode, number>();

  get offset(): number {
    return this.length;
  }

  add(text: string): void {
    this.parts.push(text);
    this.length += text.length;
  }

  copy(source: PatchSource, start: number, end: number, text = source.text.slice(start, end)): void {
    if (text === '') {
      return;
    }
    const last = this.pieces[this.pieces.length - 1];
    const exact = text.length === end - start;
    if (
      last &&
      exact &&
      last.source === source &&
      last.end === this.length &&
      last.sourceEnd === start &&
      last.end - last.start === last.sourceEnd - last.sourceStart
    ) {
      last.end += text.length;
      last.sourceEnd = end;
    } else {
      this.pieces.push({ start: this.length, end: this.length + text.length, source, sourceStart: start, sourceEnd: end });
    }
    this.add(text);
  }

  written(): PatchedText {
    return { text: this.parts.join(''), pieces: this.pieces, starts: this.starts };
  }
}

/** True when the element and everything in it is closed as XML requires. */
function isComplete(element: XmlElement, text: string): boolean {
  if (!element.startTagClosed) {
    return false;
  }
  if (!element.selfClosing && (!element.endTag || text.charCodeAt(element.endTag.end - 1) !== 0x3e)) {
    return false;
  }
  return element.children.every((child) => isComplete(child, text));
}

/** The attribute as written in its file: name, `=`, and its value in quotes. */
function writeAttribute(writer: Writer, source: PatchSource, attribute: XmlAttribute): void {
  if (attribute.closed && attribute.quote !== '') {
    writer.copy(source, attribute.start, attribute.end);
    return;
  }
  writer.copy(source, attribute.nameStart, attribute.nameEnd);
  if (attribute.valueEnd > attribute.valueStart || attribute.quote !== '') {
    const quote = attribute.quote || '"';
    writer.add(`=${quote}`);
    writer.copy(source, attribute.valueStart, attribute.valueEnd);
    writer.add(quote);
  }
}

/** An attribute a patch set: its name from the operation's `type` or `sel`, its value from the operation's text. */
function writeSetAttribute(writer: Writer, attribute: PatchNodeAttribute, operation: XmlElement, source: PatchSource): void {
  const naming = attributeNamed(operation, 'type') ?? attributeNamed(operation, 'sel');
  if (naming?.rawValue.endsWith(attribute.name)) {
    writer.copy(source, naming.valueEnd - attribute.name.length, naming.valueEnd);
  } else {
    writer.add(attribute.name);
  }
  let start = operation.startTagEnd;
  let end = operation.endTag?.start ?? start;
  const text = source.text;
  while (start < end && /\s/.test(text[start])) {
    start++;
  }
  while (end > start && /\s/.test(text[end - 1])) {
    end--;
  }
  const raw = text.slice(start, end);
  if (raw.includes('<')) {
    // A comment or markup inside: the value the game reads, escaped, placed over the whole text.
    const escaped = attribute.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    writer.add('="');
    writer.copy(source, start, end, escaped);
    writer.add('"');
    return;
  }
  const quote = !raw.includes('"') ? '"' : !raw.includes("'") ? "'" : '"';
  writer.add(`=${quote}`);
  writer.copy(source, start, end, quote === '"' ? raw.replace(/"/g, '&quot;') : raw);
  writer.add(quote);
}

/**
 * The start tag of an element written out whole: as written when its attributes are, rebuilt otherwise.
 * An element written self-closing that still has no children stays so.
 */
function writeStartTag(writer: Writer, node: PatchNode, element: XmlElement, empty: boolean): void {
  const source = node.source;
  writer.starts.set(node, writer.offset);
  const kept =
    node.attributes.length === element.attributes.length &&
    node.attributes.every((attribute, index) => attribute.setBy === undefined && attribute.written === element.attributes[index]);
  if (kept && element.startTagClosed) {
    writer.copy(source, element.start, element.selfClosing && !empty ? element.startTagEnd - 2 : element.startTagEnd);
    if (element.selfClosing && !empty) {
      writer.add('>');
    }
    return;
  }
  if (kept && element.attributes.every((attribute) => attribute.quote === '' || attribute.closed)) {
    // Cut off while typing, with every value closed: as written, the whitespace after the last attribute
    // too, so that a caret there has its place in the text.
    writer.copy(source, element.start, element.startTagEnd);
    writer.add('>');
    return;
  }
  writer.copy(source, element.start, element.nameEnd);
  for (const attribute of node.attributes) {
    writer.add(' ');
    if (attribute.setBy) {
      writeSetAttribute(writer, attribute, attribute.setBy.operation, attribute.setBy.source);
    } else if (attribute.written) {
      writeAttribute(writer, source, attribute.written);
    }
  }
  writer.add(empty ? '/>' : '>');
}

interface Cursor {
  source: PatchSource;
  offset: number;
}

/**
 * The text between two neighbours in the same file. When they were not neighbours there, the spaces and
 * the line break that end the line of the one before, then the empty lines and indentation the next one
 * has before it in its file, so that a comparison with the target shows only what changed; a line break
 * when the next one has none before it.
 */
function writeGap(writer: Writer, from: Cursor | undefined, source: PatchSource, to: number | undefined): void {
  if (from && to !== undefined && from.source === source && from.offset <= to) {
    const markup = source.text.indexOf('<', from.offset);
    if (markup === -1 || markup >= to) {
      writer.copy(source, from.offset, to);
      return;
    }
  }
  let start = to ?? 0;
  while (start > 0 && /\s/.test(source.text[start - 1])) {
    start--;
  }
  const space = to === undefined ? '' : source.text.slice(start, to);
  const lineBreak = space.search(/[\r\n]/);
  if (lineBreak === -1) {
    writer.add('\n');
    return;
  }
  const rest = space.slice(lineBreak);
  const before = from?.source.text ?? '';
  const lineEnd = from?.offset ?? 0;
  let end = lineEnd;
  while (before[end] === ' ' || before[end] === '\t') {
    end++;
  }
  const ending = before.startsWith('\r\n', end) ? 2 : before[end] === '\n' || before[end] === '\r' ? 1 : 0;
  writer.add(ending === 0 ? rest : before.slice(lineEnd, end + ending) + rest.slice(rest.startsWith('\r\n') ? 2 : 1));
}

function writeChildren(writer: Writer, node: PatchNode, from: Cursor | undefined, to: number | undefined): void {
  let cursor = from;
  for (const child of node.children) {
    const region: XmlRegion | undefined = child.element ?? child.comment;
    if (!region) {
      continue;
    }
    writeGap(writer, cursor, child.source, region.start);
    writeNode(writer, child);
    cursor = { source: child.source, offset: region.end };
  }
  writeGap(writer, cursor, node.source, to);
}

function writeNode(writer: Writer, node: PatchNode): void {
  const source = node.source;
  if (node.comment) {
    writer.copy(source, node.comment.start, node.comment.end);
    return;
  }
  const element = node.element;
  if (!element) {
    // The XML declaration, which is no node of the tree, after the byte order mark when there is one.
    const text = source.text;
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const end = text.startsWith('<?xml', start) ? text.indexOf('?>', start) : -1;
    const next = text.indexOf('<', start + 1);
    const declaration = end !== -1 && (next === -1 || next > end) ? end + 2 : 0;
    writer.copy(source, 0, declaration);
    writeChildren(writer, node, { source, offset: declaration }, source.text.length);
    return;
  }
  if (!node.changed && isComplete(element, source.text)) {
    writer.copy(source, element.start, element.end);
    return;
  }
  const empty = element.selfClosing && element.startTagClosed && node.children.length === 0;
  writeStartTag(writer, node, element, empty);
  if (empty) {
    return;
  }
  const closed = element.endTag && source.text.charCodeAt(element.endTag.end - 1) === 0x3e;
  writeChildren(writer, node, element.selfClosing ? undefined : { source, offset: element.startTagEnd }, closed ? element.endTag?.start : undefined);
  if (closed && element.endTag) {
    writer.copy(source, element.endTag.start, element.endTag.end);
  } else {
    writer.add(`</${element.name}>`);
  }
}

/** Writes out a patched tree as the text the game would load, with the file of each piece. */
export function writePatchedTree(document: PatchNode): PatchedText {
  const writer = new Writer();
  writeNode(writer, document);
  return writer.written();
}

/** Index of the last piece that starts at or before the offset, -1 when none does. */
function pieceAt(pieces: readonly PatchedPiece[], offset: number): number {
  let low = 0;
  let high = pieces.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (pieces[middle].start <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

function sourceOffset(piece: PatchedPiece, offset: number): number {
  return piece.sourceStart + Math.min(Math.max(offset - piece.start, 0), piece.sourceEnd - piece.sourceStart);
}

/** The file an offset of the written text comes from, and the offset there; undefined for added text. */
export function sourceOffsetAt(written: PatchedText, offset: number): { source: PatchSource; offset: number } | undefined {
  const piece = written.pieces[pieceAt(written.pieces, offset)];
  return piece && offset <= piece.end ? { source: piece.source, offset: sourceOffset(piece, offset) } : undefined;
}

/**
 * Where an offset of a file lies in the written text: inside a piece copied from the file, else at the
 * end of one. Undefined when nothing around the offset was copied.
 */
export function writtenOffset(written: PatchedText, source: PatchSource, offset: number): number | undefined {
  let atEnd: number | undefined;
  for (const piece of written.pieces) {
    if (piece.source !== source || offset < piece.sourceStart || offset > piece.sourceEnd) {
      continue;
    }
    const at = piece.start + Math.min(offset - piece.sourceStart, piece.end - piece.start);
    if (offset < piece.sourceEnd) {
      return at;
    }
    atEnd ??= at;
  }
  return atEnd;
}

/** A test for ranges of the written text: true when the range overlaps a piece copied from the file. */
export function overlapsPieceOf(written: PatchedText, source: PatchSource): (start: number, end: number) => boolean {
  const pieces = written.pieces.filter((piece) => piece.source === source);
  // Sorted and apart: only the last piece that starts before the range ends can reach into it.
  return (start, end) => (pieces[pieceAt(pieces, end - 1)]?.end ?? 0) > start;
}

/**
 * Where a range of the written text lies in a file, when it starts in a piece copied from that file.
 * The end is kept when it lies in that file too, after the start; otherwise the range ends with its piece.
 */
export function sourceRange(written: PatchedText, source: PatchSource, start: number, end: number): XmlRegion | undefined {
  const pieces = written.pieces;
  const first = pieces[pieceAt(pieces, start)];
  if (!first || first.source !== source || start > first.end) {
    return undefined;
  }
  const mappedStart = sourceOffset(first, start);
  const last = end > start ? pieces[pieceAt(pieces, end - 1)] : first;
  const mappedEnd = last && last.source === source && end <= last.end ? sourceOffset(last, end) : sourceOffset(first, end);
  return { start: mappedStart, end: Math.max(mappedStart, mappedEnd) };
}
