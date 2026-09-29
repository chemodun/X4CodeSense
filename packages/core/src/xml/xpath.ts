/**
 * XPath location paths as patch documents write them in `sel` and `if`.
 *
 * The game evaluates them with libxml2, so any XPath 1.0 works there. This parser covers what the
 * patches of the game and of mods use, and a little more: absolute and relative paths, `/` and `//`,
 * element names and `*`, a final `@attr`, `text()`, `comment()` and `node()`, and predicates made of
 * `[N]`, `last()`, `position() = N`, a comparison of `@attr`, a child element or `.` with a string (`=`,
 * `!=`), `@attr` or a child alone to test presence, `not(...)`, `contains()` and `starts-with()`, joined
 * by `and` and `or`. Other XPath is reported as not understood, never as wrong; only what cannot be
 * XPath at all (an unclosed bracket or string, a missing name) is a syntax problem. Every part keeps its
 * offsets in the expression, for diagnostics, hover and completion.
 */

/** Offsets in the expression text; half open. */
export interface XPathRange {
  start: number;
  end: number;
}

/** A string literal; `value` is the text between the quotes. */
export interface XPathLiteral extends XPathRange {
  value: string;
}

/** What a predicate compares or tests: an attribute, a child element, or the node itself (`.`). */
export type XPathSubject = XPathRange & ({ kind: 'attribute'; name: string } | { kind: 'child'; name: string } | { kind: 'self' });

export type XPathPredicate = XPathRange &
  (
    | { kind: 'position'; position: number | 'last' }
    | { kind: 'compare'; subject: XPathSubject; operator: '=' | '!='; value: XPathLiteral }
    | { kind: 'exists'; subject: XPathSubject }
    | { kind: 'function'; name: 'contains' | 'starts-with'; subject: XPathSubject; value: XPathLiteral }
    | { kind: 'not'; operand: XPathPredicate }
    | { kind: 'and' | 'or'; operands: XPathPredicate[] }
  );

export type XPathTest = XPathRange &
  ({ kind: 'element'; name: string } | { kind: 'any' } | { kind: 'attribute'; name: string } | { kind: 'text' } | { kind: 'comment' } | { kind: 'node' });

export interface XPathStep extends XPathRange {
  /** True after `//`: the step looks at every descendant of its context, not only at the children. */
  descendants: boolean;
  test: XPathTest;
  predicates: XPathPredicate[];
}

export interface XPathProblem extends XPathRange {
  message: string;
  /** True for XPath beyond this subset, which the game may well understand; false for broken syntax. */
  unsupported: boolean;
}

export interface XPath {
  text: string;
  /** True when the path starts with `/` or `//`; a relative path starts at the document as well. */
  absolute: boolean;
  /** The steps read, also when a problem stopped the reading. */
  steps: XPathStep[];
  problem?: XPathProblem;
}

/** A condition of `if`: a path that must select something, or with `not(...)` nothing. */
export interface XPathCondition {
  negated: boolean;
  path: XPath;
}

class Stop extends Error {
  constructor(readonly problem: XPathProblem) {
    super(problem.message);
  }
}

const nameStart = /[A-Za-z_À-￿]/;
const nameCharacter = /[\w.\-·À-￿]/;

class Reader {
  position = 0;

  constructor(readonly text: string) {}

  get done(): boolean {
    this.skipSpaces();
    return this.position >= this.text.length;
  }

  peek(): string {
    this.skipSpaces();
    return this.text[this.position] ?? '';
  }

  startsWith(token: string): boolean {
    this.skipSpaces();
    return this.text.startsWith(token, this.position);
  }

  skipSpaces(): void {
    while (this.position < this.text.length && /\s/.test(this.text[this.position])) {
      this.position++;
    }
  }

  fail(message: string, start = this.position, end = Math.max(start + 1, this.position), unsupported = false): never {
    throw new Stop({ message, start, end: Math.min(end, Math.max(this.text.length, start)), unsupported });
  }

  unsupported(what: string, start: number, end = this.position): never {
    this.fail(`${what} is not understood by X4CodeSense; the game may accept it`, start, end, true);
  }

  /** An XML name with an optional prefix, or undefined when none starts here. */
  name(): (XPathRange & { name: string }) | undefined {
    this.skipSpaces();
    const start = this.position;
    if (!nameStart.test(this.text[start] ?? '')) {
      return undefined;
    }
    let end = start + 1;
    while (
      end < this.text.length &&
      (nameCharacter.test(this.text[end]) || (this.text[end] === ':' && this.text[end + 1] !== ':' && this.text[end - 1] !== ':'))
    ) {
      end++;
    }
    this.position = end;
    return { name: this.text.slice(start, end), start, end };
  }

  literal(): XPathLiteral | undefined {
    this.skipSpaces();
    const quote = this.text[this.position];
    if (quote !== "'" && quote !== '"') {
      return undefined;
    }
    const start = this.position;
    const close = this.text.indexOf(quote, start + 1);
    if (close < 0) {
      this.fail(`String ${quote}${this.text.slice(start + 1, start + 21)} is not closed`, start, this.text.length);
    }
    this.position = close + 1;
    return { value: this.text.slice(start + 1, close), start, end: close + 1 };
  }

  number(): (XPathRange & { value: number }) | undefined {
    this.skipSpaces();
    const match = /^\d+/.exec(this.text.slice(this.position));
    if (!match) {
      return undefined;
    }
    const start = this.position;
    this.position += match[0].length;
    return { value: Number(match[0]), start, end: this.position };
  }

  expect(token: string, context: string): void {
    if (!this.startsWith(token)) {
      this.fail(`Expected '${token}' ${context}`);
    }
    this.position += token.length;
  }
}

/** Where the bracket opened at `start` closes, skipping strings; else where an unclosed string starts, or nothing. */
function closingBracket(text: string, start: number): { close: number } | { unclosedString?: number } {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === "'" || character === '"') {
      const close = text.indexOf(character, index + 1);
      if (close < 0) {
        return { unclosedString: index };
      }
      index = close;
    } else if (character === '[') {
      depth++;
    } else if (character === ']') {
      depth--;
      if (depth === 0) {
        return { close: index };
      }
    }
  }
  return {};
}

function subject(reader: Reader): XPathSubject | undefined {
  reader.skipSpaces();
  const start = reader.position;
  if (reader.startsWith('@')) {
    reader.position++;
    const name = reader.name();
    if (!name) {
      reader.fail("Expected an attribute name after '@'");
    }
    return { kind: 'attribute', name: name.name, start, end: name.end };
  }
  if (reader.startsWith('.') && !reader.startsWith('..')) {
    reader.position++;
    return { kind: 'self', start, end: reader.position };
  }
  const name = reader.name();
  if (!name) {
    return undefined;
  }
  if (reader.startsWith('(') || reader.startsWith('::')) {
    reader.unsupported(`'${name.name}${reader.peek() === '(' ? '()' : '::'}'`, start, reader.position + 1);
  }
  return { kind: 'child', name: name.name, start, end: name.end };
}

function comparison(reader: Reader): '=' | '!=' | undefined {
  if (reader.startsWith('!=')) {
    reader.position += 2;
    return '!=';
  }
  if (reader.startsWith('=')) {
    reader.position += 1;
    return '=';
  }
  return undefined;
}

function primary(reader: Reader): XPathPredicate {
  reader.skipSpaces();
  const start = reader.position;
  const number = reader.number();
  if (number) {
    return { kind: 'position', position: number.value, start, end: number.end };
  }
  if (reader.startsWith('(')) {
    reader.position++;
    const inner = orExpression(reader);
    reader.expect(')', 'to close the parenthesis');
    return { ...inner, start, end: reader.position };
  }
  const saved = reader.position;
  const name = reader.name();
  if (name && reader.startsWith('(')) {
    reader.position++;
    switch (name.name) {
      case 'not': {
        const operand = orExpression(reader);
        reader.expect(')', 'to close not(');
        return { kind: 'not', operand, start, end: reader.position };
      }
      case 'last':
        reader.expect(')', 'after last(');
        return { kind: 'position', position: 'last', start, end: reader.position };
      case 'position': {
        reader.expect(')', 'after position(');
        if (comparison(reader) !== '=') {
          reader.unsupported('position() other than position() = N', start);
        }
        const value = reader.number();
        if (!value) {
          reader.unsupported('position() other than position() = N', start);
        }
        return { kind: 'position', position: value.value, start, end: value.end };
      }
      case 'contains':
      case 'starts-with': {
        const tested = subject(reader);
        if (!tested) {
          reader.unsupported(`${name.name}() of anything but an attribute, a child or '.'`, start);
        }
        reader.expect(',', `between the arguments of ${name.name}()`);
        const value = reader.literal();
        if (!value) {
          reader.unsupported(`${name.name}() with anything but a string`, start);
        }
        reader.expect(')', `to close ${name.name}(`);
        return { kind: 'function', name: name.name, subject: tested, value, start, end: reader.position };
      }
      default:
        reader.unsupported(`The function ${name.name}()`, start, reader.position);
    }
  }
  reader.position = saved;
  const tested = subject(reader);
  if (!tested) {
    const literal = reader.literal();
    if (literal) {
      reader.unsupported('A string before the comparison', start);
    }
    reader.fail('Expected a condition', start);
  }
  const operator = comparison(reader);
  if (!operator) {
    if (/^\s*(<|>|\+|-(?!\w)|\*|div\b|mod\b|\|)/.test(reader.text.slice(reader.position))) {
      reader.unsupported('This operator', reader.position, reader.position + 1);
    }
    return { kind: 'exists', subject: tested, start, end: tested.end };
  }
  const value = reader.literal();
  if (!value) {
    reader.skipSpaces();
    if (reader.done || reader.startsWith(']')) {
      reader.fail(`Expected a string after '${operator}'`);
    }
    reader.unsupported('A comparison with anything but a string', start);
  }
  return { kind: 'compare', subject: tested, operator, value, start, end: value.end };
}

/** An operator word; like libxml2, `'a' or.='b'` reads `or` although a name could go on with `.`. */
function keyword(reader: Reader, word: string): boolean {
  reader.skipSpaces();
  const text = reader.text;
  const at = reader.position;
  if (!text.startsWith(word, at) || /[\w:-]/.test(text[at + word.length] ?? ' ')) {
    return false;
  }
  reader.position = at + word.length;
  return true;
}

function andExpression(reader: Reader): XPathPredicate {
  const operands = [primary(reader)];
  const start = operands[0].start;
  while (keyword(reader, 'and')) {
    operands.push(primary(reader));
  }
  return operands.length === 1 ? operands[0] : { kind: 'and', operands, start, end: reader.position };
}

function orExpression(reader: Reader): XPathPredicate {
  const operands = [andExpression(reader)];
  while (keyword(reader, 'or')) {
    operands.push(andExpression(reader));
  }
  return operands.length === 1 ? operands[0] : { kind: 'or', operands, start: operands[0].start, end: reader.position };
}

/** The predicate between `[` at `open` and its `]` at `close`. */
function predicate(text: string, open: number, close: number): XPathPredicate {
  const reader: Reader = new Reader(text.slice(0, close));
  reader.position = open + 1;
  if (reader.done) {
    reader.fail('Empty predicate', open, close + 1);
  }
  const result = orExpression(reader);
  if (!reader.done) {
    reader.skipSpaces();
    reader.unsupported(`'${text.slice(reader.position, close)}'`, reader.position, close);
  }
  return result;
}

function test(reader: Reader): XPathTest {
  reader.skipSpaces();
  const start = reader.position;
  if (reader.startsWith('*')) {
    reader.position++;
    return { kind: 'any', start, end: reader.position };
  }
  if (reader.startsWith('@')) {
    reader.position++;
    const name = reader.name();
    if (!name) {
      if (reader.startsWith('*')) {
        reader.unsupported("'@*'", start, reader.position + 1);
      }
      reader.fail("Expected an attribute name after '@'", start);
    }
    return { kind: 'attribute', name: name.name, start, end: name.end };
  }
  if (reader.startsWith('..') || reader.startsWith('.')) {
    reader.unsupported(`'${reader.startsWith('..') ? '..' : '.'}' as a step`, start, start + (reader.startsWith('..') ? 2 : 1));
  }
  const name = reader.name();
  if (!name) {
    reader.fail(reader.done ? 'Expected a name at the end of the path' : `Expected a name, found '${reader.peek()}'`, start);
  }
  if (reader.startsWith('::')) {
    reader.unsupported(`The axis '${name.name}::'`, start, reader.position + 2);
  }
  if (reader.startsWith('(')) {
    const kind = name.name === 'text' ? 'text' : name.name === 'comment' ? 'comment' : name.name === 'node' ? 'node' : undefined;
    reader.position++;
    if (!kind || !reader.startsWith(')')) {
      reader.unsupported(`'${name.name}(' as a step`, start, reader.position);
    }
    reader.position++;
    return { kind, start, end: reader.position };
  }
  return { kind: 'element', name: name.name, start, end: name.end };
}

/** Reads a location path; a problem stops the reading and keeps the steps before it. */
export function parseXPath(text: string): XPath {
  // Typed, so the compiler knows `fail` does not return.
  const reader: Reader = new Reader(text);
  const steps: XPathStep[] = [];
  const result: XPath = { text, absolute: text.trimStart().startsWith('/'), steps };
  try {
    if (reader.done) {
      reader.fail('Empty path', 0, text.length);
    }
    while (!reader.done) {
      const start = reader.position;
      let descendants = false;
      if (reader.startsWith('//')) {
        descendants = true;
        reader.position += 2;
      } else if (reader.startsWith('/')) {
        reader.position += 1;
      } else if (steps.length > 0) {
        if (reader.startsWith('|')) {
          reader.unsupported("A union with '|'", reader.position);
        }
        reader.fail(`Expected '/' or '[', found '${reader.peek()}'`);
      }
      if (reader.done && steps.length === 0 && !descendants) {
        // `/` alone: the document itself.
        break;
      }
      const stepTest = test(reader);
      const step: XPathStep = { descendants, test: stepTest, predicates: [], start, end: stepTest.end };
      steps.push(step);
      while (reader.startsWith('[')) {
        const open = reader.position;
        const bracket = closingBracket(text, open);
        if (!('close' in bracket)) {
          const quoted = bracket.unclosedString;
          if (quoted !== undefined) {
            reader.fail(`String ${text.slice(quoted, quoted + 21)} is not closed`, quoted, text.length);
          }
          reader.fail("Predicate '[' is not closed", open, text.length);
        }
        step.predicates.push(predicate(text, open, bracket.close));
        reader.position = bracket.close + 1;
        step.end = reader.position;
      }
      if (stepTest.kind === 'attribute' || stepTest.kind === 'text') {
        if (!reader.done) {
          reader.fail(`Nothing can follow ${stepTest.kind === 'attribute' ? 'an attribute' : 'text()'}`);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Stop)) {
      throw error;
    }
    result.problem = error.problem;
  }
  return result;
}

/** Reads the condition of `if`: a path, or `not(path)`. */
export function parseXPathCondition(text: string): XPathCondition {
  const negated = /^(\s*not\s*\()([^]*)\)\s*$/.exec(text);
  if (!negated) {
    return { negated: false, path: parseXPath(text) };
  }
  const offset = negated[1].length;
  const path = parseXPath(negated[2]);
  const shift = (range: XPathRange): void => {
    range.start += offset;
    range.end += offset;
  };
  const shiftPredicate = (predicate: XPathPredicate): void => {
    shift(predicate);
    if (predicate.kind === 'compare' || predicate.kind === 'function') {
      shift(predicate.subject);
      shift(predicate.value);
    } else if (predicate.kind === 'exists') {
      shift(predicate.subject);
    } else if (predicate.kind === 'not') {
      shiftPredicate(predicate.operand);
    } else if (predicate.kind === 'and' || predicate.kind === 'or') {
      predicate.operands.forEach(shiftPredicate);
    }
  };
  for (const step of path.steps) {
    shift(step);
    shift(step.test);
    step.predicates.forEach(shiftPredicate);
  }
  if (path.problem) {
    shift(path.problem);
  }
  return { negated: true, path: { ...path, text } };
}

/** A node a path is evaluated over. */
export interface XPathNode<N extends XPathNode<N>> {
  readonly kind: 'document' | 'element' | 'comment';
  /** The element name; empty for the document and comments. */
  readonly name: string;
  readonly children: readonly N[];
  attribute(name: string): string | undefined;
  /** The text an element holds, a comment's text. */
  stringValue(): string;
}

/** What a path selects: a node, an attribute of an element, or the text of an element. */
export type XPathSelection<N> = { kind: 'node'; node: N } | { kind: 'attribute'; owner: N; name: string } | { kind: 'text'; owner: N };

function valuesOf<N extends XPathNode<N>>(subject: XPathSubject, selection: XPathSelection<N>): string[] {
  if (selection.kind !== 'node') {
    if (subject.kind !== 'self') {
      return [];
    }
    const value = selection.kind === 'attribute' ? selection.owner.attribute(selection.name) : selection.owner.stringValue();
    return value === undefined ? [] : [value];
  }
  const node = selection.node;
  switch (subject.kind) {
    case 'attribute': {
      const value = node.attribute(subject.name);
      return value === undefined ? [] : [value];
    }
    case 'child':
      return node.children.filter((child) => child.kind === 'element' && child.name === subject.name).map((child) => child.stringValue());
    case 'self':
      return [node.stringValue()];
  }
}

function holds<N extends XPathNode<N>>(predicate: XPathPredicate, selection: XPathSelection<N>, position: number, size: number): boolean {
  switch (predicate.kind) {
    case 'position':
      return position === (predicate.position === 'last' ? size : predicate.position);
    case 'compare': {
      const values = valuesOf(predicate.subject, selection);
      return values.some((value) => (predicate.operator === '=' ? value === predicate.value.value : value !== predicate.value.value));
    }
    case 'exists':
      return valuesOf(predicate.subject, selection).length > 0;
    case 'function': {
      const value = valuesOf(predicate.subject, selection)[0] ?? '';
      return predicate.name === 'contains' ? value.includes(predicate.value.value) : value.startsWith(predicate.value.value);
    }
    case 'not':
      return !holds(predicate.operand, selection, position, size);
    case 'and':
      return predicate.operands.every((operand) => holds(operand, selection, position, size));
    case 'or':
      return predicate.operands.some((operand) => holds(operand, selection, position, size));
  }
}

function forDescendantsAndSelf<N extends XPathNode<N>>(node: N, visit: (node: N) => void): void {
  visit(node);
  for (const child of node.children) {
    forDescendantsAndSelf(child, visit);
  }
}

function filtered<N extends XPathNode<N>>(candidates: XPathSelection<N>[], predicates: readonly XPathPredicate[]): XPathSelection<N>[] {
  let current = candidates;
  for (const predicate of predicates) {
    const size = current.length;
    current = current.filter((candidate, index) => holds(predicate, candidate, index + 1, size));
  }
  return current;
}

function matchesTest<N extends XPathNode<N>>(test: XPathTest, node: N): boolean {
  switch (test.kind) {
    case 'element':
      return node.kind === 'element' && node.name === test.name;
    case 'any':
      return node.kind === 'element';
    case 'comment':
      return node.kind === 'comment';
    case 'node':
      return node.kind !== 'document';
    default:
      return false;
  }
}

/**
 * The selection of the first `stepCount` steps of a path (all by default) from the document, in document
 * order without repeats. A path with a problem selects nothing.
 */
export function evaluateXPath<N extends XPathNode<N>>(path: XPath, document: N, stepCount = path.steps.length): XPathSelection<N>[] {
  if (path.problem) {
    return [];
  }
  let context: XPathSelection<N>[] = [{ kind: 'node', node: document }];
  for (const step of path.steps.slice(0, stepCount)) {
    const next: XPathSelection<N>[] = [];
    // Nodes reached twice (`//a//b`) are selected once; an attribute or text by its element.
    const seen = new Set<N>();
    const add = (selection: XPathSelection<N>): void => {
      const key = selection.kind === 'node' ? selection.node : selection.owner;
      if (!seen.has(key)) {
        seen.add(key);
        next.push(selection);
      }
    };
    const test = step.test;
    const visit = (node: N): void => {
      if (test.kind === 'attribute') {
        if (node.kind === 'element' && node.attribute(test.name) !== undefined) {
          filtered<N>([{ kind: 'attribute', owner: node, name: test.name }], step.predicates).forEach(add);
        }
      } else if (test.kind === 'text') {
        if (node.kind === 'element' && node.stringValue() !== '') {
          filtered<N>([{ kind: 'text', owner: node }], step.predicates).forEach(add);
        }
      } else {
        // Positions count per parent, so the candidates are the matching children of one node at a time.
        let candidates: XPathSelection<N>[] | undefined;
        for (const child of node.children) {
          if (matchesTest(test, child)) {
            (candidates ??= []).push({ kind: 'node', node: child });
          }
        }
        if (candidates) {
          filtered(candidates, step.predicates).forEach(add);
        }
      }
    };
    for (const selection of context) {
      if (selection.kind === 'node') {
        if (step.descendants) {
          forDescendantsAndSelf(selection.node, visit);
        } else {
          visit(selection.node);
        }
      }
    }
    context = next;
  }
  return context;
}

/** True when the condition of `if` holds: its path selects something, or with `not(...)` nothing. */
export function conditionHolds<N extends XPathNode<N>>(condition: XPathCondition, document: N): boolean {
  return evaluateXPath(condition.path, document).length > 0 !== condition.negated;
}
