/**
 * Narrowing after a class test. `P.isclass.C`, `P.isrealclass.C` and `P.isclass.{class.C}`, where P is a
 * chain of names (`$x`, `player.target`, `event.param`) and C a class with a datatype of its name, tell
 * that P is a C where the test holds: further in the same expression (right of `and`, right of `or` after
 * a negated test, in `then`), in the body of `do_if`, `do_elseif` and `do_while`, and in the actions of a
 * cue or handler whose conditions `check_value` it. A variable's facts end where it is set or removed again.
 */
import type { ScriptDatatype, ScriptProperties } from '../properties/scriptProperties';
import type { ScriptSchema } from '../types';
import type { DocumentVariables } from '../variables/variables';
import { offsetInValue, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';
import { parsedValue } from './attributeExpression';
import { isChainNode, stepsOf } from './astChain';
import type { Expression } from './parser';
import type { ChainStep, StepTypes } from './propertyChain';

/** What a class test tells, within the value it is written in. */
interface ValueFact {
  /** The chain the test names, its steps joined by dots: `player.target`, `$x`. */
  key: string;
  datatype: ScriptDatatype;
  /** The test as written, `isclass.npc`. */
  test: string;
  /** Offset of the test in the value. */
  offset: number;
}

/** A class test that holds where a chain is written, and where it is. */
export interface ClassFact extends Omit<ValueFact, 'offset'> {
  attribute: XmlAttribute;
  /** Offset of the test in the attribute's value. */
  offset: number;
}

/** The facts of a value that hold within a range of it. */
interface FactRange {
  start: number;
  end: number;
  facts: ValueFact[];
}

const testNames: ReadonlySet<string> = new Set(['isclass', 'isrealclass']);
/** A value without this text holds no class test: most do not, and are not walked. */
const mayTest = /is(real)?class/;
const noFacts: ClassFact[] = [];
const noRanges: FactRange[] = [];
const conditionals: ReadonlySet<string> = new Set(['do_if', 'do_elseif', 'do_while']);

/** The datatype of a class name: a class the `class` lookup has, of the name of a datatype. */
function classDatatype(name: string, properties: ScriptProperties, schema: ScriptSchema): ScriptDatatype | undefined {
  const classes = properties.keyword('class', schema);
  return classes?.properties.has(name) ? properties.datatype(name) : undefined;
}

/** The nearest datatype all of them are, if any. */
function sharedDatatype(datatypes: readonly ScriptDatatype[]): ScriptDatatype | undefined {
  const [first, ...others] = datatypes;
  if (!first) {
    return undefined;
  }
  for (const candidate of first.chain()) {
    if (others.every((other) => [...other.chain()].includes(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

/** The class a braced key names: `class.ship`, or the datatype all classes of a list share. */
function keyDatatype(key: Expression, properties: ScriptProperties, schema: ScriptSchema): ScriptDatatype | undefined {
  if (key.kind === 'group') {
    return keyDatatype(key.expression, properties, schema);
  }
  if (key.kind === 'property' && key.object.kind === 'name' && key.object.name === 'class') {
    return classDatatype(key.name, properties, schema);
  }
  if (key.kind === 'list' && key.items.length > 0) {
    const datatypes = key.items.map((item) => keyDatatype(item, properties, schema));
    return datatypes.every((datatype) => datatype !== undefined) ? sharedDatatype(datatypes as ScriptDatatype[]) : undefined;
  }
  return undefined;
}

/** The fact of a chain node that is a class test of a chain of names, if it is one. */
function classTest(node: Expression, text: string, properties: ScriptProperties, schema: ScriptSchema): ValueFact | undefined {
  if (node.kind !== 'property' && node.kind !== 'dynamic') {
    return undefined;
  }
  const test = node.object;
  if (test.kind !== 'property' || !testNames.has(test.name)) {
    return undefined;
  }
  const datatype = node.kind === 'property' ? classDatatype(node.name, properties, schema) : keyDatatype(node.key, properties, schema);
  const subject = test.object;
  if (!datatype || (!isChainNode(subject) && subject.kind !== 'variable')) {
    return undefined;
  }
  const { steps } = stepsOf(subject, text);
  if (steps.some((step) => step.kind !== 'identifier' && step.kind !== 'variable')) {
    return undefined;
  }
  return { key: keyOf(steps, steps.length - 1), datatype, test: text.slice(test.nameStart, node.end), offset: test.nameStart };
}

/** The facts that hold when the expression is true. */
function factsWhenTrue(node: Expression, text: string, properties: ScriptProperties, schema: ScriptSchema): ValueFact[] {
  switch (node.kind) {
    case 'group':
      return factsWhenTrue(node.expression, text, properties, schema);
    case 'unary':
      return node.operator === '@' ? factsWhenTrue(node.operand, text, properties, schema) : [];
    case 'binary':
      return node.operator === 'and' ? [...factsWhenTrue(node.left, text, properties, schema), ...factsWhenTrue(node.right, text, properties, schema)] : [];
    default: {
      const fact = classTest(node, text, properties, schema);
      return fact ? [fact] : [];
    }
  }
}

/** The facts that hold when the expression is false. */
function factsWhenFalse(node: Expression, text: string, properties: ScriptProperties, schema: ScriptSchema): ValueFact[] {
  switch (node.kind) {
    case 'group':
      return factsWhenFalse(node.expression, text, properties, schema);
    case 'unary':
      return node.operator === 'not' ? factsWhenTrue(node.operand, text, properties, schema) : [];
    case 'binary':
      return node.operator === 'or' ? [...factsWhenFalse(node.left, text, properties, schema), ...factsWhenFalse(node.right, text, properties, schema)] : [];
    default:
      return [];
  }
}

/** The direct subexpressions of a node. */
function childrenOf(node: Expression): Expression[] {
  switch (node.kind) {
    case 'textref':
      return [node.page, node.id];
    case 'list':
      return node.items;
    case 'table':
      return node.entries.flatMap((entry) => [entry.key, entry.value]);
    case 'property':
      return [node.object];
    case 'dynamic':
      return [node.object, node.key];
    case 'args':
      return [node.object, ...node.args];
    case 'call':
      return node.args;
    case 'unary':
    case 'exists':
    case 'cast':
      return [node.operand];
    case 'group':
      return [node.expression];
    case 'binary':
      return [node.left, node.right];
    case 'conditional':
      return node.else ? [node.condition, node.then, node.else] : [node.condition, node.then];
    default:
      return [];
  }
}

interface RangesMemo {
  properties: ScriptProperties;
  schema: ScriptSchema;
  ranges: FactRange[];
}

const rangesByTree = new WeakMap<Expression, RangesMemo>();

/** Where the class tests of a value hold within it, outer ranges first. Trees are shared by value, and so is this. */
function rangesOf(tree: Expression, text: string, properties: ScriptProperties, schema: ScriptSchema): FactRange[] {
  if (!mayTest.test(text)) {
    return noRanges;
  }
  const known = rangesByTree.get(tree);
  if (known && known.properties === properties && known.schema === schema) {
    return known.ranges;
  }
  const ranges: FactRange[] = [];
  const holdIn = (node: Expression, facts: ValueFact[]): void => {
    if (facts.length > 0) {
      ranges.push({ start: node.start, end: node.end, facts });
    }
  };
  const visit = (node: Expression): void => {
    if (node.kind === 'binary' && (node.operator === 'and' || node.operator === 'or')) {
      visit(node.left);
      const facts = node.operator === 'and' ? factsWhenTrue(node.left, text, properties, schema) : factsWhenFalse(node.left, text, properties, schema);
      holdIn(node.right, facts);
      visit(node.right);
      return;
    }
    if (node.kind === 'conditional') {
      visit(node.condition);
      holdIn(node.then, factsWhenTrue(node.condition, text, properties, schema));
      visit(node.then);
      if (node.else) {
        holdIn(node.else, factsWhenFalse(node.condition, text, properties, schema));
        visit(node.else);
      }
      return;
    }
    for (const child of childrenOf(node)) {
      visit(child);
    }
  };
  visit(tree);
  rangesByTree.set(tree, { properties, schema, ranges });
  return ranges;
}

/** The facts of a condition value as a whole, true. */
function conditionFacts(attribute: XmlAttribute | undefined, properties: ScriptProperties, schema: ScriptSchema): ClassFact[] {
  if (!attribute || !mayTest.test(attribute.value)) {
    return noFacts;
  }
  return factsWhenTrue(parsedValue(attribute).expression, attribute.value, properties, schema).map((fact) => ({ ...fact, attribute }));
}

function attributeOf(element: XmlElement, name: string): XmlAttribute | undefined {
  return element.attributes.find((attribute) => attribute.name === name);
}

interface ElementMemo {
  properties: ScriptProperties;
  schema: ScriptSchema;
  facts: ClassFact[];
}

const factsByElement = new WeakMap<XmlElement, ElementMemo>();

/**
 * The facts the elements around an element give it, outer ones first: the conditions of the `do_if`,
 * `do_elseif` and `do_while` it is in, and the `check_value` conditions of the cue or handler whose actions
 * it is in. Its own attributes are not in the body of its own condition.
 */
function enclosingFacts(element: XmlElement, properties: ScriptProperties, schema: ScriptSchema): ClassFact[] {
  const known = factsByElement.get(element);
  if (known && known.properties === properties && known.schema === schema) {
    return known.facts;
  }
  const parent = element.parent;
  const inherited = parent ? enclosingFacts(parent, properties, schema) : noFacts;
  const own: ClassFact[] = [];
  if (parent && conditionals.has(parent.name)) {
    own.push(...conditionFacts(attributeOf(parent, 'value'), properties, schema));
  }
  if (parent && element.name === 'actions') {
    const conditions = parent.children.find((child) => child.name === 'conditions');
    for (const check of conditions?.children ?? []) {
      if (check.name === 'check_value') {
        own.push(...conditionFacts(attributeOf(check, 'value'), properties, schema));
      }
    }
  }
  // Most elements add nothing: they share their parent's list.
  const facts = own.length === 0 ? inherited : [...inherited, ...own];
  factsByElement.set(element, { properties, schema, facts });
  return facts;
}

/** The offsets where each variable is set or removed, by name, in text order. */
const writesByVariables = new WeakMap<DocumentVariables, Map<string, number[]>>();

function writesOf(variables: DocumentVariables): Map<string, number[]> {
  let writes = writesByVariables.get(variables);
  if (!writes) {
    writes = new Map();
    for (const occurrence of variables.occurrences) {
      if (occurrence.kind !== 'reference') {
        const offsets = writes.get(occurrence.name) ?? [];
        offsets.push(occurrence.start);
        writes.set(occurrence.name, offsets);
      }
    }
    writesByVariables.set(variables, writes);
  }
  return writes;
}

/** True when the variable a fact's chain starts with is set or removed between the test and `at`. */
function writtenSince(fact: ClassFact, at: number, variables: DocumentVariables | undefined): boolean {
  if (!variables || !fact.key.startsWith('$')) {
    return false;
  }
  const name = fact.key.slice(1).split('.')[0];
  const after = fact.attribute.end;
  return (writesOf(variables).get(name) ?? []).some((offset) => offset > after && offset < at);
}

/** The key of the chain of the first `index + 1` steps: their texts joined by dots. */
function keyOf(steps: readonly ChainStep[], index: number): string {
  return steps
    .slice(0, index + 1)
    .map((step) => step.text)
    .join('.');
}

/** The class facts that hold for chains, at one place of an attribute's value. */
export interface Narrowing {
  /** For the resolver: the datatype of the chain of steps `0..index`, when a fact names it. */
  types: StepTypes;
  /** The fact that narrows the chain of steps `0..index`, when one does. */
  factFor(index: number, steps: readonly ChainStep[]): ClassFact | undefined;
}

/**
 * The class facts that hold at an offset of an attribute's value, or undefined when none does. The facts of
 * the value itself come after those of the elements around it: the nearest test of a chain decides.
 */
export function narrowingAt(
  attribute: XmlAttribute,
  offset: number,
  properties: ScriptProperties,
  schema: ScriptSchema,
  variables?: DocumentVariables
): Narrowing | undefined {
  const enclosing = enclosingFacts(attribute.element, properties, schema);
  const ranges = mayTest.test(attribute.value) ? rangesOf(parsedValue(attribute).expression, attribute.value, properties, schema) : noRanges;
  // Nearly every chain: no class test around it or before it in its value.
  if (enclosing.length === 0 && ranges.length === 0) {
    return undefined;
  }
  const at = offsetInValue(attribute, offset);
  const facts = new Map<string, ClassFact>();
  for (const fact of enclosing) {
    if (!writtenSince(fact, at, variables)) {
      facts.set(fact.key, fact);
    }
  }
  for (const range of ranges) {
    if (range.start <= offset && offset <= range.end) {
      for (const fact of range.facts) {
        facts.set(fact.key, { ...fact, attribute });
      }
    }
  }
  if (facts.size === 0) {
    return undefined;
  }
  const factFor = (index: number, steps: readonly ChainStep[]): ClassFact | undefined => {
    if (steps.slice(0, index + 1).some((step) => step.kind !== 'identifier' && step.kind !== 'variable')) {
      return undefined;
    }
    return facts.get(keyOf(steps, index));
  };
  return { types: (index, steps) => factFor(index, steps)?.datatype, factFor };
}
