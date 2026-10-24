/**
 * Semantic tokens of a patch document's own paths, in `sel` and `if` of its operations.
 *
 * A path is read by its text, as XPath writes it, so that also XPath beyond what X4CodeSense evaluates and
 * a path being typed get their colours: element names `xmlTag` and attribute names `xmlAttribute`, which
 * an editor colours as the tags and attributes of XML; a function and a node test (`not(`, `text()`)
 * `function`, an axis (`following-sibling::`) `keyword`, a variable `variable`; strings, numbers, and
 * operators and punctuation as in expressions. The name a path selects a cue, a library or an interrupt library item by
 * (`cue[@name='Start']`) is coloured as that name is elsewhere, its quotes as a string.
 */
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { scriptSchemaOf } from '../analysis/positionContext';
import { pathNamesOf, type PathName, type PathNameKind } from '../patches/pathNames';
import { indexInValue, offsetInValue, type XmlAttribute } from '../xml/xmlStructure';
import { isOperation } from './patchContent';
import type { SemanticToken, SemanticTokenType } from './semanticTokens';

const nameStart = /[A-Za-z_À-￿]/;
const nameCharacter = /[\w.\-·À-￿]/;
const operatorWords: ReadonlySet<string> = new Set(['and', 'or', 'div', 'mod']);
const twoCharacterOperators: ReadonlySet<string> = new Set(['//', '::', '!=', '<=', '>=', '..']);

const pathNameTypes: Record<PathNameKind, SemanticTokenType> = {
  cue: 'namespace',
  actions: 'function',
  handler: 'function',
  conditions: 'function',
};

/** Where the XML name that starts at `start` ends, with its prefix. */
function nameEnd(text: string, start: number): number {
  let end = start + 1;
  while (end < text.length && (nameCharacter.test(text[end]) || (text[end] === ':' && text[end + 1] !== ':' && text[end - 1] !== ':'))) {
    end++;
  }
  return end;
}

/** The first character after `from` that is no space, or the end. */
function nextCharacter(text: string, from: number): string {
  let at = from;
  while (at < text.length && /\s/.test(text[at])) {
    at++;
  }
  return text[at] ?? '';
}

/** The tokens of one path as offsets in its decoded value; `named` holds the decoded ranges of the names it selects by. */
function valueTokens(text: string, named: ReadonlyMap<number, { end: number; type: SemanticTokenType }>): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  const push = (start: number, end: number, type: SemanticTokenType): void => {
    tokens.push({ start, end, type });
  };
  // True after something an operator can follow: `and`, `or` and `*` are operators there, names before.
  let afterOperand = false;
  let afterAt = false;
  let at = 0;
  while (at < text.length) {
    const character = text[at];
    if (/\s/.test(character)) {
      at++;
      continue;
    }
    const start = at;
    const wasAfterAt = afterAt;
    afterAt = false;
    if (character === "'" || character === '"') {
      const close = text.indexOf(character, start + 1);
      const end = close < 0 ? text.length : close + 1;
      const name = named.get(start + 1);
      if (name && close >= 0) {
        push(start, start + 1, 'string');
        push(start + 1, name.end, name.type);
        push(name.end, end, 'string');
      } else {
        push(start, end, 'string');
      }
      at = end;
      afterOperand = true;
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(text.slice(start, start + 32));
    if (number) {
      at = start + number[0].length;
      push(start, at, 'number');
      afterOperand = true;
      continue;
    }
    if (character === '$' && nameStart.test(text[start + 1] ?? '')) {
      at = nameEnd(text, start + 1);
      push(start, at, 'variable');
      afterOperand = true;
      continue;
    }
    if (nameStart.test(character)) {
      at = nameEnd(text, start);
      const word = text.slice(start, at);
      const next = nextCharacter(text, at);
      if (wasAfterAt) {
        push(start, at, 'xmlAttribute');
        afterOperand = true;
      } else if (afterOperand && operatorWords.has(word)) {
        push(start, at, 'operator');
        afterOperand = false;
      } else if (text.startsWith('::', at)) {
        push(start, at, 'keyword');
        afterOperand = false;
      } else if (next === '(') {
        push(start, at, 'function');
        afterOperand = false;
      } else {
        push(start, at, 'xmlTag');
        afterOperand = true;
      }
      continue;
    }
    const pair = text.slice(start, start + 2);
    if (twoCharacterOperators.has(pair)) {
      at = start + 2;
      push(start, at, 'operator');
      afterOperand = pair === '..';
      continue;
    }
    at = start + 1;
    if (character === '*' && !afterOperand) {
      // A name test for any element, or with `@` any attribute.
      push(start, at, wasAfterAt ? 'xmlAttribute' : 'xmlTag');
      afterOperand = true;
      continue;
    }
    push(start, at, 'operator');
    afterAt = character === '@';
    afterOperand = character === ')' || character === ']' || character === '.';
  }
  return tokens;
}

/**
 * The tokens of the `sel` and `if` paths of a patch document's operations, with text offsets, in text
 * order; `include` tells the values to classify.
 */
export function pathTokens(analysis: DocumentAnalysis, include: (start: number, end: number) => boolean): SemanticToken[] {
  const structure = analysis.structure;
  const root = structure?.roots[0];
  if (!structure || !analysis.detection.isDiff || !root) {
    return [];
  }
  const schema = scriptSchemaOf(analysis);
  const names = schema ? pathNamesOf(structure, schema) : [];
  const tokens: SemanticToken[] = [];
  for (const operation of root.children) {
    if (!isOperation(analysis, operation)) {
      continue;
    }
    for (const attribute of operation.attributes) {
      if ((attribute.name !== 'sel' && attribute.name !== 'if') || attribute.quote === '' || !include(attribute.valueStart, attribute.valueEnd)) {
        continue;
      }
      tokens.push(...attributeTokens(attribute, names));
    }
  }
  return tokens;
}

/** The tokens of a path attribute, from its decoded value to text offsets; `names` with text offsets. */
function attributeTokens(attribute: XmlAttribute, names: readonly PathName[]): SemanticToken[] {
  // The names by their decoded start, as the value's tokens find them.
  const named = new Map<number, { end: number; type: SemanticTokenType }>();
  for (const name of names) {
    if (name.start >= attribute.valueStart && name.end <= attribute.valueEnd) {
      named.set(indexInValue(attribute, name.start), { end: indexInValue(attribute, name.end), type: pathNameTypes[name.kind] });
    }
  }
  return valueTokens(attribute.value, named).map((token) => ({
    ...token,
    start: offsetInValue(attribute, token.start),
    end: offsetInValue(attribute, token.end),
  }));
}
