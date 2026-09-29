import type { XmlAttribute } from '../xml/xmlStructure';
import { parseExpression, type ParsedExpression } from './parser';

const parsedByAttribute = new WeakMap<XmlAttribute, ParsedExpression>();

/**
 * The parsed value of an expression attribute. Each attribute of an analysis is parsed once and the tree
 * is shared by the expression checks, the variables and the named items; it lives as long as the
 * analysis that owns the attribute. Callers must not change the tree.
 */
export function parsedValue(attribute: XmlAttribute): ParsedExpression {
  let parsed = parsedByAttribute.get(attribute);
  if (!parsed) {
    parsed = parseExpression(attribute.value);
    parsedByAttribute.set(attribute, parsed);
  }
  return parsed;
}
