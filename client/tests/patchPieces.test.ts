import { describe, expect, it } from 'vitest';
import { mapChanges, patchOffsetAt, sideOffsetAt, sideText, type Segment } from '../src/patchPieces';

describe('the patched side as the editor holds it', () => {
  // A byte order mark, then `<a>`, CRLF, `  <b x="1"/>` (the patch's own piece, at 40 in the patch), CRLF, `</a>`, LF.
  const text = `${String.fromCharCode(0xfeff)}<a>\r\n  <b x="1"/>\r\n</a>\n`;
  const own = [{ start: 8, end: 18, patchStart: 40 }];

  it('drops the byte order mark and gives every line the patch’s line break, the pieces moved with the text', () => {
    const lf = sideText(text, own, '\n');
    expect(lf.text).toBe('<a>\n  <b x="1"/>\n</a>\n');
    expect(lf.segments).toEqual([{ start: 6, end: 16, patchStart: 40 }]);
    expect(lf.text.slice(6, 16)).toBe('<b x="1"/>');
    const crlf = sideText(text, own, '\r\n');
    expect(crlf.text).toBe('<a>\r\n  <b x="1"/>\r\n</a>\r\n');
    expect(crlf.text.slice(crlf.segments[0].start, crlf.segments[0].end)).toBe('<b x="1"/>');
  });

  it('keeps a piece whole that has the line break already', () => {
    const patchText = '<c/>\n  <d/>';
    const side = sideText(`<a>\r\n${patchText}\r\n</a>`, [{ start: 5, end: 5 + patchText.length, patchStart: 0 }], '\n');
    expect(side.text.slice(side.segments[0].start, side.segments[0].end)).toBe(patchText);
  });

  it('finds a caret of the side in the patch and back, where a piece holds it', () => {
    const segments: Segment[] = [
      { start: 10, end: 20, patchStart: 100 },
      { start: 30, end: 40, patchStart: 50 },
    ];
    expect([9, 10, 15, 20, 25, 30, 40, 41].map((offset) => patchOffsetAt(segments, offset))).toEqual([undefined, 100, 105, 110, undefined, 50, 60, undefined]);
    expect([49, 50, 55, 60, 61, 100, 110].map((offset) => sideOffsetAt(segments, offset))).toEqual([undefined, 30, 35, 40, undefined, 10, 20]);
  });
});

describe('typing in the patched side', () => {
  // Side order and patch order differ: the second piece comes first in the patch.
  const segments: Segment[] = [
    { start: 10, end: 20, patchStart: 100 },
    { start: 30, end: 40, patchStart: 50 },
  ];
  const before = `${'.'.repeat(10)}0123456789${' '.repeat(10)}abcdefghij${'.'.repeat(10)}`;

  it('takes a change inside a piece to the patch, moving what follows in the side and in the patch', () => {
    expect(mapChanges(segments, [{ offset: 15, length: 0, text: 'xy' }], before)).toEqual({
      edits: [{ offset: 105, length: 0, text: 'xy' }],
      segments: [
        { start: 10, end: 22, patchStart: 100 },
        { start: 32, end: 42, patchStart: 50 },
      ],
      mapped: true,
    });
    expect(mapChanges(segments, [{ offset: 32, length: 3, text: '' }], before)).toEqual({
      edits: [{ offset: 52, length: 3, text: '' }],
      segments: [
        { start: 10, end: 20, patchStart: 97 },
        { start: 30, end: 37, patchStart: 50 },
      ],
      mapped: true,
    });
  });

  it('takes several changes of one event, each at its place in the patch as it was', () => {
    const result = mapChanges(
      segments,
      [
        { offset: 12, length: 1, text: 'AB' },
        { offset: 40, length: 0, text: 'C' },
      ],
      before
    );
    expect(result.edits).toEqual([
      { offset: 60, length: 0, text: 'C' },
      { offset: 102, length: 1, text: 'AB' },
    ]);
    expect(result.segments).toEqual([
      { start: 10, end: 21, patchStart: 101 },
      { start: 31, end: 42, patchStart: 50 },
    ]);
    expect(result.mapped).toBe(true);
  });

  it('gives a new line of what the side shows at another column the indentation the patch has', () => {
    const indent = { side: '        ', patch: '    ' };
    const result = mapChanges([{ start: 10, end: 30, patchStart: 100, indent }], [{ offset: 20, length: 0, text: '\n        x' }], before);
    expect(result.edits).toEqual([{ offset: 110, length: 0, text: '\n    x' }]);
    // One part per line, the new one after the indentation that differs.
    expect(result.segments).toEqual([
      { start: 10, end: 21, patchStart: 100, indent },
      { start: 29, end: 40, patchStart: 115, indent },
    ]);
    expect(patchOffsetAt(result.segments, 30)).toBe(116);
  });

  it('lets whitespace change between the pieces, which the patch does not hold', () => {
    expect(mapChanges(segments, [{ offset: 22, length: 2, text: '\n    ' }], before)).toEqual({
      edits: [],
      segments: [
        { start: 10, end: 20, patchStart: 100 },
        { start: 33, end: 43, patchStart: 50 },
      ],
      mapped: true,
    });
  });

  it('has no place in the patch for other changes outside the pieces or across their edges', () => {
    expect(mapChanges(segments, [{ offset: 2, length: 0, text: 'x' }], before).mapped).toBe(false);
    expect(mapChanges(segments, [{ offset: 2, length: 2, text: '' }], before).mapped).toBe(false);
    const across = mapChanges(segments, [{ offset: 18, length: 4, text: '' }], before);
    expect(across.mapped).toBe(false);
    // The piece it cut into no longer holds the patch's text.
    expect(across.segments).toEqual([{ start: 26, end: 36, patchStart: 50 }]);
  });
});
