/**
 * The small XPath subset that `scriptproperties.xml` uses in its `import` elements, evaluated over the
 * scanner's element tree:
 *
 *   /a/b, /a/\*, //b, a[@x='v'], a[@x='v' or @y="w"], a[not(@x)], a[@x],
 *   a[substring(@name, string-length(@name) - string-length('tail') + 1) = 'tail']   (ends with)
 *
 * Name tests compare local names, so `xs:element` matches whatever prefix a schema file uses.
 */
import { attributeNamed, decodeAttributeValue, type XmlElement, type XmlStructure } from './xmlStructure';

interface Step {
  descendants: boolean;
  name: string;
  predicates: Predicate[];
}

type Predicate = (element: XmlElement) => boolean;

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

const endsWithForm = /^substring\(@(\w+),\s*string-length\(@\1\)\s*-\s*string-length\(('[^']*'|"[^"]*")\)\s*\+\s*1\)\s*=\s*('[^']*'|"[^"]*")$/;
const attributeEquals = /^@([\w:.-]+)\s*=\s*('[^']*'|"[^"]*")$/;
const attributeMissing = /^not\(@([\w:.-]+)\)$/;
const attributePresent = /^@([\w:.-]+)$/;

function unquote(literal: string): string {
  return literal.slice(1, -1);
}

function parseAtom(text: string): Predicate {
  const trimmed = text.trim();
  let match = endsWithForm.exec(trimmed);
  if (match) {
    const attribute = match[1];
    const tail = unquote(match[3]);
    return (element) => (attributeNamed(element, attribute)?.value ?? '').endsWith(tail);
  }
  match = attributeEquals.exec(trimmed);
  if (match) {
    const attribute = match[1];
    const value = unquote(match[2]);
    return (element) => attributeNamed(element, attribute)?.value === value;
  }
  match = attributeMissing.exec(trimmed);
  if (match) {
    const attribute = match[1];
    return (element) => attributeNamed(element, attribute) === undefined;
  }
  match = attributePresent.exec(trimmed);
  if (match) {
    const attribute = match[1];
    return (element) => attributeNamed(element, attribute) !== undefined;
  }
  throw new Error(`unsupported predicate '${trimmed}'`);
}

/** Splits on a word operator outside quotes. */
function splitOutsideQuotes(text: string, word: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (text.startsWith(word, index) && /\s/.test(text[index - 1] ?? ' ') && /\s/.test(text[index + word.length] ?? ' ')) {
      parts.push(text.slice(start, index));
      start = index + word.length;
      index = start - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parsePredicate(text: string): Predicate {
  const alternatives = splitOutsideQuotes(text, 'or').map((alternative) => {
    const conjuncts = splitOutsideQuotes(alternative, 'and').map(parseAtom);
    return (element: XmlElement) => conjuncts.every((conjunct) => conjunct(element));
  });
  return (element) => alternatives.some((alternative) => alternative(element));
}

function parsePath(expression: string): Step[] {
  const steps: Step[] = [];
  let position = 0;
  const text = expression.trim();
  while (position < text.length) {
    let descendants = false;
    if (text.startsWith('//', position)) {
      descendants = true;
      position += 2;
    } else if (text[position] === '/') {
      position++;
    } else if (steps.length > 0) {
      throw new Error(`expected '/' at ${position} in '${text}'`);
    }
    const nameStart = position;
    while (position < text.length && text[position] !== '/' && text[position] !== '[') {
      position++;
    }
    const name = text.slice(nameStart, position).trim();
    if (name === '') {
      throw new Error(`missing name at ${position} in '${text}'`);
    }
    const predicates: Predicate[] = [];
    while (text[position] === '[') {
      let depth = 0;
      let quote = '';
      let end = position;
      for (; end < text.length; end++) {
        const character = text[end];
        if (quote) {
          if (character === quote) {
            quote = '';
          }
        } else if (character === "'" || character === '"') {
          quote = character;
        } else if (character === '[') {
          depth++;
        } else if (character === ']') {
          depth--;
          if (depth === 0) {
            break;
          }
        }
      }
      if (end >= text.length) {
        throw new Error(`unclosed predicate in '${text}'`);
      }
      predicates.push(parsePredicate(text.slice(position + 1, end)));
      position = end + 1;
    }
    steps.push({ descendants, name, predicates });
  }
  return steps;
}

function matches(element: XmlElement, step: Step): boolean {
  if (step.name !== '*' && localName(element.name) !== localName(step.name)) {
    return false;
  }
  return step.predicates.every((predicate) => predicate(element));
}

function descendantsOf(element: XmlElement, into: XmlElement[]): void {
  for (const child of element.children) {
    into.push(child);
    descendantsOf(child, into);
  }
}

/** Elements selected by an absolute path expression. Throws on syntax the subset does not cover. */
export function selectElements(structure: XmlStructure, expression: string): XmlElement[] {
  const steps = parsePath(expression);
  if (steps.length === 0) {
    return [];
  }
  let current: XmlElement[] = steps[0].descendants
    ? structure.elements.filter((element) => matches(element, steps[0]))
    : structure.roots.filter((root) => matches(root, steps[0]));
  for (const step of steps.slice(1)) {
    const next: XmlElement[] = [];
    for (const element of current) {
      const candidates: XmlElement[] = [];
      if (step.descendants) {
        descendantsOf(element, candidates);
      } else {
        candidates.push(...element.children);
      }
      for (const candidate of candidates) {
        if (matches(candidate, step) && !next.includes(candidate)) {
          next.push(candidate);
        }
      }
    }
    current = next;
  }
  return current;
}

/** Text content of an element, references decoded and whitespace collapsed. */
export function textOf(element: XmlElement, fileText: string): string {
  if (!element.endTag) {
    return '';
  }
  return decodeAttributeValue(fileText.slice(element.startTagEnd, element.endTag.start), []).replace(/\s+/g, ' ').trim();
}

/**
 * Value of a relative result expression on an element: `@attr` for an attribute, or a child path ending in
 * `text()` such as `xs:annotation/xs:documentation/text()`. Empty when nothing matches.
 */
export function selectValue(element: XmlElement, expression: string, fileText: string): string {
  const trimmed = expression.trim();
  if (trimmed === '') {
    return '';
  }
  if (trimmed.startsWith('@')) {
    return attributeNamed(element, trimmed.slice(1))?.value ?? '';
  }
  const parts = trimmed.split('/');
  const wantsText = parts[parts.length - 1] === 'text()';
  const names = wantsText ? parts.slice(0, -1) : parts;
  let current: XmlElement | undefined = element;
  for (const name of names) {
    current = current.children.find((child) => localName(child.name) === localName(name));
    if (!current) {
      return '';
    }
  }
  return wantsText ? textOf(current, fileText) : (attributeNamed(current, 'value')?.value ?? textOf(current, fileText));
}
