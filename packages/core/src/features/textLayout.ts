/**
 * Where and how quick fixes write elements into a text: with the text's line breaks and indentation, on
 * lines of their own, and never next to an element that is not whole yet.
 */
import type { XmlElement } from '../xml/xmlStructure';
import type { XsdElement } from '../xsd/schema';

/** An edit of a text by offsets. */
export interface TextChange {
  start: number;
  end: number;
  text: string;
}

/** Lines of new elements, each with its depth below the first. */
export type Lines = [depth: number, text: string][];

export class Layout {
  readonly newline: string;

  constructor(readonly text: string) {
    this.newline = text.includes('\r\n') ? '\r\n' : '\n';
  }

  /** The offset where the line holding the offset starts. */
  lineStart(offset: number): number {
    return this.text.lastIndexOf('\n', offset - 1) + 1;
  }

  /** The offset after the line break that ends the line holding the offset, or the end of the text. */
  nextLineStart(offset: number): number {
    const end = this.text.indexOf('\n', offset);
    return end < 0 ? this.text.length : end + 1;
  }

  /** The whitespace before an element on its line; undefined when other text precedes it there. */
  indentOf(element: XmlElement): string | undefined {
    const before = this.text.slice(this.lineStart(element.start), element.start);
    return /^[ \t]*$/.test(before) ? before : undefined;
  }

  /** The element's lines, line break included, when nothing else shares them; undefined otherwise. */
  linesOf(element: XmlElement): { start: number; end: number } | undefined {
    const end = this.nextLineStart(element.end);
    if (this.indentOf(element) === undefined || !/^[ \t]*\r?\n?$/.test(this.text.slice(element.end, end))) {
      return undefined;
    }
    return { start: this.lineStart(element.start), end };
  }

  /**
   * One step of indentation, as the text indents a child from its parent nearest the element; else two
   * spaces, or a tab where the text indents with tabs.
   */
  unitNear(element: XmlElement): string {
    for (let current: XmlElement | undefined = element; current; current = current.parent) {
      const outer = this.indentOf(current);
      for (const child of current.children) {
        const inner = this.indentOf(child);
        if (outer !== undefined && inner !== undefined && inner.length > outer.length && inner.startsWith(outer)) {
          return inner.slice(outer.length);
        }
      }
    }
    return /^\t/m.test(this.text) ? '\t' : '  ';
  }

  render(lines: Lines, indent: string, unit: string): string {
    return lines.map(([depth, line]) => `${indent}${unit.repeat(depth)}${line}`).join(this.newline);
  }

  /** True when the element's text is whole: a closed self-closing tag, or a start tag with its end tag. */
  isWhole(element: XmlElement): boolean {
    return element.startTagClosed && (element.selfClosing || (element.endTag !== undefined && this.text[element.endTag.end - 1] === '>'));
  }

  /** On a line of its own after the element, at its indentation. */
  after(element: XmlElement, lines: Lines): TextChange | undefined {
    const indent = this.indentOf(element);
    if (indent === undefined || !this.isWhole(element)) {
      return undefined;
    }
    return { start: element.end, end: element.end, text: `${this.newline}${this.render(lines, indent, this.unitNear(element))}` };
  }

  /** As the first child of the element, one step deeper; a self-closing element gets an end tag. */
  firstChild(element: XmlElement, lines: Lines): TextChange | undefined {
    const indent = this.indentOf(element);
    if (indent === undefined || !this.isWhole(element)) {
      return undefined;
    }
    const unit = this.unitNear(element);
    const body = `${this.newline}${this.render(lines, indent + unit, unit)}`;
    if (element.selfClosing) {
      // `<actions/>` becomes `<actions>`, the new child, `</actions>`.
      return { start: element.startTagEnd - 2, end: element.startTagEnd, text: `>${body}${this.newline}${indent}</${element.name}>` };
    }
    return { start: element.startTagEnd, end: element.startTagEnd, text: body };
  }

  /** After the element's last child, or as its first when it has none. */
  lastChild(element: XmlElement, lines: Lines): TextChange | undefined {
    const last = element.children[element.children.length - 1];
    return last ? this.after(last, lines) : this.firstChild(element, lines);
  }

  /** A new child named `name` at the first place the element's content model allows it; first without a model. */
  child(element: XmlElement, declaration: XsdElement | undefined, name: string, lines: Lines): TextChange | undefined {
    const names = element.children.map((child) => child.name);
    const model = declaration?.contentModel;
    let at = 0;
    if (model) {
      const problems = model.validate(names).length;
      const fits = (index: number): boolean => model.validate([...names.slice(0, index), name, ...names.slice(index)]).length <= problems;
      at = [...names.keys(), names.length].find(fits) ?? 0;
    }
    return at === 0 ? this.firstChild(element, lines) : this.after(element.children[at - 1], lines);
  }
}
