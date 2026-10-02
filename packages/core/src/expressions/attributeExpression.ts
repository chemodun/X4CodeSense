import type { XmlAttribute, XmlElement, XmlStructure } from '../xml/xmlStructure';
import { parseExpression, type ParsedExpression } from './parser';

const parsedByAttribute = new WeakMap<XmlAttribute, ParsedExpression>();

/** The trees of one analysis with a `ParsedValueCache`, and those of the analysis before it. */
interface Generation {
  previous: ReadonlyMap<string, ParsedExpression>;
  current: Map<string, ParsedExpression>;
}

/** The generation of each root element of a structure analysed with a cache. */
const generationByRoot = new WeakMap<XmlElement, Generation>();

/**
 * The parsed value of an expression attribute. Each attribute of an analysis is parsed once and the tree
 * is shared by the expression checks, the variables and the named items; it lives as long as the
 * analysis that owns the attribute, or longer when a `ParsedValueCache` hands it on to the next one.
 * Callers must not change the tree.
 */
export function parsedValue(attribute: XmlAttribute): ParsedExpression {
  let parsed = parsedByAttribute.get(attribute);
  if (!parsed) {
    const value = attribute.value;
    const generation = generationOf(attribute.element);
    parsed = generation?.current.get(value) ?? generation?.previous.get(value) ?? parseExpression(value);
    generation?.current.set(value, parsed);
    parsedByAttribute.set(attribute, parsed);
  }
  return parsed;
}

function generationOf(element: XmlElement): Generation | undefined {
  let root = element;
  while (root.parent) {
    root = root.parent;
  }
  return generationByRoot.get(root);
}

/**
 * The parsed values of a document's previous analysis, kept for its next one: what an edit leaves as it
 * was is not parsed again, nor are its chains resolved again (`resolvedChainOf`) unless what they were
 * resolved with changed. A tree depends on its text alone and nothing changes one, so the trees are
 * taken by the decoded value. One per open document; see `AnalysisContext.expressionCache`.
 */
export interface ParsedValueCache {
  /** The trees of the latest analysis by value, also those the features parsed after it. */
  trees?: Map<string, ParsedExpression>;
  /** For a patch document: the cache of the target it is applied to, analysed within its analysis. */
  patched?: ParsedValueCache;
}

/**
 * Starts an analysis of `structure` with the cache: its attributes, when they are parsed, take the trees
 * the latest analysis had for the same values, and the trees of values it no longer has are let go after it.
 */
export function reuseParsedValues(structure: XmlStructure, cache: ParsedValueCache): void {
  const generation: Generation = { previous: cache.trees ?? new Map(), current: new Map() };
  cache.trees = generation.current;
  for (const root of structure.roots) {
    generationByRoot.set(root, generation);
  }
}
