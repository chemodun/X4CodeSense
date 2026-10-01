import { describe, expect, it } from 'vitest';
import {
  attributeNamed,
  attributeWithNameAt,
  attributeWithValueAt,
  decodeAttributeValue,
  elementAt,
  elementWithStartTagAt,
  isInComment,
  offsetInValue,
  parseXml,
  rangeInValue,
  type EntityReference,
  type XmlStructure,
} from '../src/xml/xmlStructure';

/** Byte order mark, built from its code so no editor or tool turns it into an invisible literal. */
const bom = String.fromCharCode(0xfeff);

function names(structure: XmlStructure): string[] {
  return structure.elements.map((element) => element.name);
}

function codes(structure: XmlStructure): string[] {
  return structure.problems.map((problem) => problem.code);
}

describe('parseXml on well formed input', () => {
  it('builds the tree with exact offsets', () => {
    const text = '<a x="1"><b/><c>t</c></a>';
    const structure = parseXml(text);
    expect(names(structure)).toEqual(['a', 'b', 'c']);
    expect(structure.problems).toEqual([]);
    const [a, b, c] = structure.elements;
    expect(structure.roots).toEqual([a]);
    expect(a.start).toBe(0);
    expect(a.nameStart).toBe(1);
    expect(a.nameEnd).toBe(2);
    expect(a.startTagEnd).toBe(9);
    expect(a.startTagClosed).toBe(true);
    expect(a.selfClosing).toBe(false);
    expect(a.end).toBe(text.length);
    const endTagStart = text.indexOf('</a>');
    expect(a.endTag).toEqual({ start: endTagStart, end: text.length, nameStart: endTagStart + 2, nameEnd: endTagStart + 3 });
    expect(a.children).toEqual([b, c]);
    expect(a.hierarchy).toEqual([]);
    expect(a.previous).toBeUndefined();

    expect(b.selfClosing).toBe(true);
    expect(b.start).toBe(9);
    expect(b.startTagEnd).toBe(13);
    expect(b.end).toBe(13);
    expect(b.parent).toBe(a);
    expect(b.previous).toBeUndefined();
    expect(b.hierarchy).toEqual(['a']);
    expect(b.index).toBe(1);

    expect(c.parent).toBe(a);
    expect(c.previous).toBe(b);
    expect(c.start).toBe(13);
    expect(c.startTagEnd).toBe(16);
    expect(c.end).toBe(21);
    expect(c.endTag?.start).toBe(17);
  });

  it('lists the hierarchy nearest ancestor first', () => {
    const structure = parseXml('<aiscript><attention><actions><do_if><debug_text/></do_if></actions></attention></aiscript>');
    const debugText = structure.elements[4];
    expect(debugText.name).toBe('debug_text');
    expect(debugText.hierarchy).toEqual(['do_if', 'actions', 'attention', 'aiscript']);
  });

  it('reads attributes with double quotes, single quotes, spaces around = and line breaks in values', () => {
    const text = `<move_to object="$ship" relativemovement='true' chance = "50"\n  text="line one\n    line two"/>`;
    const structure = parseXml(text);
    expect(structure.problems).toEqual([]);
    const element = structure.elements[0];
    expect(element.selfClosing).toBe(true);
    expect(element.attributes.map((attribute) => [attribute.name, attribute.value, attribute.quote])).toEqual([
      ['object', '$ship', '"'],
      ['relativemovement', 'true', "'"],
      ['chance', '50', '"'],
      ['text', 'line one\n    line two', '"'],
    ]);
    const single = element.attributes[1];
    expect(text.slice(single.valueStart, single.valueEnd)).toBe('true');
    expect(text.slice(single.start, single.end)).toBe("relativemovement='true'");
    expect(text.slice(single.nameStart, single.nameEnd)).toBe('relativemovement');
    expect(single.closed).toBe(true);
    expect(single.element).toBe(element);
    const chance = element.attributes[2];
    expect(text.slice(chance.start, chance.end)).toBe('chance = "50"');
    expect(text.slice(chance.valueStart, chance.valueEnd)).toBe('50');
  });

  it('decodes references and maps decoded positions back to the text', () => {
    const text = `<debug_text text="'&lt;%1&gt; a &amp; b' &#65;&#x42;"/>`;
    const structure = parseXml(text);
    const attribute = structure.elements[0].attributes[0];
    expect(attribute.value).toBe("'<%1> a & b' AB");
    expect(attribute.rawValue).toBe("'&lt;%1&gt; a &amp; b' &#65;&#x42;");
    expect(attribute.references.length).toBe(5);
    expect(offsetInValue(attribute, 0)).toBe(attribute.valueStart);
    // The `<` came from `&lt;` and maps to its `&`.
    expect(offsetInValue(attribute, 1)).toBe(attribute.valueStart + 1);
    // `%` follows the four characters of `&lt;`.
    expect(offsetInValue(attribute, 2)).toBe(attribute.valueStart + 5);
    expect(text[offsetInValue(attribute, 2)]).toBe('%');
    expect(text[offsetInValue(attribute, attribute.value.indexOf('a '))]).toBe('a');
    expect(text.slice(offsetInValue(attribute, attribute.value.indexOf('&')), offsetInValue(attribute, attribute.value.indexOf('&')) + 5)).toBe('&amp;');
    expect(text.slice(offsetInValue(attribute, attribute.value.length - 2), offsetInValue(attribute, attribute.value.length))).toBe('&#65;&#x42;');
    const range = rangeInValue(attribute, attribute.value.indexOf('%1'), attribute.value.indexOf('%1') + 2);
    expect(text.slice(range.start, range.end)).toBe('%1');
  });

  it('leaves unknown and malformed references as written', () => {
    const references: EntityReference[] = [];
    expect(decodeAttributeValue('a &unknown; b &amp c & d &#; &#xZZ; &#1114112; &lt;', references)).toBe('a &unknown; b &amp c & d &#; &#xZZ; &#1114112; <');
    expect(references.length).toBe(1);
    expect(decodeAttributeValue('&#128512;', references)).toBe('\u{1F600}');
    expect(references[1]).toEqual({ rawStart: 0, rawLength: 9, decodedStart: 0, decodedLength: 2 });
  });

  it('keeps the case of names', () => {
    const structure = parseXml('<mdscript xsi:noNamespaceSchemaLocation="md.xsd"><Cues/></mdscript>');
    expect(names(structure)).toEqual(['mdscript', 'Cues']);
    expect(structure.elements[0].attributes[0].name).toBe('xsi:noNamespaceSchemaLocation');
  });

  it('skips a BOM, the prolog, a doctype, comments with markup inside, CDATA and processing instructions', () => {
    const text = bom + '<?xml version="1.0"?>\n<!DOCTYPE x [<!ENTITY y "z">]>\n<!-- <not/> a="b" -->\n<a><![CDATA[<b/>]]><?pi x?><!----></a>';
    const structure = parseXml(text);
    expect(names(structure)).toEqual(['a']);
    expect(structure.problems).toEqual([]);
    expect(structure.comments.length).toBe(2);
    const comment = structure.comments[0];
    expect(text.slice(comment.start, comment.end)).toBe('<!-- <not/> a="b" -->');
    expect(isInComment(structure, comment.start)).toBe(true);
    expect(isInComment(structure, comment.end - 1)).toBe(true);
    expect(isInComment(structure, comment.end)).toBe(false);
    expect(isInComment(structure, text.indexOf('<a>'))).toBe(false);
  });

  it('reads a root without children and content between tags', () => {
    const structure = parseXml('<a>\n  some text & more\n</a>');
    expect(names(structure)).toEqual(['a']);
    expect(structure.problems).toEqual([]);
  });
});

describe('parseXml on broken input', () => {
  it('cuts a start tag at the next < and treats it as an empty element', () => {
    const text = '<a>\n  <b x="1"\n  <c/>\n</a>';
    const structure = parseXml(text);
    expect(names(structure)).toEqual(['a', 'b', 'c']);
    expect(codes(structure)).toEqual(['unclosed-start-tag']);
    const [a, b, c] = structure.elements;
    expect(b.startTagClosed).toBe(false);
    expect(b.selfClosing).toBe(true);
    expect(b.startTagEnd).toBe(text.indexOf('<c/>'));
    expect(b.end).toBe(b.startTagEnd);
    expect(b.attributes[0].value).toBe('1');
    expect(c.parent).toBe(a);
    expect(c.previous).toBe(b);
    expect(a.endTag).toBeDefined();
  });

  it('ends an unclosed value where the next attribute starts', () => {
    const text = '<a name="$x exact="1"/>';
    const structure = parseXml(text);
    expect(codes(structure)).toEqual(['unclosed-attribute']);
    const element = structure.elements[0];
    expect(element.attributes.map((attribute) => [attribute.name, attribute.value, attribute.closed])).toEqual([
      ['name', '$x', false],
      ['exact', '1', true],
    ]);
    expect(element.selfClosing).toBe(true);
    expect(element.startTagClosed).toBe(true);
    const name = element.attributes[0];
    expect(text.slice(name.valueStart, name.valueEnd)).toBe('$x');
    expect(name.end).toBe(name.valueEnd);
  });

  it('keeps a value closed that only ends like the next attribute, when the tag goes on as it may after a value', () => {
    // As in the game's gs_pirate1.xml (9.00): the comment ends with `otherobject=`.
    const vanilla = '<a object="$ship" comment="use faction= instead of otherobject="/>\n<b/>';
    expect(codes(parseXml(vanilla))).toEqual([]);
    expect(parseXml(vanilla).elements[0].attributes.map((attribute) => [attribute.name, attribute.value])).toEqual([
      ['object', '$ship'],
      ['comment', 'use faction= instead of otherobject='],
    ]);
    expect(codes(parseXml('<a comment="x y=">text</a>'))).toEqual([]);
    expect(parseXml('<a comment="x y=" z="1"/>').elements[0].attributes.map((attribute) => attribute.name)).toEqual(['comment', 'z']);
    // While typing, the next attribute's value, a tag or the end of the text follow: the value is not closed.
    expect(codes(parseXml('<a name="$x exact="$y"/>'))).toEqual(['unclosed-attribute']);
    expect(codes(parseXml('<a name="$x exact="\n<b/>'))).toEqual(['unclosed-attribute', 'unclosed-attribute', 'unclosed-start-tag']);
    expect(parseXml('<a name="$x exact="').elements[0].attributes.map((attribute) => [attribute.name, attribute.value])).toEqual([
      ['name', '$x'],
      ['exact', ''],
    ]);
  });

  it('ends an unclosed value before the /> of its own tag', () => {
    const text = '<a name="$x/>\n<b/>';
    const structure = parseXml(text);
    expect(codes(structure)).toEqual(['unclosed-attribute']);
    expect(names(structure)).toEqual(['a', 'b']);
    const [a, b] = structure.elements;
    expect(a.attributes[0].value).toBe('$x');
    expect(a.selfClosing).toBe(true);
    expect(a.startTagClosed).toBe(true);
    expect(structure.roots).toEqual([a, b]);
    expect(b.previous).toBe(a);
  });

  it('ends an unclosed value before the next tag', () => {
    const text = '<a name="$x  \n  <b/>';
    const structure = parseXml(text);
    expect(codes(structure)).toEqual(['unclosed-attribute', 'unclosed-start-tag']);
    const a = structure.elements[0];
    expect(a.attributes[0].value).toBe('$x');
    expect(a.startTagEnd).toBe(text.indexOf('<b/>'));
  });

  it('ends an unclosed value at the end of the text', () => {
    const structure = parseXml('<a name="$x');
    expect(codes(structure)).toEqual(['unclosed-attribute', 'unclosed-start-tag']);
    const a = structure.elements[0];
    expect(a.attributes[0].value).toBe('$x');
    expect(a.attributes[0].closed).toBe(false);
    expect(a.startTagClosed).toBe(false);
    expect(a.end).toBe(11);
  });

  it('keeps a legitimate = inside a value', () => {
    const text = `<set_value name="$t" exact="table[$a = 1, $b = 'x=y']" chance="$c == 'sel=' "/>`;
    const structure = parseXml(text);
    expect(structure.problems).toEqual([]);
    expect(structure.elements[0].attributes.map((attribute) => attribute.value)).toEqual(['$t', "table[$a = 1, $b = 'x=y']", "$c == 'sel=' "]);
  });

  it('reports attributes without a value and unquoted values', () => {
    const text = '<a checked x=1 y= z=/>';
    const structure = parseXml(text);
    expect(codes(structure)).toEqual(['missing-attribute-value', 'unquoted-attribute-value', 'missing-attribute-value', 'missing-attribute-value']);
    const element = structure.elements[0];
    expect(element.attributes.map((attribute) => [attribute.name, attribute.value, attribute.quote])).toEqual([
      ['checked', '', ''],
      ['x', '1', ''],
      ['y', '', ''],
      ['z', '', ''],
    ]);
    expect(element.selfClosing).toBe(true);
    expect(element.startTagClosed).toBe(true);
  });

  it('reports duplicate attributes and keeps both', () => {
    const structure = parseXml('<a x="1" x="2"/>');
    expect(codes(structure)).toEqual(['duplicate-attribute']);
    expect(structure.elements[0].attributes.length).toBe(2);
    expect(attributeNamed(structure.elements[0], 'x')?.value).toBe('1');
  });

  it('closes an element without end tag at the end tag of its parent', () => {
    const text = '<a><b><c/></a>';
    const structure = parseXml(text);
    expect(codes(structure)).toEqual(['missing-end-tag']);
    const [a, b, c] = structure.elements;
    expect(b.end).toBe(text.indexOf('</a>'));
    expect(b.endTag).toBeUndefined();
    expect(c.parent).toBe(b);
    expect(a.endTag).toBeDefined();
    expect(a.end).toBe(text.length);
  });

  it('closes elements without end tag at the end of the text, innermost first', () => {
    const text = '<a><b>';
    const structure = parseXml(text);
    expect(structure.problems.map((problem) => [problem.code, problem.start])).toEqual([
      ['missing-end-tag', 3],
      ['missing-end-tag', 0],
    ]);
    expect(structure.elements.map((element) => element.end)).toEqual([6, 6]);
  });

  it('reports an end tag without start tag and keeps going', () => {
    const structure = parseXml('<a></b><c/></a>');
    expect(codes(structure)).toEqual(['unexpected-end-tag']);
    expect(names(structure)).toEqual(['a', 'c']);
    expect(structure.elements[0].endTag).toBeDefined();
    expect(structure.elements[1].parent).toBe(structure.elements[0]);
  });

  it('reports an end tag cut off by the next tag', () => {
    const text = '<a></a <b/>';
    const structure = parseXml(text);
    expect(codes(structure)).toEqual(['unclosed-end-tag']);
    const [a, b] = structure.elements;
    expect(a.end).toBe(6);
    expect(a.endTag?.end).toBe(6);
    expect(b.parent).toBeUndefined();
  });

  it('lets an unclosed comment swallow the rest', () => {
    const structure = parseXml('<a><!-- x <b/>');
    expect(names(structure)).toEqual(['a']);
    expect(codes(structure)).toEqual(['unclosed-comment', 'missing-end-tag']);
    expect(isInComment(structure, 10)).toBe(true);
  });

  it('skips unexpected characters in a start tag', () => {
    const structure = parseXml('<a " x="1" / y="2"/>');
    expect(codes(structure)).toEqual(['unexpected-character', 'unexpected-character']);
    expect(structure.elements[0].attributes.map((attribute) => attribute.name)).toEqual(['x', 'y']);
    expect(structure.elements[0].selfClosing).toBe(true);
  });

  it('ignores a < that does not start markup', () => {
    const structure = parseXml('<a> 1 < 2 </a>');
    expect(names(structure)).toEqual(['a']);
    expect(structure.problems).toEqual([]);
  });

  it('never throws on fragments', () => {
    const fragments = [
      '',
      '<',
      '<<',
      '</',
      '</>',
      '<a',
      '<a ',
      '<a x',
      '<a x=',
      '<a x="',
      "<a x='",
      '<a/',
      '<!',
      '<!-',
      '<!--',
      '<?',
      '<?x',
      '<![CDATA[',
      '"',
      '&',
      '<a/><',
      '<a></a',
      '<a></',
      '<a>&lt;',
      bom,
    ];
    for (const fragment of fragments) {
      expect(() => parseXml(fragment)).not.toThrow();
    }
  });
});

describe('queries', () => {
  const text = '<a>\n  <b x="12" y=\'3\'>\n    <c/>\n  </b>\n</a>';
  const structure = parseXml(text);
  const [a, b, c] = structure.elements;

  it('elementAt returns the innermost element containing the caret', () => {
    expect(elementAt(structure, 0)).toBe(a);
    expect(elementAt(structure, 3)).toBe(a);
    expect(elementAt(structure, text.indexOf('<b'))).toBe(b);
    expect(elementAt(structure, text.indexOf('<c'))).toBe(c);
    expect(elementAt(structure, text.indexOf('<c') + 3)).toBe(c);
    expect(elementAt(structure, text.indexOf('<c') + 4)).toBe(b);
    expect(elementAt(structure, text.indexOf('</b>'))).toBe(b);
    expect(elementAt(structure, text.indexOf('</b>') + 4)).toBe(a);
    expect(elementAt(structure, text.length - 1)).toBe(a);
    expect(elementAt(structure, text.length)).toBeUndefined();
    expect(elementAt(parseXml(''), 0)).toBeUndefined();
  });

  it('elementAt treats the end of an unclosed element as inside', () => {
    const unclosed = parseXml('<a><b>');
    expect(elementAt(unclosed, 6)?.name).toBe('b');
    const selfClosing = parseXml('<a/>');
    expect(elementAt(selfClosing, 4)).toBeUndefined();
  });

  it('elementWithStartTagAt finds the start tag under the caret', () => {
    expect(elementWithStartTagAt(structure, text.indexOf('<b'))).toBe(b);
    expect(elementWithStartTagAt(structure, text.indexOf('x='))).toBe(b);
    expect(elementWithStartTagAt(structure, b.startTagEnd - 1)).toBe(b);
    expect(elementWithStartTagAt(structure, b.startTagEnd)).toBeUndefined();
    expect(elementWithStartTagAt(structure, text.indexOf('<c'))).toBe(c);
    expect(elementWithStartTagAt(structure, text.indexOf('\n    <c'))).toBeUndefined();
    expect(elementWithStartTagAt(structure, text.indexOf('</b>') + 1)).toBeUndefined();
  });

  it('elementWithStartTagAt prefers a cut-off start tag over the tag that cut it', () => {
    const cut = parseXml('<a x="1" <b/>');
    expect(elementWithStartTagAt(cut, cut.elements[1].start)?.name).toBe('a');
    expect(elementWithStartTagAt(cut, cut.elements[1].start + 1)?.name).toBe('b');
    const atEnd = parseXml('<a x="1" ');
    expect(elementWithStartTagAt(atEnd, 9)?.name).toBe('a');
  });

  it('attribute queries use caret semantics', () => {
    const xStart = text.indexOf('x=');
    const valueStart = text.indexOf('12');
    expect(attributeWithNameAt(b, xStart)?.name).toBe('x');
    expect(attributeWithNameAt(b, xStart + 1)?.name).toBe('x');
    expect(attributeWithNameAt(b, xStart + 2)).toBeUndefined();
    expect(attributeWithValueAt(b, valueStart - 1)).toBeUndefined();
    expect(attributeWithValueAt(b, valueStart)?.name).toBe('x');
    expect(attributeWithValueAt(b, valueStart + 2)?.name).toBe('x');
    expect(attributeWithValueAt(b, valueStart + 3)).toBeUndefined();
    expect(attributeNamed(b, 'y')?.value).toBe('3');
    expect(attributeNamed(b, 'z')).toBeUndefined();
    expect(attributeWithValueAt(parseXml('<a x/>').elements[0], 3)).toBeUndefined();
  });
});

describe('stopAfterFirstStartTag', () => {
  it('stops after the root start tag', () => {
    const structure = parseXml('<?xml version="1.0"?><!-- c --><mdscript name="X"><cues/></mdscript>', { stopAfterFirstStartTag: true });
    expect(names(structure)).toEqual(['mdscript']);
    expect(structure.elements[0].startTagClosed).toBe(true);
    expect(attributeNamed(structure.elements[0], 'name')?.value).toBe('X');
  });
});
