/**
 * Property chains in expressions: `player.ship.cargo.{$ware}.count`, `$target.isclass.ship`, `'%s'.[$x]`.
 *
 * `chainAtCaret` and `chainAtToken` cut the chain around a position out of the token stream, and
 * `resolveChain` walks it against the script properties: the head is a keyword, a variable or a literal,
 * every further step matches a segment of a property name pattern of the current datatype. Property names
 * can span several steps (`cargo.{$ware}.count`), and a placeholder segment such as `{$class}` accepts a
 * braced expression or a bare value of the keyword of that type (`isclass.ship`).
 */
import { ScriptDatatype, ScriptKeyword, ScriptProperties, ScriptProperty, type PropertySegment } from '../properties/scriptProperties';
import type { ScriptSchema } from '../types';
import { tokenize, tokenIndexAt, type Token } from './lexer';

export type ChainStepKind = 'identifier' | 'variable' | 'braces' | 'brackets' | 'parens' | 'string' | 'number';

/** One step of a chain as written: the head, or what follows a dot. */
export interface ChainStep {
  kind: ChainStepKind;
  start: number;
  end: number;
  text: string;
  /** Unit suffix of a number head. */
  suffix: string;
}

export interface ChainPartial {
  /** Text typed so far for the segment at the caret; empty right after a dot. */
  text: string;
  start: number;
  end: number;
}

export interface PropertyChain {
  /** Complete steps before the partial one. */
  steps: ChainStep[];
  /** The segment being typed at the caret, present only for `chainAtCaret` when the caret follows a dot. */
  partial?: ChainPartial;
}

const closers: Record<string, string> = { rbrace: 'lbrace', rbracket: 'lbracket', rparen: 'lparen' };
const stepKinds: Partial<Record<string, ChainStepKind>> = {
  identifier: 'identifier',
  variable: 'variable',
  string: 'string',
  number: 'number',
  lbrace: 'braces',
  lbracket: 'brackets',
  lparen: 'parens',
};

/** Index of the opening token matching the closing token at `index`, or -1. */
function openerOf(tokens: readonly Token[], index: number): number {
  const closing = tokens[index].kind;
  const opening = closers[closing];
  let depth = 0;
  for (let position = index; position >= 0; position--) {
    const kind = tokens[position].kind;
    if (kind === closing) {
      depth++;
    } else if (kind === opening) {
      depth--;
      if (depth === 0) {
        return position;
      }
    }
  }
  return -1;
}

/** Walks back from the token at `index` (the last token of a step) to the head and returns the steps in order. */
function collectSteps(tokens: readonly Token[], index: number): ChainStep[] {
  const steps: ChainStep[] = [];
  let position = index;
  while (position >= 0) {
    const token = tokens[position];
    let first = position;
    if (token.kind in closers) {
      first = openerOf(tokens, position);
      if (first < 0) {
        break;
      }
    }
    const kind = stepKinds[tokens[first].kind];
    if (!kind) {
      break;
    }
    steps.push({
      kind,
      start: tokens[first].start,
      end: token.end,
      text: tokens[first].text.slice(0, token.end - tokens[first].start),
      suffix: tokens[first].suffix,
    });
    if (first > 0 && tokens[first - 1].kind === 'dot') {
      position = first - 2;
      if (position < 0) {
        break;
      }
    } else {
      break;
    }
  }
  steps.reverse();
  // A multi-token step (braces, brackets, parens) needs the text between its bounds, not the opener's text.
  return steps;
}

function withTexts(expression: string, steps: ChainStep[]): ChainStep[] {
  for (const step of steps) {
    step.text = expression.slice(step.start, step.end);
  }
  return steps;
}

/**
 * The chain a caret is completing: the caret must be right after a dot, or inside or at the end of the
 * identifier or variable that follows a dot. Returns undefined elsewhere (including inside strings).
 */
export function chainAtCaret(expression: string, offset: number): PropertyChain | undefined {
  const tokens = tokenize(expression);
  let index = tokenIndexAt(tokens, offset);
  if (index < 0) {
    // The caret is between tokens or at the end: look at the token that ends at the caret.
    index = tokens.findIndex((token) => token.end === offset);
    if (index < 0) {
      return undefined;
    }
    const token = tokens[index];
    if (token.kind === 'dot') {
      if (index === 0) {
        return undefined;
      }
      return { steps: withTexts(expression, collectSteps(tokens, index - 1)), partial: { text: '', start: offset, end: offset } };
    }
    if (token.kind !== 'identifier' && token.kind !== 'variable') {
      return undefined;
    }
  }
  const token = tokens[index];
  if (token.kind !== 'identifier' && token.kind !== 'variable') {
    return undefined;
  }
  if (index === 0 || tokens[index - 1].kind !== 'dot' || index < 2) {
    return undefined;
  }
  return {
    steps: withTexts(expression, collectSteps(tokens, index - 2)),
    partial: { text: expression.slice(token.start, offset), start: token.start, end: token.end },
  };
}

/**
 * The chain that contains the token at the offset, for hover and definition, and the index of that step.
 * Steps after the one under the offset are left out.
 */
export function chainAtToken(expression: string, offset: number): { chain: PropertyChain; stepIndex: number } | undefined {
  const tokens = tokenize(expression);
  const index = tokenIndexAt(tokens, offset);
  if (index < 0) {
    return undefined;
  }
  const token = tokens[index];
  if (token.kind !== 'identifier' && token.kind !== 'variable') {
    return undefined;
  }
  const steps = withTexts(expression, collectSteps(tokens, index));
  if (steps.length === 0) {
    return undefined;
  }
  return { chain: { steps }, stepIndex: steps.length - 1 };
}

/** What a step of a chain resolved to. */
export interface ResolvedStep {
  step: ChainStep;
  /** The keyword, for a head that names one. */
  keyword?: ScriptKeyword;
  /** The property whose name pattern covers this step; the same property on every step it spans. */
  property?: ScriptProperty;
  /** Properties of any datatype that would match here, when the owner type was unknown and several fit. */
  candidates?: ScriptProperty[];
  /** Datatype of the value after this step, when known. */
  datatype?: ScriptDatatype;
}

/** What a step is looked up on. */
export type ChainOwner = { kind: 'keyword'; keyword: ScriptKeyword } | { kind: 'datatype'; datatype: ScriptDatatype } | { kind: 'unknown' };

export interface ResolvedChain {
  steps: ResolvedStep[];
  /** The owner each step is looked up on: `owners[i]` is what `steps[i]` is applied to; `owners[steps.length]` is the result. */
  owners: ChainOwner[];
}

const unknownOwner: ChainOwner = { kind: 'unknown' };

function ownerOfDatatype(datatype: ScriptDatatype | undefined): ChainOwner {
  return datatype ? { kind: 'datatype', datatype } : unknownOwner;
}

/** Datatype of a literal head. */
function literalDatatype(step: ChainStep, properties: ScriptProperties): ScriptDatatype | undefined {
  switch (step.kind) {
    case 'string':
    case 'braces':
      return properties.datatype('string');
    case 'brackets':
      return properties.datatype('list');
    case 'number': {
      const suffix = step.suffix === '' ? 'i' : step.suffix;
      return indexOf(properties).datatypeBySuffix(suffix) ?? (step.suffix === '' ? properties.datatype('numeric') : undefined);
    }
    default:
      return undefined;
  }
}

/**
 * True when a written step fits a segment of a property name pattern. A bare name fits a `{$type}`
 * placeholder when it is a value of the keyword of that type (`isclass.ship`); when `lenient`, any bare
 * name fits a placeholder whose type has no keyword (`project.agr_fields_sunrise`). Strict matches are
 * tried first, so `dock.container` is the `dock` property followed by `container`, not `dock.{$docksize}`.
 */
export function segmentMatches(segment: PropertySegment, step: ChainStep, properties: ScriptProperties, schema: ScriptSchema, lenient = false): boolean {
  switch (segment.kind) {
    case 'literal':
      return step.kind === 'identifier' && step.text === segment.text;
    case 'expression': {
      if (step.kind === 'braces' || step.kind === 'brackets') {
        return true;
      }
      if (step.kind !== 'identifier') {
        return false;
      }
      const keyword = indexOf(properties).keyword(segment.type, schema);
      return keyword ? keyword.properties.has(step.text) : lenient;
    }
    case 'variable':
      // `$name`, or a braced expression that yields the name: `this.{'$' + $name}`.
      return step.kind === 'variable' || step.kind === 'braces';
    case 'any':
      return step.kind === 'identifier' || step.kind === 'braces' || step.kind === 'brackets';
    case 'args':
      return step.kind === 'brackets';
  }
}

/**
 * The keyword whose values an `<name>` placeholder stands for: named in the property description as
 * `{keyword.<name>}`, or a keyword called like the placeholder, with or without a trailing `name`
 * (`<classname>` is `class`). Undefined for free names such as `<cuename>`.
 */
export function keywordForPlaceholder(name: string, property: ScriptProperty, properties: ScriptProperties, schema: ScriptSchema): ScriptKeyword | undefined {
  const hint = new RegExp(`\\{(\\w+)\\.<${name}>\\}`).exec(property.result);
  const candidates = hint ? [hint[1]] : [name, name.replace(/name$/, '')];
  for (const candidate of candidates) {
    const keyword = properties.keyword(candidate, schema);
    if (keyword) {
      return keyword;
    }
  }
  return undefined;
}

/** True when a keyword property is a concrete value, not a placeholder pattern. */
function isConcreteValue(value: ScriptProperty): boolean {
  return value.segments.length === 1 && value.segments[0].kind === 'literal';
}

/**
 * Number of steps from `from` a property covers, or -1 when it does not match there. With `prefix`, a
 * chain that ends before the pattern does still matches (`faction.player.haslicence.{$licence}` uses the
 * first part of `haslicence.<licencetype>.{$faction}`).
 */
function matchLength(
  property: ScriptProperty,
  steps: readonly ChainStep[],
  from: number,
  properties: ScriptProperties,
  schema: ScriptSchema,
  lenient: boolean,
  prefix = false
): number {
  const segments = property.segments;
  const available = steps.length - from;
  if (segments.length > available && !(prefix && available > 0)) {
    return -1;
  }
  const count = Math.min(segments.length, available);
  for (let index = 0; index < count; index++) {
    if (!segmentMatches(segments[index], steps[from + index], properties, schema, lenient)) {
      return -1;
    }
  }
  return count;
}

function literalCount(property: ScriptProperty): number {
  return property.segments.filter((segment) => segment.kind === 'literal').length;
}

/** Matching passes in order: [lenient, prefix]. */
const matchPasses: readonly (readonly [boolean, boolean])[] = [
  [false, false],
  [true, false],
  [true, true],
];

interface IndexedProperty {
  property: ScriptProperty;
  /** Position in the owner's property order, which decides ties between equal matches. */
  order: number;
}

interface OwnerIndex {
  /** Properties whose name starts with a literal segment, by that text. */
  literal: Map<string, IndexedProperty[]>;
  /** Properties whose first segment is a placeholder: they may match any step. */
  wildcard: IndexedProperty[];
}

/**
 * Lookup structures over one properties model, built on demand: the subtypes of each datatype, keywords
 * by name, datatypes by unit suffix, and per owner its properties by their first literal segment, so
 * that a step is only tried against the properties that can match it. Without this, every `$var.x`
 * step scanned all properties of all datatypes, a second per keystroke on the largest vanilla scripts.
 */
class ResolverIndex {
  private readonly owners = new Map<ScriptKeyword | ScriptDatatype | null, OwnerIndex>();
  private readonly subtypes = new Map<ScriptDatatype, ScriptDatatype[]>();
  private readonly keywords = new Map<string, ScriptKeyword | undefined>();
  private suffixes: Map<string, ScriptDatatype> | undefined;

  constructor(private readonly properties: ScriptProperties) {}

  /** Every datatype that derives from the given one, in declaration order. */
  subtypesOf(datatype: ScriptDatatype): ScriptDatatype[] {
    let result = this.subtypes.get(datatype);
    if (!result) {
      result = [...this.properties.datatypes.values()].filter((candidate) => candidate !== datatype && candidate.isA(datatype.name));
      this.subtypes.set(datatype, result);
    }
    return result;
  }

  keyword(name: string, schema: ScriptSchema | undefined): ScriptKeyword | undefined {
    const key = `${schema ?? ''}\n${name}`;
    if (!this.keywords.has(key)) {
      this.keywords.set(key, this.properties.keyword(name, schema));
    }
    return this.keywords.get(key);
  }

  /** The first datatype declared with the unit suffix. */
  datatypeBySuffix(suffix: string): ScriptDatatype | undefined {
    if (!this.suffixes) {
      this.suffixes = new Map();
      for (const datatype of this.properties.datatypes.values()) {
        if (datatype.suffix !== undefined && !this.suffixes.has(datatype.suffix)) {
          this.suffixes.set(datatype.suffix, datatype);
        }
      }
    }
    return this.suffixes.get(suffix);
  }

  private ownerIndex(owner: ChainOwner): OwnerIndex {
    const key = owner.kind === 'keyword' ? owner.keyword : owner.kind === 'datatype' ? owner.datatype : null;
    let index = this.owners.get(key);
    if (!index) {
      index = { literal: new Map(), wildcard: [] };
      let order = 0;
      for (const property of propertiesOf(owner, this.properties)) {
        const entry: IndexedProperty = { property, order: order++ };
        const first = property.segments[0];
        if (first?.kind === 'literal') {
          const bucket = index.literal.get(first.text);
          if (bucket) {
            bucket.push(entry);
          } else {
            index.literal.set(first.text, [entry]);
          }
        } else {
          index.wildcard.push(entry);
        }
      }
      this.owners.set(key, index);
    }
    return index;
  }

  /** The owner's properties whose first segment can match the step, in the owner's order. */
  *candidates(owner: ChainOwner, step: ChainStep): IterableIterator<ScriptProperty> {
    const index = this.ownerIndex(owner);
    const literal = step.kind === 'identifier' ? (index.literal.get(step.text) ?? []) : [];
    const wildcard = index.wildcard;
    let atLiteral = 0;
    let atWildcard = 0;
    while (atLiteral < literal.length || atWildcard < wildcard.length) {
      if (atWildcard >= wildcard.length || (atLiteral < literal.length && literal[atLiteral].order < wildcard[atWildcard].order)) {
        yield literal[atLiteral++].property;
      } else {
        yield wildcard[atWildcard++].property;
      }
    }
  }
}

const indexes = new WeakMap<ScriptProperties, ResolverIndex>();

function indexOf(properties: ScriptProperties): ResolverIndex {
  let index = indexes.get(properties);
  if (!index) {
    index = new ResolverIndex(properties);
    indexes.set(properties, index);
  }
  return index;
}

/**
 * Properties an owner offers: its own and inherited ones, then those of its subtypes, because a value of
 * a static type is often a more specific object at run time (`this.assignedcontrolled.cargo` works on a
 * ship). All properties of all datatypes when the owner is unknown.
 */
export function* propertiesOf(owner: ChainOwner, properties: ScriptProperties): IterableIterator<ScriptProperty> {
  switch (owner.kind) {
    case 'keyword':
      yield* owner.keyword.allProperties();
      if (owner.keyword.type) {
        yield* subtypeProperties(owner.keyword.type, properties);
      }
      break;
    case 'datatype':
      yield* owner.datatype.allProperties();
      yield* subtypeProperties(owner.datatype, properties);
      break;
    case 'unknown':
      for (const datatype of properties.datatypes.values()) {
        yield* datatype.properties.values();
      }
      break;
  }
}

/** Own properties of every datatype that derives from the given one. */
function* subtypeProperties(datatype: ScriptDatatype, properties: ScriptProperties): IterableIterator<ScriptProperty> {
  for (const candidate of indexOf(properties).subtypesOf(datatype)) {
    yield* candidate.properties.values();
  }
}

/** The datatype all candidates agree on, when they do. */
function commonType(candidates: readonly ScriptProperty[], properties: ScriptProperties): ScriptDatatype | undefined {
  const type = candidates[0].type;
  if (type === undefined || candidates.some((candidate) => candidate.type !== type)) {
    return undefined;
  }
  return properties.datatype(type);
}

/** Resolves the steps of a chain against the script properties. */
export function resolveChain(chain: PropertyChain, properties: ScriptProperties, schema: ScriptSchema): ResolvedChain {
  const steps = chain.steps;
  const resolved: ResolvedStep[] = steps.map((step) => ({ step }));
  // owners[i] is what steps[i] is looked up on; the head has no owner.
  const owners: ChainOwner[] = new Array<ChainOwner>(steps.length + 1).fill(unknownOwner);
  if (steps.length === 0) {
    return { steps: resolved, owners };
  }
  const resolver = indexOf(properties);
  const head = steps[0];
  let owner: ChainOwner = unknownOwner;
  if (head.kind === 'identifier') {
    const keyword = resolver.keyword(head.text, schema);
    if (keyword) {
      resolved[0].keyword = keyword;
      resolved[0].datatype = keyword.type;
      owner = { kind: 'keyword', keyword };
    }
  } else if (head.kind !== 'variable' && head.kind !== 'parens') {
    const datatype = literalDatatype(head, properties);
    resolved[0].datatype = datatype;
    owner = ownerOfDatatype(datatype);
  }

  let index = 1;
  while (index < steps.length) {
    let best: ScriptProperty | undefined;
    let bestLength = 0;
    let candidates: ScriptProperty[] = [];
    // Strict matches first, then bare names for free placeholders, then a chain that ends inside a pattern.
    for (const [lenient, prefix] of matchPasses) {
      candidates = [];
      for (const property of resolver.candidates(owner, steps[index])) {
        const length = matchLength(property, steps, index, properties, schema, lenient, prefix);
        if (length < 0) {
          continue;
        }
        if (owner.kind === 'unknown') {
          candidates.push(property);
        }
        if (!best || length > bestLength || (length === bestLength && literalCount(property) > literalCount(best))) {
          best = property;
          bestLength = length;
        }
      }
      if (best) {
        break;
      }
    }
    if (best && owner.kind === 'unknown') {
      // Any datatype may fit: the longest matches count, and only one of them may be adopted.
      const longest = candidates.filter((candidate) => candidate.segments.length === bestLength);
      if (longest.length > 1) {
        for (let covered = index; covered < index + bestLength; covered++) {
          resolved[covered].candidates = longest;
          owners[covered] = owner;
        }
        const datatype = bestLength === longest[0].segments.length ? commonType(longest, properties) : undefined;
        resolved[index + bestLength - 1].datatype = datatype;
        owner = ownerOfDatatype(datatype);
        index += bestLength;
        continue;
      }
      best = longest[0];
    }
    if (best) {
      for (let covered = index; covered < index + bestLength; covered++) {
        resolved[covered].property = best;
        owners[covered] = owner;
      }
      // A chain that stops inside a pattern yields an intermediate value, not the property's type.
      const complete = bestLength === best.segments.length;
      const datatype = complete && best.type !== undefined ? properties.datatype(best.type) : undefined;
      resolved[index + bestLength - 1].datatype = datatype;
      owner = ownerOfDatatype(datatype);
      index += bestLength;
      continue;
    }
    owners[index] = owner;
    owner = unknownOwner;
    index++;
  }
  // The owner after the last step is what a following segment would be looked up on.
  owners[steps.length] = owner;
  return { steps: resolved, owners };
}

/** A completion offered for the segment at the caret. */
export interface SegmentCompletion {
  /** Text of the segment: a literal, `{$type}` for an expression placeholder, or a bare value of an enumeration keyword. */
  label: string;
  /** The property the segment belongs to; several properties may share a segment, the first one is kept. */
  property: ScriptProperty;
  /** For a bare enumeration value, the keyword property that defines it. */
  value?: ScriptProperty;
  /** True when the property name has more segments after this one. */
  continues: boolean;
}

/** Renders a pattern segment the way it is completed. */
function segmentLabel(segment: PropertySegment): string {
  switch (segment.kind) {
    case 'literal':
      return segment.text;
    case 'expression':
      return `{$${segment.type}}`;
    case 'variable':
      return '$';
    case 'any':
      return `<${segment.name}>`;
    case 'args':
      return segment.text;
  }
}

/**
 * Completions for the partial segment of a chain: the next segment of every property whose earlier
 * segments match the written steps, from every position where the owner is known. Bare values of an
 * enumeration keyword are offered for expression placeholders such as `{$class}`.
 */
export function completeChain(chain: PropertyChain, properties: ScriptProperties, schema: ScriptSchema): SegmentCompletion[] {
  const partial = chain.partial?.text ?? '';
  const steps = chain.steps;
  const { owners } = resolveChain(chain, properties, schema);
  const results = new Map<string, SegmentCompletion>();
  const offer = (label: string, property: ScriptProperty, continues: boolean, value?: ScriptProperty): void => {
    if (!label.startsWith(partial) || results.has(label)) {
      return;
    }
    const completion: SegmentCompletion = { label, property, continues };
    if (value) {
      completion.value = value;
    }
    results.set(label, completion);
  };
  const at = steps.length;
  const positions = [...Array(at).keys()].map((index) => index + 1).filter((from) => owners[from].kind !== 'unknown');
  if (positions.length === 0 && owners[at].kind === 'unknown') {
    // Nothing is known about the chain: offer the first segment of every property of every datatype.
    positions.push(at);
  }
  for (const from of positions) {
    const owner = owners[from];
    const matched = at - from;
    for (const property of propertiesOf(owner, properties)) {
      const segments = property.segments;
      if (segments.length <= matched) {
        continue;
      }
      let fits = true;
      for (let index = 0; index < matched && fits; index++) {
        fits = segmentMatches(segments[index], steps[from + index], properties, schema, true);
      }
      if (!fits) {
        continue;
      }
      const next = segments[matched];
      const continues = matched + 1 < segments.length;
      if (next.kind === 'any') {
        // A free name cannot be completed; the values of its keyword can.
        const keyword = keywordForPlaceholder(next.name, property, properties, schema);
        for (const value of keyword?.properties.values() ?? []) {
          if (isConcreteValue(value)) {
            offer(value.name, property, continues, value);
          }
        }
        continue;
      }
      if (next.kind === 'args') {
        continue;
      }
      offer(segmentLabel(next), property, continues);
      if (next.kind === 'expression') {
        const keyword = properties.keyword(next.type, schema);
        for (const value of keyword?.properties.values() ?? []) {
          if (isConcreteValue(value)) {
            offer(value.name, property, continues, value);
          }
        }
      }
    }
  }
  return [...results.values()];
}
