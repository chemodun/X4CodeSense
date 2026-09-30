/**
 * The right side of a patch comparison as the editor holds it, and the stretches of it that the patch holds
 * as they are: a caret there has its place in the patch, and typing there goes into the patch. Free of the
 * `vscode` module, so it is tested on its own.
 */
import type { OwnPiece } from 'x4-script-core';

/** A stretch of the side's text as the patch has it: offsets in the side, and where it starts in the patch. */
export interface Segment {
  start: number;
  end: number;
  patchStart: number;
  /** When the side shows it at another column: the indentation of its lines in the side, and in the patch. */
  indent?: { side: string; patch: string };
}

export interface SideText {
  text: string;
  /** In text order, apart. */
  segments: Segment[];
}

/**
 * The patched text as the editor will hold it, with the patch's own pieces in it. When the editor loads a
 * text it drops a byte order mark and makes mixed line breaks uniform, which would move the offsets after
 * them; so the text is given to it that way already, with the patch's line break throughout. The patch's
 * own pieces have that line break, so they keep their length.
 */
export function sideText(text: string, own: readonly OwnPiece[], eol: string): SideText {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const parts: string[] = [];
  // From each of these offsets of `text` on, the side's offsets differ by `shift`.
  const shifts: { at: number; shift: number }[] = [];
  let shift = -bom;
  let last = bom;
  const lineBreak = /\r\n|\r|\n/g;
  lineBreak.lastIndex = bom;
  for (let match = lineBreak.exec(text); match; match = lineBreak.exec(text)) {
    if (match[0] === eol) {
      continue;
    }
    parts.push(text.slice(last, match.index), eol);
    last = match.index + match[0].length;
    shift += eol.length - match[0].length;
    shifts.push({ at: last, shift });
  }
  parts.push(text.slice(last));
  const sideOffset = (offset: number): number => {
    let low = 0;
    let high = shifts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (shifts[middle].at <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return offset + (low === 0 ? -bom : shifts[low - 1].shift);
  };
  return {
    text: parts.join(''),
    segments: own.map((piece) => ({
      start: sideOffset(piece.start),
      end: sideOffset(piece.end),
      patchStart: piece.patchStart,
      ...(piece.indent ? { indent: piece.indent } : {}),
    })),
  };
}

/**
 * A change inside a segment that the side shows at another column, with line breaks in its text: in the
 * patch, each new line starts with the patch's indentation instead of the side's. The segment becomes one
 * part per line, each after the indentation that differs.
 */
function moved(segment: Segment, change: TextChange, indent: { side: string; patch: string }): { text: string; parts: Segment[] } {
  const pieces = change.text.split(/(\r\n|\r|\n)/);
  let text = pieces[0];
  const parts: Segment[] = [];
  let sideAt = change.offset + pieces[0].length;
  let patchAt = segment.patchStart + change.offset - segment.start + pieces[0].length;
  let partStart = segment.start;
  let partPatch = segment.patchStart;
  for (let at = 1; at < pieces.length; at += 2) {
    const lineBreak = pieces[at];
    const line = pieces[at + 1];
    text += lineBreak;
    sideAt += lineBreak.length;
    patchAt += lineBreak.length;
    parts.push({ start: partStart, end: sideAt, patchStart: partPatch, indent });
    const written = line.startsWith(indent.side) ? indent.patch + line.slice(indent.side.length) : line;
    const skipped = line.startsWith(indent.side) ? indent.side.length : 0;
    partStart = sideAt + skipped;
    partPatch = patchAt + (written.length - line.length + skipped);
    text += written;
    sideAt += line.length;
    patchAt += written.length;
  }
  parts.push({ start: partStart, end: segment.end + change.text.length - change.length, patchStart: partPatch, indent });
  return { text, parts };
}

/** Index of the last segment that starts at or before the offset, -1 when none does. */
function segmentAt(segments: readonly Segment[], offset: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (segments[middle].start <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

/** Where an offset of the side lies in the patch, when a segment holds it (its end included). */
export function patchOffsetAt(segments: readonly Segment[], offset: number): number | undefined {
  const segment = segments[segmentAt(segments, offset)];
  return segment && offset <= segment.end ? segment.patchStart + offset - segment.start : undefined;
}

/** Where an offset of the patch lies in the side, when a segment holds it (its end included). */
export function sideOffsetAt(segments: readonly Segment[], offset: number): number | undefined {
  const segment = segments.find((candidate) => candidate.patchStart <= offset && offset <= candidate.patchStart + candidate.end - candidate.start);
  return segment ? segment.start + offset - segment.patchStart : undefined;
}

/** A change of a text: `length` characters at `offset` replaced by `text`. */
export interface TextChange {
  offset: number;
  length: number;
  text: string;
}

export interface MappedChanges {
  /** The changes that lie inside a segment, in the patch: offsets in the patch before any of them. */
  edits: TextChange[];
  /** The segments after the changes, in the side and in the patch once the edits are made. */
  segments: Segment[];
  /**
   * False when a change lies neither inside one segment nor outside all of them changing whitespace alone:
   * the patch has no place for it as it is.
   */
  mapped: boolean;
}

/**
 * The changes of one editor event on the side, with offsets in the side's text before any of them and not
 * overlapping, mapped into the patch. `before` is that text: a change outside the segments that only
 * changes whitespace needs no place in the patch, which does not keep the target's layout.
 */
export function mapChanges(segments: readonly Segment[], changes: readonly TextChange[], before: string): MappedChanges {
  let next = segments.map((segment) => ({ ...segment }));
  const edits: { edit: TextChange; parts: Segment[] }[] = [];
  let mapped = true;
  // From the last change back, so that the offsets of the earlier ones still hold.
  for (const change of [...changes].sort((a, b) => b.offset - a.offset)) {
    const end = change.offset + change.length;
    const delta = change.text.length - change.length;
    const found = next[segmentAt(next, change.offset)];
    const segment = found && end <= found.end ? found : undefined;
    let parts: Segment[] = [];
    if (segment) {
      const offset = segment.patchStart + change.offset - segment.start;
      if (segment.indent && /[\r\n]/.test(change.text)) {
        // New lines of what the side shows at another column get the patch's indentation.
        const written = moved(segment, change, segment.indent);
        edits.push({ edit: { offset, length: change.length, text: written.text }, parts: written.parts });
        next.splice(next.indexOf(segment), 1, ...written.parts);
        parts = written.parts;
      } else {
        edits.push({ edit: { offset, length: change.length, text: change.text }, parts: [segment] });
        segment.end += delta;
        parts = [segment];
      }
    } else {
      const overlapped = next.filter((candidate) => candidate.start < end && change.offset < candidate.end);
      if (overlapped.length > 0 || /\S/.test(change.text) || /\S/.test(before.slice(change.offset, end))) {
        mapped = false;
      }
      // A segment the change cuts into no longer holds the patch's text.
      next = next.filter((candidate) => !overlapped.includes(candidate));
    }
    for (const other of next) {
      if (!parts.includes(other) && other.start >= end) {
        other.start += delta;
        other.end += delta;
      }
    }
  }
  // Each edit moves what follows it in the patch, except inside its own segment.
  for (const other of next) {
    let shift = 0;
    for (const { edit, parts } of edits) {
      if (!parts.includes(other) && edit.offset + edit.length <= other.patchStart) {
        shift += edit.text.length - edit.length;
      }
    }
    other.patchStart += shift;
  }
  return { edits: edits.map(({ edit }) => edit), segments: next, mapped };
}
