import type { GameData } from '../gameData';
import {
  attributeWithNameAt,
  attributeWithValueAt,
  elementAt,
  elementWithStartTagAt,
  indexInValue,
  isInComment,
  type XmlAttribute,
  type XmlElement,
} from '../xml/xmlStructure';
import type { XsdAttribute, XsdElement, XsdSchema } from '../xsd/schema';
import type { DocumentAnalysis } from './analyzeDocument';

/** What surrounds a caret in a script document. */
export type PositionContext =
  | { kind: 'none' }
  /** On the name of a start tag, or right after a `<` that has no name yet. */
  | {
      kind: 'element-name';
      element?: XmlElement;
      declaration?: XsdElement;
      parent?: XmlElement;
      parentDeclaration?: XsdElement;
      prefix: string;
      nameStart: number;
      nameEnd: number;
    }
  /** On the name of an end tag. */
  | { kind: 'end-tag-name'; element: XmlElement; declaration?: XsdElement }
  /** On an attribute name. */
  | { kind: 'attribute-name'; element: XmlElement; declaration?: XsdElement; attribute: XmlAttribute; prefix: string }
  /** Inside a start tag, on whitespace between attributes. */
  | { kind: 'start-tag'; element: XmlElement; declaration?: XsdElement }
  /** Between the quotes of an attribute value, or in the whitespace after a value whose closing quote is still missing. */
  | {
      kind: 'attribute-value';
      element: XmlElement;
      declaration?: XsdElement;
      attribute: XmlAttribute;
      declared?: XsdAttribute;
      /** The decoded value, extended by the whitespace the caret sits in after an unclosed value. */
      expression: string;
      /** Caret index into `expression`. */
      index: number;
    }
  /** In the content of an element. */
  | { kind: 'content'; element: XmlElement; declaration?: XsdElement };

const LT = 0x3c;

/** The schema of the document's script kind, when game data is available. */
export function schemaOf(game: GameData | undefined, analysis: DocumentAnalysis): XsdSchema | undefined {
  const kind = analysis.detection.script?.schema;
  return kind && game ? game.schemas.schemas[kind] : undefined;
}

/**
 * The declaration of an element: the one resolved through its parent, or, while the structure around it
 * is broken, any declaration of that name in the schema.
 */
export function declarationOf(analysis: DocumentAnalysis, element: XmlElement, schema: XsdSchema | undefined): XsdElement | undefined {
  return analysis.declarations.get(element) ?? schema?.anyDeclaration(element.name);
}

/** Classifies a caret offset in an analysed script document. */
export function positionContext(analysis: DocumentAnalysis, offset: number, schema?: XsdSchema): PositionContext {
  const structure = analysis.structure;
  if (!structure) {
    return { kind: 'none' };
  }
  if (isInComment(structure, offset)) {
    return { kind: 'none' };
  }
  const text = analysis.document.getText();
  const element = elementWithStartTagAt(structure, offset);
  if (element) {
    const declaration = declarationOf(analysis, element, schema);
    if (offset >= element.nameStart && offset <= element.nameEnd) {
      return {
        kind: 'element-name',
        element,
        declaration,
        parent: element.parent,
        parentDeclaration: element.parent && declarationOf(analysis, element.parent, schema),
        prefix: text.slice(element.nameStart, offset),
        nameStart: element.nameStart,
        nameEnd: element.nameEnd,
      };
    }
    const attribute = attributeWithNameAt(element, offset);
    if (attribute) {
      return { kind: 'attribute-name', element, declaration, attribute, prefix: text.slice(attribute.nameStart, offset) };
    }
    const valued = attributeWithValueAt(element, offset) ?? unclosedValueBefore(element, offset, text);
    if (valued) {
      const index = indexInValue(valued, Math.min(offset, valued.valueEnd)) + Math.max(0, offset - valued.valueEnd);
      return {
        kind: 'attribute-value',
        element,
        declaration,
        attribute: valued,
        declared: declaration?.attributes.get(valued.name),
        expression: valued.value + ' '.repeat(Math.max(0, offset - valued.valueEnd)),
        index,
      };
    }
    // Between attributes, but not inside `name=` before the quote or on the closing `>`.
    const before = text.charCodeAt(offset - 1);
    if (before === 0x3d || (offset === element.startTagEnd && element.startTagClosed)) {
      return { kind: 'none' };
    }
    return { kind: 'start-tag', element, declaration };
  }
  // Right after a bare `<`: a start tag with no name yet.
  if (text.charCodeAt(offset - 1) === LT) {
    const parent = elementAt(structure, offset - 1);
    return {
      kind: 'element-name',
      parent,
      parentDeclaration: parent && declarationOf(analysis, parent, schema),
      prefix: '',
      nameStart: offset,
      nameEnd: offset,
    };
  }
  const container = elementAt(structure, offset);
  if (!container) {
    return { kind: 'none' };
  }
  const declaration = declarationOf(analysis, container, schema);
  const endTag = container.endTag;
  if (endTag && offset >= endTag.nameStart && offset <= endTag.nameEnd) {
    return { kind: 'end-tag-name', element: container, declaration };
  }
  return { kind: 'content', element: container, declaration };
}

/**
 * The last attribute of the element when its closing quote is missing and only whitespace lies between
 * the end of its value and the caret: the user is still typing the value.
 */
function unclosedValueBefore(element: XmlElement, offset: number, text: string): XmlAttribute | undefined {
  const last = element.attributes[element.attributes.length - 1];
  if (!last || last.closed || last.quote === '' || offset < last.valueEnd) {
    return undefined;
  }
  return text.slice(last.valueEnd, offset).trim() === '' ? last : undefined;
}
