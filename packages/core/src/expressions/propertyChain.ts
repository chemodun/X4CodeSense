/**
 * Property chains in expressions: `player.ship.cargo.{$ware}.count`, `$target.isclass.ship`, `'%s'.[$x]`.
 *
 * `chainAtCaret` and `chainAtToken` cut the chain around a position out of the token stream, and
 * `resolveChain` walks it against the script properties: the head is a keyword, a variable or a literal,
 * every further step matches a segment of a property name pattern of the current datatype. Property names
 * can span several steps (`cargo.{$ware}.count`); a placeholder segment such as `{$class}` accepts a
 * braced expression, and a bare value only where the script properties declare a shortcut for it
 * (`isclass.<classname>`).
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
const openers: Record<string, string> = { lbrace: 'rbrace', lbracket: 'rbracket', lparen: 'rparen' };
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

/** Index of the closing token matching the opening token at `index`, or -1. */
function closerOf(tokens: readonly Token[], index: number): number {
  const opening = tokens[index].kind;
  const closing = openers[opening];
  let depth = 0;
  for (let position = index; position < tokens.length; position++) {
    const kind = tokens[position].kind;
    if (kind === opening) {
      depth++;
    } else if (kind === closing) {
      depth--;
      if (depth === 0) {
        return position;
      }
    }
  }
  return -1;
}

/** The last token of the chain that the step ending at token `index` belongs to: the steps after it included. */
function chainEnd(tokens: readonly Token[], index: number): number {
  let last = index;
  while (tokens[last + 1]?.kind === 'dot' && tokens[last + 2] && stepKinds[tokens[last + 2].kind]) {
    const next = last + 2;
    const close = tokens[next].kind in openers ? closerOf(tokens, next) : next;
    if (close < 0) {
      break;
    }
    last = close;
  }
  return last;
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
 * The steps after it are included: a property name may go on after it (`mayattack.{$faction}`), and
 * without them the step could match another property that ends there.
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
  const steps = withTexts(expression, collectSteps(tokens, chainEnd(tokens, index)));
  const stepIndex = steps.findIndex((step) => step.start <= token.start && token.end <= step.end);
  if (stepIndex < 0) {
    return undefined;
  }
  return { chain: { steps }, stepIndex };
}

/** What a step of a chain resolved to. */
export interface ResolvedStep {
  step: ChainStep;
  /** The keyword, for a head that names one. */
  keyword?: ScriptKeyword;
  /** The property whose name pattern covers this step; the same property on every step it spans. */
  property?: ScriptProperty;
  /**
   * Properties that would match here: of any datatype, when the owner type was unknown and several fit;
   * of other names that fit as well as `property`, when the owner is known (`mayattack.{$component}` and
   * `mayattack.{$faction}` for `mayattack.{$x}`).
   */
  candidates?: ScriptProperty[];
  /** Datatype of the value after this step, when known. */
  datatype?: ScriptDatatype;
  /** True for a variable step whose datatype is the variable's type (`StepTypes`). */
  fromVariable?: boolean;
}

/**
 * The type of a variable a step of a chain names (`$ship` at its head, `this.$ship`), from what the script
 * sets it to; undefined when not known. Asked for variable steps only.
 */
export type StepTypes = (index: number, steps: readonly ChainStep[]) => ScriptDatatype | undefined;

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

/**
 * Units of the expression language that scale another (the Mission Director guide's `1km`, `500ms`,
 * `1h`, `45deg`, `1000Cr`): their numbers are of the datatype whose suffix is the unit they scale.
 */
const scaledUnits: Readonly<Record<string, string>> = { km: 'm', ms: 's', min: 's', h: 's', deg: 'rad', Cr: 'ct', LF: 'F' };

/** The datatype of a number with a unit suffix, `10km` a length; undefined for a suffix no datatype declares. */
export function datatypeOfUnit(suffix: string, properties: ScriptProperties): ScriptDatatype | undefined {
  return indexOf(properties).datatypeBySuffix(scaledUnits[suffix] ?? suffix);
}

/** Datatype of a literal head. A number without a unit is an integer, or a float with a fraction or exponent. */
function literalDatatype(step: ChainStep, properties: ScriptProperties): ScriptDatatype | undefined {
  switch (step.kind) {
    case 'string':
    case 'braces':
      return properties.datatype('string');
    case 'brackets':
      return properties.datatype('list');
    case 'number': {
      const fraction = !/^0x/i.test(step.text) && /[.eE]/.test(step.text);
      const suffix = step.suffix !== '' ? step.suffix : fraction ? 'f' : 'i';
      return datatypeOfUnit(suffix, properties) ?? (step.suffix === '' ? properties.datatype('numeric') : undefined);
    }
    default:
      return undefined;
  }
}

/**
 * True when a written step fits a segment of a property name pattern. A `{$type}` placeholder takes a
 * braced expression; a bare value of the lookup of that type only where the script properties declare a
 * shortcut for it, `isclass.<classname>` beside `isclass.{$class}`, so `mayattack.{$faction}` takes no
 * `argon`. When `lenient`, a bare name fits a placeholder of an id that is neither a lookup nor a
 * datatype, as the game's scripts write them (`project.agr_fields_sunrise`, `stat.population`); a bare
 * name is no number, string, list or object, so `cargo.frob` is no `cargo.{$numeric}`. Strict matches
 * are tried first, so `dock.container` is the `dock` property followed by `container`, not
 * `dock.{$docksize}`.
 */
export function segmentMatches(segment: PropertySegment, step: ChainStep, properties: ScriptProperties, schema: ScriptSchema, lenient = false): boolean {
  switch (segment.kind) {
    case 'literal':
      return step.kind === 'identifier' && step.text === segment.text;
    case 'expression':
      if (step.kind === 'braces' || step.kind === 'brackets') {
        return true;
      }
      return step.kind === 'identifier' && lenient && !indexOf(properties).keyword(segment.type, schema) && !properties.datatype(segment.type);
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

/**
 * True when two properties have the same kinds of segments, so that they are variants of one pattern:
 * `mayattack.{$component}` and `mayattack.{$faction}`, not `isclass.{$class}` and the shortcut
 * `isclass.<classname>`.
 */
function sameShape(a: ScriptProperty, b: ScriptProperty): boolean {
  return a.segments.length === b.segments.length && a.segments.every((segment, index) => segment.kind === b.segments[index].kind);
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

/** Resolves the steps of a chain against the script properties; with `stepTypes`, variables of known type as values of that type. */
export function resolveChain(chain: PropertyChain, properties: ScriptProperties, schema: ScriptSchema, stepTypes?: StepTypes): ResolvedChain {
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
  const variableType = (index: number): ScriptDatatype | undefined => (stepTypes && steps[index].kind === 'variable' ? stepTypes(index, steps) : undefined);
  const headType = variableType(0);
  if (headType) {
    resolved[0].datatype = headType;
    resolved[0].fromVariable = true;
    owner = { kind: 'datatype', datatype: headType };
  } else if (head.kind === 'identifier') {
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
    // `this.$ship`: a variable of the cue's table, not a property of the cue.
    const typed = variableType(index);
    if (typed) {
      resolved[index].datatype = typed;
      resolved[index].fromVariable = true;
      owners[index] = owner;
      owner = { kind: 'datatype', datatype: typed };
      index++;
      continue;
    }
    let best: ScriptProperty | undefined;
    let bestLength = 0;
    let candidates: ScriptProperty[] = [];
    // Properties of other names that match as well as the best one: `mayattack.{$faction}` beside `mayattack.{$component}`.
    let ties: ScriptProperty[] = [];
    // Complete matches that yield a list or a table, by the steps they cover: a braced step after one may be its index.
    let collections = new Map<number, ScriptProperty>();
    // Strict matches first, then bare names for free placeholders, then a chain that ends inside a pattern.
    for (const [lenient, prefix] of matchPasses) {
      candidates = [];
      ties = [];
      collections = new Map();
      for (const property of resolver.candidates(owner, steps[index])) {
        const length = matchLength(property, steps, index, properties, schema, lenient, prefix);
        if (length < 0) {
          continue;
        }
        if (owner.kind === 'unknown') {
          candidates.push(property);
        }
        if (length === property.segments.length && (property.type === 'list' || property.type === 'table') && !collections.has(length)) {
          collections.set(length, property);
        }
        if (!best || length > bestLength || (length === bestLength && literalCount(property) > literalCount(best))) {
          best = property;
          bestLength = length;
          ties = [property];
        } else if (length === bestLength && sameShape(property, best) && !ties.some((tie) => tie.name === property.name)) {
          ties.push(property);
        }
      }
      if (best) {
        break;
      }
    }
    if (best && owner.kind === 'unknown') {
      // Any datatype may fit: the longest matches count, and only one of them may be adopted.
      const shape = best;
      const longest = candidates.filter((candidate) => candidate.segments.length === bestLength && sameShape(candidate, shape));
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
    // `$ship.subordinates.{$i}`: the `$i`-th of the list `subordinates`, or `subordinates.{$assignment}`; which
    // one the braced expression gives is not known here, so both are candidates and the type after is not.
    const collection =
      best && bestLength > 1 && bestLength === best.segments.length && steps[index + bestLength - 1].kind === 'braces'
        ? collections.get(bestLength - 1)
        : undefined;
    if (best && collection) {
      for (let covered = index; covered < index + bestLength; covered++) {
        resolved[covered].candidates = [collection, best];
        owners[covered] = owner;
      }
      owner = unknownOwner;
      index += bestLength;
      continue;
    }
    if (best) {
      // The first property decides the type; the others that fit as well are shown beside it.
      const others = owner.kind !== 'unknown' && ties.length > 1 ? ties : undefined;
      for (let covered = index; covered < index + bestLength; covered++) {
        resolved[covered].property = best;
        if (others) {
          resolved[covered].candidates = others;
        }
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
 * segments match the written steps, from every position where the owner is known, and from every name
 * written on an unknown owner that a property starts with. Bare values of a lookup are offered where a
 * shortcut takes them, `isclass.<classname>`; a placeholder such as `{$faction}` is offered as `{…}`.
 */
export function completeChain(chain: PropertyChain, properties: ScriptProperties, schema: ScriptSchema, stepTypes?: StepTypes): SegmentCompletion[] {
  const partial = chain.partial?.text ?? '';
  const steps = chain.steps;
  const { owners } = resolveChain(chain, properties, schema, stepTypes);
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
  /** The next segments of the properties looked up at step `from`; with `named`, only those whose name starts with that step. */
  const offerFrom = (from: number, named?: string): void => {
    const owner = owners[from];
    const matched = at - from;
    for (const property of propertiesOf(owner, properties)) {
      const segments = property.segments;
      if (segments.length <= matched) {
        continue;
      }
      if (named !== undefined && (segments[0].kind !== 'literal' || segments[0].text !== named)) {
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
      // Bare values come from the shortcut the script properties declare beside it, `isclass.<classname>`.
      offer(segmentLabel(next), property, continues);
    }
  };
  const froms = [...Array(at).keys()].map((index) => index + 1);
  const known = froms.filter((from) => owners[from].kind !== 'unknown');
  for (const from of known) {
    offerFrom(from);
  }
  // On an unknown owner, a property of any datatype that starts with the name written there goes on:
  // `$x.mayattack.` offers `{$component}` and `{$faction}`.
  for (const from of froms.filter((from) => from < at && owners[from].kind === 'unknown' && steps[from].kind === 'identifier')) {
    offerFrom(from, steps[from].text);
  }
  if (known.length === 0 && owners[at].kind === 'unknown' && results.size === 0) {
    // Nothing is known about the chain and no property goes on from a name in it: the first segment of every property of every datatype.
    offerFrom(at);
  }
  return [...results.values()];
}
