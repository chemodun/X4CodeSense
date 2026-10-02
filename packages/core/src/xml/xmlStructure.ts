/**
 * Tolerant XML structure scanner.
 *
 * One pass over the text builds the element tree with exact offsets for every element, start tag, end tag,
 * name and attribute. It never throws and never gives up: broken input (a start tag cut off by the next `<`,
 * a missing closing quote, a missing end tag) is repaired in the most local way and reported as a problem,
 * so the rest of the document keeps its structure while the user is typing.
 *
 * Offsets are UTF-16 code unit indexes into the text, as used by `String.prototype.slice`; ranges are half open.
 * Names keep their case: the game's XML is case sensitive.
 */

export type QuoteChar = '"' | "'" | '';

/** A character or entity reference inside an attribute value. */
export interface EntityReference {
  /** Offset of `&`, relative to the start of the raw value. */
  rawStart: number;
  /** Length in the raw text, `&` and `;` included. */
  rawLength: number;
  /** Index of the replacement in the decoded value. */
  decodedStart: number;
  /** Length of the replacement in the decoded value. */
  decodedLength: number;
}

export interface XmlAttribute {
  /** Attribute name as written. */
  name: string;
  /** Attribute value with character and entity references decoded. */
  value: string;
  /** Attribute value exactly as written between the quotes. */
  rawValue: string;
  /** Element the attribute belongs to. */
  element: XmlElement;
  /** Offset of the first character of the name. */
  start: number;
  /** Offset after the closing quote, or after the value when the closing quote is missing. */
  end: number;
  nameStart: number;
  nameEnd: number;
  /** Offsets of the raw value between the quotes. An empty range at `nameEnd` when there is no value at all. */
  valueStart: number;
  valueEnd: number;
  /** Quote character, empty when the value is unquoted or missing. */
  quote: QuoteChar;
  /** False when the closing quote is missing. */
  closed: boolean;
  /** References inside the raw value in text order; empty for most attributes. */
  references: EntityReference[];
}

export interface XmlEndTag {
  /** Offset of `<`. */
  start: number;
  /** Offset after `>`, or where a cut-off end tag ends. */
  end: number;
  nameStart: number;
  nameEnd: number;
}

export interface XmlElement {
  name: string;
  /** Offset of `<`. */
  start: number;
  /** Offset after the element: after `/>`, after the end tag, or where an unclosed element was cut off. */
  end: number;
  nameStart: number;
  nameEnd: number;
  /** Offset after `>` or `/>` of the start tag, or where a cut-off start tag ends. */
  startTagEnd: number;
  /** True when the start tag ends with `/>`, and for a start tag cut off by `<` or the end of the text. */
  selfClosing: boolean;
  /** True when the start tag ends with `>` or `/>`. */
  startTagClosed: boolean;
  /** The matching end tag, when present. */
  endTag?: XmlEndTag;
  parent?: XmlElement;
  /** Previous element sibling. */
  previous?: XmlElement;
  children: XmlElement[];
  attributes: XmlAttribute[];
  /** Names of the ancestors, nearest first, in the order `xsd-lookup` expects. */
  hierarchy: string[];
  /** Index in `XmlStructure.elements`, which is document order. */
  index: number;
}

export type XmlProblemCode =
  | 'unclosed-start-tag'
  | 'unclosed-end-tag'
  | 'unclosed-attribute'
  | 'missing-attribute-value'
  | 'unquoted-attribute-value'
  | 'duplicate-attribute'
  | 'unexpected-character'
  | 'missing-end-tag'
  | 'unexpected-end-tag'
  | 'unclosed-comment'
  | 'unclosed-cdata'
  | 'unclosed-processing-instruction'
  | 'unclosed-declaration';

export interface XmlProblem {
  code: XmlProblemCode;
  message: string;
  start: number;
  end: number;
}

export interface XmlRegion {
  start: number;
  end: number;
}

export interface XmlStructure {
  /** Every element in document order. */
  elements: XmlElement[];
  /** Elements without a parent. A well formed document has exactly one. */
  roots: XmlElement[];
  /** Comments, in document order. An unclosed comment runs to the end of the text. */
  comments: XmlRegion[];
  /** Well-formedness problems in the order they were found. Empty for a well formed document. */
  problems: XmlProblem[];
}

export interface ParseXmlOptions {
  /** Stop after the first start tag has been read: enough to classify a document. */
  stopAfterFirstStartTag?: boolean;
}

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const EQUALS = 0x3d;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const EXCLAMATION = 0x21;
const QUESTION = 0x3f;
const HASH = 0x23;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const UNDERSCORE = 0x5f;
const COLON = 0x3a;
const MINUS = 0x2d;
const DOT = 0x2e;

function isWhitespace(code: number): boolean {
  return code === SPACE || code === LINE_FEED || code === CARRIAGE_RETURN || code === TAB;
}

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code > 0x7f;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isNameStart(code: number): boolean {
  return isLetter(code) || code === UNDERSCORE || code === COLON;
}

function isNameChar(code: number): boolean {
  return isNameStart(code) || isDigit(code) || code === MINUS || code === DOT;
}

/** Longest reference body worth looking at: `&#x10FFFF;` has 8 characters between `&` and `;`. */
const maxReferenceBodyLength = 8;

const namedReferences: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function resolveReference(body: string): string | undefined {
  if (body.charCodeAt(0) === HASH) {
    const second = body.charCodeAt(1);
    const hex = second === 0x78 || second === 0x58;
    const digits = body.slice(hex ? 2 : 1);
    if (digits.length === 0 || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
      return undefined;
    }
    const codePoint = parseInt(digits, hex ? 16 : 10);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return undefined;
    }
    return String.fromCodePoint(codePoint);
  }
  return Object.prototype.hasOwnProperty.call(namedReferences, body) ? namedReferences[body] : undefined;
}

/** Decodes the references in a raw attribute value, recording each one in `references`. Unknown references stay as written. */
export function decodeAttributeValue(raw: string, references: EntityReference[]): string {
  let ampersand = raw.indexOf('&');
  if (ampersand < 0) {
    return raw;
  }
  let decoded = '';
  let copiedUpTo = 0;
  while (ampersand >= 0) {
    const semicolon = raw.indexOf(';', ampersand + 1);
    const replacement =
      semicolon > 0 && semicolon - ampersand - 1 <= maxReferenceBodyLength ? resolveReference(raw.slice(ampersand + 1, semicolon)) : undefined;
    if (replacement !== undefined) {
      decoded += raw.slice(copiedUpTo, ampersand);
      references.push({ rawStart: ampersand, rawLength: semicolon + 1 - ampersand, decodedStart: decoded.length, decodedLength: replacement.length });
      decoded += replacement;
      copiedUpTo = semicolon + 1;
      ampersand = raw.indexOf('&', copiedUpTo);
    } else {
      ampersand = raw.indexOf('&', ampersand + 1);
    }
  }
  return decoded + raw.slice(copiedUpTo);
}

/**
 * Offset in the text of an index into the decoded value of an attribute.
 * An index inside a decoded reference maps to the `&` of that reference.
 */
export function offsetInValue(attribute: XmlAttribute, decodedIndex: number): number {
  let shift = 0;
  for (const reference of attribute.references) {
    if (decodedIndex < reference.decodedStart) {
      break;
    }
    if (decodedIndex < reference.decodedStart + reference.decodedLength) {
      return attribute.valueStart + reference.rawStart;
    }
    shift += reference.rawLength - reference.decodedLength;
  }
  return attribute.valueStart + decodedIndex + shift;
}

/**
 * Index into the decoded value of an attribute for a text offset inside its raw value.
 * An offset inside a reference maps to the start of its replacement.
 */
export function indexInValue(attribute: XmlAttribute, offset: number): number {
  const raw = offset - attribute.valueStart;
  let shift = 0;
  for (const reference of attribute.references) {
    if (raw < reference.rawStart) {
      break;
    }
    if (raw < reference.rawStart + reference.rawLength) {
      return reference.decodedStart;
    }
    shift += reference.rawLength - reference.decodedLength;
  }
  return raw - shift;
}

/** Text offsets of a range inside the decoded value of an attribute. */
export function rangeInValue(attribute: XmlAttribute, decodedStart: number, decodedEnd: number): XmlRegion {
  return { start: offsetInValue(attribute, decodedStart), end: offsetInValue(attribute, decodedEnd) };
}

/** Matches `name =` (with the whitespace that must precede an attribute) at the end of a string. */
const attributeStartBeforeQuote = /\s+[A-Za-z_:][\w:.-]*\s*=\s*$/;

class Scanner {
  private readonly text: string;
  private readonly length: number;
  private readonly elements: XmlElement[] = [];
  private readonly roots: XmlElement[] = [];
  private readonly comments: XmlRegion[] = [];
  private readonly problems: XmlProblem[] = [];
  private readonly open: XmlElement[] = [];

  constructor(text: string) {
    this.text = text;
    this.length = text.length;
  }

  scan(options: ParseXmlOptions): XmlStructure {
    const text = this.text;
    const length = this.length;
    let position = 0;
    while (position < length) {
      const lt = text.indexOf('<', position);
      if (lt < 0) {
        break;
      }
      const next = text.charCodeAt(lt + 1);
      if (next === EXCLAMATION) {
        position = this.scanDeclaration(lt);
      } else if (next === QUESTION) {
        position = this.scanProcessingInstruction(lt);
      } else if (next === SLASH) {
        position = this.scanEndTag(lt);
      } else if (isNameStart(next)) {
        position = this.scanStartTag(lt);
        if (options.stopAfterFirstStartTag) {
          break;
        }
      } else {
        position = lt + 1;
      }
    }
    for (let depth = this.open.length - 1; depth >= 0; depth--) {
      this.closeImplicitly(this.open[depth], length);
    }
    this.open.length = 0;
    return { elements: this.elements, roots: this.roots, comments: this.comments, problems: this.problems };
  }

  private problem(code: XmlProblemCode, message: string, start: number, end: number): void {
    this.problems.push({ code, message, start, end });
  }

  private scanDeclaration(lt: number): number {
    const text = this.text;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) {
        this.comments.push({ start: lt, end: this.length });
        this.problem('unclosed-comment', 'Comment is not closed', lt, lt + 4);
        return this.length;
      }
      this.comments.push({ start: lt, end: close + 3 });
      return close + 3;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      if (close < 0) {
        this.problem('unclosed-cdata', 'CDATA section is not closed', lt, lt + 9);
        return this.length;
      }
      return close + 3;
    }
    let position = lt + 2;
    let brackets = 0;
    while (position < this.length) {
      const code = text.charCodeAt(position);
      if (code === LEFT_BRACKET) {
        brackets++;
      } else if (code === RIGHT_BRACKET) {
        brackets--;
      } else if (code === GT && brackets <= 0) {
        return position + 1;
      }
      position++;
    }
    this.problem('unclosed-declaration', 'Declaration is not closed', lt, lt + 2);
    return this.length;
  }

  private scanProcessingInstruction(lt: number): number {
    const close = this.text.indexOf('?>', lt + 2);
    if (close < 0) {
      this.problem('unclosed-processing-instruction', 'Processing instruction is not closed', lt, lt + 2);
      return this.length;
    }
    return close + 2;
  }

  private readName(start: number): number {
    let position = start;
    while (position < this.length && isNameChar(this.text.charCodeAt(position))) {
      position++;
    }
    return position;
  }

  private skipWhitespace(start: number): number {
    let position = start;
    while (position < this.length && isWhitespace(this.text.charCodeAt(position))) {
      position++;
    }
    return position;
  }

  private scanStartTag(lt: number): number {
    const text = this.text;
    const length = this.length;
    const nameStart = lt + 1;
    const nameEnd = this.readName(nameStart);
    const parent = this.open.length > 0 ? this.open[this.open.length - 1] : undefined;
    const siblings = parent ? parent.children : this.roots;
    const element: XmlElement = {
      name: text.slice(nameStart, nameEnd),
      start: lt,
      end: length,
      nameStart,
      nameEnd,
      startTagEnd: length,
      selfClosing: false,
      startTagClosed: false,
      parent,
      previous: siblings[siblings.length - 1],
      children: [],
      attributes: [],
      hierarchy: parent ? [parent.name, ...parent.hierarchy] : [],
      index: this.elements.length,
    };
    this.elements.push(element);
    siblings.push(element);

    let position = nameEnd;
    for (;;) {
      position = this.skipWhitespace(position);
      if (position >= length) {
        this.problem('unclosed-start-tag', `Start tag of '${element.name}' is not closed`, lt, nameEnd);
        break;
      }
      const code = text.charCodeAt(position);
      if (code === GT) {
        position++;
        element.startTagClosed = true;
        break;
      }
      if (code === SLASH && text.charCodeAt(position + 1) === GT) {
        position += 2;
        element.startTagClosed = true;
        element.selfClosing = true;
        break;
      }
      if (code === LT) {
        this.problem('unclosed-start-tag', `Start tag of '${element.name}' is not closed`, lt, nameEnd);
        break;
      }
      if (isNameStart(code)) {
        position = this.scanAttribute(element, position);
      } else {
        this.problem('unexpected-character', `Unexpected '${text[position]}' in the start tag of '${element.name}'`, position, position + 1);
        position++;
      }
    }
    element.startTagEnd = position;
    if (!element.startTagClosed) {
      // A cut-off start tag counts as an empty element, so the elements after it keep their places.
      element.selfClosing = true;
    }
    if (element.selfClosing) {
      element.end = position;
    } else {
      this.open.push(element);
    }
    return position;
  }

  private scanAttribute(element: XmlElement, nameStart: number): number {
    const text = this.text;
    const nameEnd = this.readName(nameStart);
    const name = text.slice(nameStart, nameEnd);
    const attribute: XmlAttribute = {
      name,
      value: '',
      rawValue: '',
      element,
      start: nameStart,
      end: nameEnd,
      nameStart,
      nameEnd,
      valueStart: nameEnd,
      valueEnd: nameEnd,
      quote: '',
      closed: false,
      references: [],
    };
    if (element.attributes.some((other) => other.name === name)) {
      this.problem('duplicate-attribute', `Attribute '${name}' appears more than once in '${element.name}'`, nameStart, nameEnd);
    }
    element.attributes.push(attribute);

    let position = this.skipWhitespace(nameEnd);
    if (text.charCodeAt(position) !== EQUALS) {
      this.problem('missing-attribute-value', `Attribute '${name}' has no value`, nameStart, nameEnd);
      return nameEnd;
    }
    position = this.skipWhitespace(position + 1);
    const code = text.charCodeAt(position);
    if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      attribute.quote = code === DOUBLE_QUOTE ? '"' : "'";
      attribute.valueStart = position + 1;
      const { end, closed } = this.findValueEnd(attribute.valueStart, code);
      attribute.valueEnd = end;
      attribute.closed = closed;
      attribute.end = closed ? end + 1 : end;
      if (!closed) {
        this.problem('unclosed-attribute', `Value of attribute '${name}' is not closed`, position, end);
      }
    } else if (
      position >= this.length ||
      code === GT ||
      code === LT ||
      (code === SLASH && text.charCodeAt(position + 1) === GT) ||
      this.looksLikeAttributeStart(position)
    ) {
      attribute.valueStart = position;
      attribute.valueEnd = position;
      attribute.end = position;
      this.problem('missing-attribute-value', `Attribute '${name}' has no value`, nameStart, position);
    } else {
      attribute.valueStart = position;
      while (position < this.length) {
        const current = text.charCodeAt(position);
        if (isWhitespace(current) || current === GT || current === LT || (current === SLASH && text.charCodeAt(position + 1) === GT)) {
          break;
        }
        position++;
      }
      attribute.valueEnd = position;
      attribute.end = position;
      attribute.closed = true;
      this.problem('unquoted-attribute-value', `Value of attribute '${name}' is not quoted`, attribute.valueStart, position);
    }
    attribute.rawValue = text.slice(attribute.valueStart, attribute.valueEnd);
    attribute.value = decodeAttributeValue(attribute.rawValue, attribute.references);
    return attribute.end;
  }

  /** True when `name =` starts at the position: an unquoted value never begins like the next attribute. */
  private looksLikeAttributeStart(position: number): boolean {
    if (!isNameStart(this.text.charCodeAt(position))) {
      return false;
    }
    const afterName = this.skipWhitespace(this.readName(position));
    return this.text.charCodeAt(afterName) === EQUALS;
  }

  /**
   * Finds the end of a quoted value. The closing quote is the next quote of the same kind, unless it is
   * preceded by what looks like the start of another attribute (`name="`) and what follows it cannot
   * follow a value: then the user forgot to close this value and it ends before that attribute. A `<`
   * never belongs to a value: it means the closing quote is missing too, and the value ends before the
   * `<`, or before a `>` that only whitespace separates from the `<`.
   */
  private findValueEnd(valueStart: number, quote: number): { end: number; closed: boolean } {
    const text = this.text;
    let position = valueStart;
    while (position < this.length) {
      const code = text.charCodeAt(position);
      if (code === quote) {
        // Only a value that ends with `=` can end with `name =`: most values need no regular expression.
        let last = position - 1;
        while (last >= valueStart && isWhitespace(text.charCodeAt(last))) {
          last--;
        }
        const match =
          last >= valueStart && text.charCodeAt(last) === EQUALS && !this.mayFollowValue(position + 1)
            ? attributeStartBeforeQuote.exec(text.slice(valueStart, position))
            : null;
        if (match) {
          return { end: valueStart + match.index, closed: false };
        }
        return { end: position, closed: true };
      }
      if (code === LT) {
        break;
      }
      position++;
    }
    return { end: this.cutValueBefore(valueStart, position), closed: false };
  }

  /**
   * True when what starts at the offset may follow a closed value in a start tag: the end of the tag, or
   * whitespace and the next attribute. A value written `comment="use faction= instead of otherobject="/>`
   * is closed then, though it ends like the start of another attribute.
   */
  private mayFollowValue(offset: number): boolean {
    const next = this.skipWhitespace(offset);
    const code = this.text.charCodeAt(next);
    return code === GT || (code === SLASH && this.text.charCodeAt(next + 1) === GT) || (next > offset && isNameStart(code));
  }

  /** End of an unclosed value that runs up to `limit`: before a trailing `>` or `/>`, and without trailing whitespace. */
  private cutValueBefore(valueStart: number, limit: number): number {
    const text = this.text;
    let end = limit;
    while (end > valueStart && isWhitespace(text.charCodeAt(end - 1))) {
      end--;
    }
    if (end > valueStart && text.charCodeAt(end - 1) === GT) {
      end--;
      if (end > valueStart && text.charCodeAt(end - 1) === SLASH) {
        end--;
      }
      while (end > valueStart && isWhitespace(text.charCodeAt(end - 1))) {
        end--;
      }
    }
    return end;
  }

  private scanEndTag(lt: number): number {
    const text = this.text;
    const nameStart = lt + 2;
    const nameEnd = this.readName(nameStart);
    const name = text.slice(nameStart, nameEnd);
    let position = this.skipWhitespace(nameEnd);
    let end: number;
    if (text.charCodeAt(position) === GT) {
      position++;
      end = position;
    } else {
      end = nameEnd;
      position = nameEnd;
      this.problem('unclosed-end-tag', `End tag of '${name}' is not closed`, lt, nameEnd);
    }
    let depth = this.open.length - 1;
    while (depth >= 0 && this.open[depth].name !== name) {
      depth--;
    }
    if (depth < 0) {
      this.problem('unexpected-end-tag', `End tag of '${name}' has no matching start tag`, lt, end);
      return position;
    }
    for (let above = this.open.length - 1; above > depth; above--) {
      this.closeImplicitly(this.open[above], lt);
    }
    const element = this.open[depth];
    element.end = end;
    element.endTag = { start: lt, end, nameStart, nameEnd };
    this.open.length = depth;
    return position;
  }

  private closeImplicitly(element: XmlElement, end: number): void {
    element.end = end;
    this.problem('missing-end-tag', `Element '${element.name}' has no end tag`, element.start, element.nameEnd);
  }
}

/** Scans an XML text into its element structure. Never throws. */
export function parseXml(text: string, options: ParseXmlOptions = {}): XmlStructure {
  return new Scanner(text).scan(options);
}

/** Index of the last element whose start tag begins at or before the offset, or -1. */
function lastElementStartingBy(elements: readonly XmlElement[], offset: number): number {
  let low = 0;
  let high = elements.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (elements[middle].start <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** True when a caret at the offset is inside the element: from `<` to the end of the end tag. */
export function elementContains(element: XmlElement, offset: number): boolean {
  if (offset < element.start) {
    return false;
  }
  if (offset < element.end) {
    return true;
  }
  // A caret at the very end of an element that was never closed is still inside it.
  return offset === element.end && !element.selfClosing && element.endTag === undefined;
}

/** True when a caret at the offset is inside the start tag of the element. */
export function startTagContains(element: XmlElement, offset: number): boolean {
  if (offset < element.start) {
    return false;
  }
  if (offset < element.startTagEnd) {
    return true;
  }
  return offset === element.startTagEnd && !element.startTagClosed;
}

/** The innermost element that contains the offset. */
export function elementAt(structure: XmlStructure, offset: number): XmlElement | undefined {
  const index = lastElementStartingBy(structure.elements, offset);
  let element = index >= 0 ? structure.elements[index] : undefined;
  while (element && !elementContains(element, offset)) {
    element = element.parent;
  }
  return element;
}

/** The element whose start tag contains the offset. */
export function elementWithStartTagAt(structure: XmlStructure, offset: number): XmlElement | undefined {
  const index = lastElementStartingBy(structure.elements, offset);
  if (index < 0) {
    return undefined;
  }
  const element = structure.elements[index];
  if (element.start === offset && index > 0) {
    // A start tag cut off by this `<` still owns the caret in front of it.
    const before = structure.elements[index - 1];
    if (!before.startTagClosed && before.startTagEnd === offset) {
      return before;
    }
  }
  return startTagContains(element, offset) ? element : undefined;
}

/** The attribute of the element whose name contains the caret. */
export function attributeWithNameAt(element: XmlElement, offset: number): XmlAttribute | undefined {
  return element.attributes.find((attribute) => offset >= attribute.nameStart && offset <= attribute.nameEnd);
}

/** The attribute of the element whose value (between the quotes) contains the caret. */
export function attributeWithValueAt(element: XmlElement, offset: number): XmlAttribute | undefined {
  return element.attributes.find((attribute) => attribute.quote !== '' && offset >= attribute.valueStart && offset <= attribute.valueEnd);
}

/** The attribute of the element with the given name, the first one when it is duplicated. */
export function attributeNamed(element: XmlElement, name: string): XmlAttribute | undefined {
  return element.attributes.find((attribute) => attribute.name === name);
}

/** Index of the first comment that ends after the offset. */
function firstCommentEndingAfter(comments: readonly XmlRegion[], offset: number): number {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (comments[middle].end <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * The text an element holds outside its child elements and comments, as stretches from their first
 * character that is not whitespace to their last. None for an element without an end tag: where its
 * content ends is not known. CDATA sections and processing instructions are not told apart from text.
 */
export function textRunsOf(element: XmlElement, text: string, comments: readonly XmlRegion[]): XmlRegion[] {
  if (!element.endTag) {
    return [];
  }
  const runs: XmlRegion[] = [];
  const addRun = (start: number, end: number): void => {
    let first = start;
    let last = end;
    while (first < last && isWhitespace(text.charCodeAt(first))) {
      first++;
    }
    while (last > first && isWhitespace(text.charCodeAt(last - 1))) {
      last--;
    }
    if (first < last) {
      runs.push({ start: first, end: last });
    }
  };
  const gap = (start: number, end: number): void => {
    let at = start;
    while (at < end && isWhitespace(text.charCodeAt(at))) {
      at++;
    }
    if (at === end) {
      return;
    }
    let from = start;
    for (let index = firstCommentEndingAfter(comments, start); index < comments.length && comments[index].start < end; index++) {
      addRun(from, comments[index].start);
      from = comments[index].end;
    }
    addRun(from, end);
  };
  let from = element.startTagEnd;
  for (const child of element.children) {
    gap(from, child.start);
    from = child.end;
  }
  gap(from, element.endTag.start);
  return runs;
}

/** True when the offset lies inside a comment. */
export function isInComment(structure: XmlStructure, offset: number): boolean {
  const comments = structure.comments;
  let low = 0;
  let high = comments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const comment = comments[middle];
    if (offset < comment.start) {
      high = middle - 1;
    } else if (offset >= comment.end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}
