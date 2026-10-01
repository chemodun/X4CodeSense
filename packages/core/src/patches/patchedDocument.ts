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
 * What an operation brings in is written at the column of the element it replaces or is added next to,
 * or one step deeper than the element it is added into (as that element's other children are), and
 * its lines move with it; lines inside attribute values and comments stay as written, their whitespace
 * being part of them.
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
  /** For a piece of what was moved to another column: the indentation its lines have in the source, and here. */
  shift?: { from: string; to: string };
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

/** Lines of a source written at another column: those starting with `from` start with `to`. */
interface Shift {
  source: PatchSource;
  from: string;
  to: string;
}

/** The whitespace between the start of the offset's line and the offset, when there is only whitespace. */
function indentBefore(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && (text.charCodeAt(start - 1) === 0x20 || text.charCodeAt(start - 1) === 0x09)) {
    start--;
  }
  return start === 0 || text.charCodeAt(start - 1) === 0x0a || text.charCodeAt(start - 1) === 0x0d ? text.slice(start, offset) : '';
}

/** The stretches of a file whose whitespace belongs to them, attribute values and comments, sorted. */
const verbatimStretches = new WeakMap<PatchSource, XmlRegion[]>();

function insideVerbatim(source: PatchSource, offset: number): boolean {
  let stretches = verbatimStretches.get(source);
  if (!stretches) {
    stretches = [
      ...source.structure.comments,
      ...source.structure.elements.flatMap((element) => element.attributes.map((attribute) => ({ start: attribute.valueStart, end: attribute.valueEnd }))),
    ].sort((a, b) => a.start - b.start);
    verbatimStretches.set(source, stretches);
  }
  let low = 0;
  let high = stretches.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (stretches[middle].start < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 && offset < stretches[low - 1].end;
}

class Writer {
  private readonly parts: string[] = [];
  private length = 0;
  readonly pieces: PatchedPiece[] = [];
  readonly starts = new Map<PatchNode, number>();
  /** The column each node is written at, once asked. */
  readonly columns = new Map<PatchNode, string>();
  private readonly shifts: Shift[] = [];

  get offset(): number {
    return this.length;
  }

  add(text: string): void {
    this.parts.push(text);
    this.length += text.length;
  }

  /** The innermost shift of a source, while its nodes are written at another column. */
  private shiftOf(source: PatchSource): Shift | undefined {
    for (let at = this.shifts.length - 1; at >= 0; at--) {
      if (this.shifts[at].source === source) {
        return this.shifts[at];
      }
    }
    return undefined;
  }

  /** Writes with the lines of a source moved to another column. */
  shifted(shift: Shift | undefined, write: () => void): void {
    if (!shift || shift.from === shift.to) {
      write();
      return;
    }
    this.shifts.push(shift);
    try {
      write();
    } finally {
      this.shifts.pop();
    }
  }

  /** An indentation of a source as it is written now. */
  shiftedIndent(source: PatchSource, indent: string): string {
    const shift = this.shiftOf(source);
    return shift && indent.startsWith(shift.from) ? shift.to + indent.slice(shift.from.length) : indent;
  }

  /** Copies a stretch of a file; `text` when it is written differently, as an escaped value. */
  copy(source: PatchSource, start: number, end: number, text?: string): void {
    const shift = text === undefined ? this.shiftOf(source) : undefined;
    if (!shift) {
      this.piece(source, start, end, text ?? source.text.slice(start, end));
      return;
    }
    // Each line that starts with the source's indentation gets the column's instead, outside values and comments.
    const full = source.text;
    let segment = start;
    for (let at = start; at < end; at++) {
      const code = full.charCodeAt(at);
      if (code !== 0x0a && code !== 0x0d) {
        continue;
      }
      if (code === 0x0d && full.charCodeAt(at + 1) === 0x0a) {
        at++;
      }
      const lineStart = at + 1;
      if (lineStart + shift.from.length > end || !full.startsWith(shift.from, lineStart) || insideVerbatim(source, lineStart)) {
        continue;
      }
      this.piece(source, segment, lineStart, full.slice(segment, lineStart), shift);
      this.add(shift.to);
      segment = lineStart + shift.from.length;
    }
    this.piece(source, segment, end, full.slice(segment, end), shift);
  }

  private piece(source: PatchSource, start: number, end: number, text: string, shift?: Shift): void {
    if (text === '') {
      return;
    }
    const last = this.pieces[this.pieces.length - 1];
    const exact = text.length === end - start;
    const moved = shift && { from: shift.from, to: shift.to };
    if (
      last &&
      exact &&
      last.source === source &&
      last.end === this.length &&
      last.sourceEnd === start &&
      last.end - last.start === last.sourceEnd - last.sourceStart &&
      last.shift?.from === moved?.from &&
      last.shift?.to === moved?.to
    ) {
      last.end += text.length;
      last.sourceEnd = end;
    } else {
      this.pieces.push({ start: this.length, end: this.length + text.length, source, sourceStart: start, sourceEnd: end, ...(moved ? { shift: moved } : {}) });
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
 * when the next one has none before it. `indent`, for what an operation brings in, is the column the next
 * one starts at instead of its own.
 */
function writeGap(writer: Writer, from: Cursor | undefined, source: PatchSource, to: number | undefined, indent?: string): void {
  if (from && to !== undefined && from.source === source && from.offset <= to) {
    const markup = source.text.indexOf('<', from.offset);
    if (markup === -1 || markup >= to) {
      const lastBreak = Math.max(source.text.lastIndexOf('\n', to - 1), source.text.lastIndexOf('\r', to - 1));
      if (indent === undefined || lastBreak < from.offset) {
        writer.copy(source, from.offset, to);
      } else {
        writer.copy(source, from.offset, lastBreak + 1);
        writer.add(indent);
      }
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
    writer.add(`${lineBreakOf(source.text)}${indent ?? ''}`);
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
  const text = ending === 0 ? rest : before.slice(lineEnd, end + ending) + rest.slice(rest.startsWith('\r\n') ? 2 : 1);
  // The indentation of the next one: its column when an operation brought it in, else its own as moved with what holds it.
  const lastLine = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
  writer.add(text.slice(0, lastLine) + (indent ?? writer.shiftedIndent(source, text.slice(lastLine))));
}

/** The line break a file uses, by its first one. */
function lineBreakOf(text: string): string {
  const at = text.search(/[\r\n]/);
  return at === -1 || text[at] === '\n' ? '\n' : text[at + 1] === '\n' ? '\r\n' : '\r';
}

/** Where a document type declaration that follows an offset, after spaces only, ends; the offset when none does. */
function doctypeEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && /\s/.test(text[at])) {
    at++;
  }
  if (!text.startsWith('<!DOCTYPE', at)) {
    return from;
  }
  const subset = text.indexOf('[', at);
  const close = text.indexOf('>', at);
  const end = subset !== -1 && subset < close ? text.indexOf('>', text.indexOf(']', subset)) : close;
  return end === -1 ? from : end + 1;
}

/** The indentation of a node's line in its file, when nothing else is before it on the line. */
function ownIndent(node: PatchNode): string {
  const region = node.element ?? node.comment;
  return region ? indentBefore(node.source.text, region.start) : '';
}

/**
 * The column a node is written at. What an operation brought in takes the column of the node it replaces
 * or is added next to, or of the other children of the node it is added into (one step deeper than that
 * node when it has none); anything else its own, moved with the node an operation brought in that holds it.
 */
function columnOf(writer: Writer, node: PatchNode): string {
  const known = writer.columns.get(node);
  if (known !== undefined) {
    return known;
  }
  let column = ownIndent(node);
  if (node.placed) {
    const { anchor, deeper } = node.placed;
    const sibling = deeper ? anchor.children.find((child) => !child.placed && (child.element ?? child.comment)) : undefined;
    if (!deeper) {
      column = columnOf(writer, anchor);
    } else if (sibling) {
      column = columnOf(writer, sibling);
    } else {
      const own = columnOf(writer, anchor);
      const outer = anchor.parent?.kind === 'element' ? columnOf(writer, anchor.parent) : undefined;
      column = own + (outer !== undefined && own.length > outer.length && own.startsWith(outer) ? own.slice(outer.length) : own.includes('\t') ? '\t' : '  ');
    }
  } else {
    for (let at = node.parent; at && at.source === node.source; at = at.parent) {
      if (at.placed) {
        const from = ownIndent(at);
        column = column.startsWith(from) ? columnOf(writer, at) + column.slice(from.length) : column;
        break;
      }
    }
  }
  writer.columns.set(node, column);
  return column;
}

function writeChildren(writer: Writer, node: PatchNode, from: Cursor | undefined, to: number | undefined): void {
  let cursor = from;
  for (const child of node.children) {
    const region: XmlRegion | undefined = child.element ?? child.comment;
    if (!region) {
      continue;
    }
    const column = child.placed ? columnOf(writer, child) : undefined;
    writeGap(writer, cursor, child.source, region.start, column);
    writer.shifted(column === undefined ? undefined : { source: child.source, from: ownIndent(child), to: column }, () => writeNode(writer, child));
    cursor = { source: child.source, offset: region.end };
  }
  // An end tag the node did not have (it was self-closing, or cut off) goes on a line at the node's column.
  writeGap(writer, cursor, node.source, to, to === undefined && node.kind === 'element' && node.children.length > 0 ? columnOf(writer, node) : undefined);
}

function writeNode(writer: Writer, node: PatchNode): void {
  const source = node.source;
  if (node.comment) {
    writer.copy(source, node.comment.start, node.comment.end);
    return;
  }
  const element = node.element;
  if (!element) {
    // The XML declaration and a document type declaration (library files have them), which are no nodes of
    // the tree, after the byte order mark when there is one.
    const text = source.text;
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const end = text.startsWith('<?xml', start) ? text.indexOf('?>', start) : -1;
    const next = text.indexOf('<', start + 1);
    const prolog = doctypeEnd(text, end !== -1 && (next === -1 || next > end) ? end + 2 : 0);
    writer.copy(source, 0, prolog);
    writeChildren(writer, node, { source, offset: prolog }, source.text.length);
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
