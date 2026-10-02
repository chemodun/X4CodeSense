/**
 * Semantic highlighting of script and patch documents.
 *
 * An editor colours XML with its grammar, which sees an attribute value as a string: an expression such as
 * `$ship.owner == faction.player` is one colour. The tokens here say what an expression holds, as the
 * analysis understands it, and mark the names of cues, labels and interrupt library items where they are
 * defined or referenced:
 *
 * - `$name`: a variable of a script, cue or library table (`variable`; `modification` where it is set or
 *   removed, `declaration` for a `<param>`), or a key of a value or of a table (`property`: `$ship.$x`,
 *   `table[$key = 1]`);
 * - a keyword of the script properties (`this`, `player`, `faction`, `md`, `true`), `if`, `then`, `else`
 *   and `table`: `keyword`; the word operators (`and`, `not`, `lt`, `typeof`, ...), the symbols and the
 *   punctuation: `operator`, which themes colour like punctuation in code;
 * - a step after a dot: `property`; `enumMember` for a value of a lookup (`faction.argon`, `class.ship`,
 *   `isclass.ship`); `namespace` for the script and the cue of `md.Script.Cue`;
 * - a bare name that is a whole value and no keyword or cue: `enumMember`, a value the attribute takes as
 *   is (`position="top_right"`, a macro, a sound);
 * - cue and library names (`namespace`), labels (`label`) and interrupt library items (`function`), with
 *   `declaration` where they are defined; the name of a function call (`function`); the root's name of a
 *   Mission Director script (`namespace`, `declaration`);
 * - numbers with their unit, and strings; a unit after a parenthesis (`($x)s`) as a number.
 *
 * What the analysis cannot place, such as a name inside an expression that is no keyword or an unknown
 * character, gets no token and keeps the grammar's colour, as do plain attribute values. Without the
 * game's schemas no attribute is known to hold an expression, so there are no tokens. In a patch
 * document, what lands in the target is classified there and the tokens are taken back to the patch; its
 * own attributes (`sel`) get none.
 */
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { SemanticTokensLegend } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { declarationOf } from '../analysis/positionContext';
import { isChainNode, resolvedChainOf, stepsOf } from '../expressions/astChain';
import { parsedValue } from '../expressions/attributeExpression';
import type { Token } from '../expressions/lexer';
import { walkExpression, type Expression } from '../expressions/parser';
import { keywordForPlaceholder, type ChainOwner, type StepTypes } from '../expressions/propertyChain';
import type { GameData } from '../gameData';
import type { NamedItemKind, NamedOccurrence } from '../names/namedItems';
import { overlapsPieceOf, sourceRange } from '../patches/patchedDocument';
import type { PropertySegment, ScriptProperties, ScriptProperty } from '../properties/scriptProperties';
import type { ScriptSchema } from '../types';
import { stepTypesIn, type VariableOccurrence } from '../variables/variables';
import { offsetInValue, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';
import { isExpressionAttribute, type XsdAttribute, type XsdSchema } from '../xsd/schema';
import { patchedViewOf } from './patchContent';

/** The token types, in the order of the legend. */
export const semanticTokenTypes = ['namespace', 'function', 'label', 'variable', 'property', 'enumMember', 'keyword', 'number', 'string', 'operator'] as const;

export type SemanticTokenType = (typeof semanticTokenTypes)[number];

/** The token modifiers, in the order of the legend. */
export const semanticTokenModifiers = ['declaration', 'modification'] as const;

export type SemanticTokenModifier = (typeof semanticTokenModifiers)[number];

/** The legend a server announces; the numbers of `PositionedToken` refer to it. */
export const semanticTokensLegend: SemanticTokensLegend = { tokenTypes: [...semanticTokenTypes], tokenModifiers: [...semanticTokenModifiers] };

export interface SemanticToken {
  /** Text offsets in the document. */
  start: number;
  end: number;
  type: SemanticTokenType;
  modifier?: SemanticTokenModifier;
}

/** A token as the protocol takes it: on one line, its type and modifiers as numbers of the legend. */
export interface PositionedToken {
  line: number;
  character: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

type Classification = Pick<SemanticToken, 'type' | 'modifier'>;

const namedItemTypes: Record<NamedItemKind, SemanticTokenType> = {
  cue: 'namespace',
  label: 'label',
  actions: 'function',
  handler: 'function',
  conditions: 'function',
};

/** Reserved words that are syntax; the others (`and`, `or`, `not`, `typeof`, `lt`, ...) are operators. */
const syntaxWords: ReadonlySet<string> = new Set(['if', 'then', 'else']);

const asKeyword: Classification = { type: 'keyword' };
const asOperator: Classification = { type: 'operator' };
const asProperty: Classification = { type: 'property' };
const asValue: Classification = { type: 'enumMember' };
const asNamespace: Classification = { type: 'namespace' };
const asFunction: Classification = { type: 'function' };
const asNumber: Classification = { type: 'number' };
const asString: Classification = { type: 'string' };

/** The trimmed raw value of an attribute as text offsets, or undefined when it is empty. */
function trimmedValue(attribute: XmlAttribute): { start: number; end: number } | undefined {
  const raw = attribute.rawValue;
  const value = raw.trim();
  if (value === '') {
    return undefined;
  }
  const start = attribute.valueStart + raw.indexOf(value);
  return { start, end: start + value.length };
}

const noOccurrences: readonly never[] = [];

class Classifier {
  readonly tokens: SemanticToken[] = [];
  private readonly namesByAttribute = new Map<XmlAttribute, NamedOccurrence[]>();
  private readonly variablesByAttribute = new Map<XmlAttribute, VariableOccurrence[]>();
  private readonly expressionAttributes = new Map<XsdAttribute, boolean>();
  private readonly placeholderValues = new Map<string, boolean>();

  /** `include` tells the text ranges to classify: a start tag, a value. */
  constructor(
    private readonly analysis: DocumentAnalysis,
    private readonly schema: ScriptSchema,
    private readonly xsd: XsdSchema,
    private readonly properties: ScriptProperties | undefined,
    private readonly include: (start: number, end: number) => boolean
  ) {
    for (const occurrence of analysis.names?.occurrences ?? []) {
      if (include(occurrence.start, occurrence.end)) {
        Classifier.file(this.namesByAttribute, occurrence.attribute, occurrence);
      }
    }
    for (const occurrence of analysis.variables?.occurrences ?? []) {
      if (include(occurrence.start, occurrence.end)) {
        Classifier.file(this.variablesByAttribute, occurrence.attribute, occurrence);
      }
    }
  }

  private static file<T>(map: Map<XmlAttribute, T[]>, attribute: XmlAttribute, item: T): void {
    const list = map.get(attribute);
    if (list) {
      list.push(item);
    } else {
      map.set(attribute, [item]);
    }
  }

  private push(start: number, end: number, classification: Classification): void {
    if (end > start) {
      this.tokens.push({ start, end, ...classification });
    }
  }

  /** Classifies the attribute values `include` takes, in the start tags it takes. */
  classify(): void {
    const root = this.analysis.structure?.roots[0];
    for (const element of this.analysis.structure?.elements ?? []) {
      if (element.attributes.length === 0 || !this.include(element.start, element.startTagEnd)) {
        continue;
      }
      let declaration: ReturnType<typeof declarationOf> | null = null;
      for (const attribute of element.attributes) {
        if (attribute.quote === '' || attribute.valueEnd === attribute.valueStart || !this.include(attribute.valueStart, attribute.valueEnd)) {
          continue;
        }
        // Looked up once per element, and only for elements with a value to classify.
        if (declaration === null) {
          declaration = declarationOf(this.analysis, element, this.xsd);
        }
        const declared = declaration?.attributes.get(attribute.name);
        if (declared && this.isExpression(declared)) {
          this.expression(attribute);
        } else {
          this.plain(element, attribute, element === root);
        }
      }
    }
  }

  private isExpression(declared: XsdAttribute): boolean {
    let expression = this.expressionAttributes.get(declared);
    if (expression === undefined) {
      expression = isExpressionAttribute(declared);
      this.expressionAttributes.set(declared, expression);
    }
    return expression;
  }

  /** A value that is no expression: the named items and parameters defined or referenced in it. */
  private plain(element: XmlElement, attribute: XmlAttribute, isRoot: boolean): void {
    if (isRoot && this.schema === 'md' && element.name === 'mdscript' && attribute.name === 'name') {
      const value = trimmedValue(attribute);
      if (value) {
        this.push(value.start, value.end, { type: 'namespace', modifier: 'declaration' });
      }
      return;
    }
    for (const occurrence of this.namesByAttribute.get(attribute) ?? []) {
      this.push(occurrence.start, occurrence.end, this.named(occurrence));
    }
    for (const occurrence of this.variablesByAttribute.get(attribute) ?? []) {
      // A `<param name="x">`: its occurrence spans the raw value.
      const value = trimmedValue(attribute);
      if (value && value.start >= occurrence.start && value.end <= occurrence.end) {
        this.push(value.start, value.end, this.variable(occurrence));
      }
    }
  }

  private named(occurrence: NamedOccurrence): Classification {
    const type = namedItemTypes[occurrence.kind];
    return occurrence.role === 'definition' ? { type, modifier: 'declaration' } : { type };
  }

  private variable(occurrence: VariableOccurrence): Classification {
    if (occurrence.kind === 'reference') {
      return { type: 'variable' };
    }
    const declared = occurrence.kind === 'definition' && occurrence.element.name === 'param' && occurrence.attribute.name === 'name';
    return { type: 'variable', modifier: declared ? 'declaration' : 'modification' };
  }

  private expression(attribute: XmlAttribute): void {
    const text = attribute.value;
    if (text.trim() === '') {
      return;
    }
    const parsed = parsedValue(attribute);
    const documentVariables = this.analysis.variables;
    const roles = this.roles(
      parsed.expression,
      text,
      documentVariables && this.properties ? stepTypesIn(documentVariables, attribute.element, this.properties) : undefined
    );
    const whole = parsed.expression;
    // The tree is the first expression of the value: with errors, more may follow it.
    if (whole.kind === 'name' && parsed.errors.length === 0 && !roles.has(whole.start)) {
      // A bare name the attribute takes as is, unless it is a cue: a value of its enumeration (`position="top_right"`), a macro, a sound.
      roles.set(whole.start, asValue);
    }
    const names = this.namesByAttribute.get(attribute) ?? noOccurrences;
    const variables = this.variablesByAttribute.get(attribute) ?? noOccurrences;
    for (const token of parsed.tokens) {
      const start = offsetInValue(attribute, token.start);
      const classification = this.token(token, start, roles, names, variables);
      if (classification) {
        this.push(start, offsetInValue(attribute, token.end), classification);
      }
    }
  }

  private token(
    token: Token,
    start: number,
    roles: ReadonlyMap<number, Classification>,
    names: readonly NamedOccurrence[],
    variables: readonly VariableOccurrence[]
  ): Classification | undefined {
    switch (token.kind) {
      case 'variable': {
        const variable = variables.find((occurrence) => occurrence.start === start);
        // Not a variable of a table: a key of a value (`$ship.$x`) or of a table literal.
        return variable ? this.variable(variable) : asProperty;
      }
      case 'identifier': {
        const named = names.find((occurrence) => occurrence.start === start);
        if (named) {
          return this.named(named);
        }
        // A `<param name="x">` whose name the schema types as an expression.
        const variable = variables.find((occurrence) => occurrence.start === start);
        return variable ? this.variable(variable) : roles.get(token.start);
      }
      case 'reserved':
        return syntaxWords.has(token.text) ? asKeyword : asOperator;
      case 'number':
        return asNumber;
      case 'string':
        return asString;
      case 'unknown':
        return undefined;
      default:
        return asOperator;
    }
  }

  /** What the identifiers of an expression are, by their start in the value: keywords, chain steps, calls, units. */
  private roles(expression: Expression, text: string, stepTypes: StepTypes | undefined): Map<number, Classification> {
    const roles = new Map<number, Classification>();
    const inner = new Set<Expression>();
    walkExpression(expression, (node) => {
      switch (node.kind) {
        case 'name':
          if (this.properties?.keyword(node.name, this.schema)) {
            roles.set(node.start, asKeyword);
          }
          break;
        case 'call':
          roles.set(node.nameStart, asFunction);
          break;
        case 'table':
          roles.set(node.start, asKeyword);
          break;
        case 'cast':
          roles.set(node.end - node.suffix.length, asNumber);
          break;
        case 'property':
        case 'dynamic':
        case 'args':
          // Parents come first: a chain's object is marked before it is visited, so each chain is resolved once, whole.
          if (!inner.has(node)) {
            this.chainRoles(node, text, roles, stepTypes);
          }
          if (isChainNode(node.object)) {
            inner.add(node.object);
          }
          break;
        default:
          break;
      }
    });
    return roles;
  }

  /** The steps of a chain after its head: each property covers as many steps as it has segments. */
  private chainRoles(outer: Expression, text: string, roles: Map<number, Classification>, stepTypes: StepTypes | undefined): void {
    // Resolved by the expression checks already, in an analysis that ran them with the same types.
    const { steps, resolved } = this.properties
      ? resolvedChainOf(outer, text, this.properties, this.schema, stepTypes)
      : { ...stepsOf(outer, text), resolved: undefined };
    let index = 1;
    while (index < steps.length) {
      // On a value of unknown type several properties may fit; they cover the same steps.
      const property = resolved?.steps[index].property ?? resolved?.steps[index].candidates?.[0];
      const covered = property ? Math.min(property.segments.length, steps.length - index) : 1;
      for (let offset = 0; offset < covered; offset++) {
        const step = steps[index + offset];
        if (step.kind === 'identifier') {
          roles.set(step.start, property && resolved ? this.step(property, property.segments[offset], resolved.owners[index + offset]) : asProperty);
        }
      }
      index += covered;
    }
  }

  /**
   * A name step of a property: a value of a lookup keyword (`faction.argon`, `macro.<macroname>`: a
   * property the keyword has itself, whose value is of the keyword's name), a bare value standing for a
   * typed value (`isclass.ship` for `isclass.{$class}`), a value of another keyword a placeholder names
   * (`hastag.<tagname>`), a script or cue a placeholder of a cue property names
   * (`md.<mdscriptname>.<cuename>`), or a property (`param.<categoryname>.<paramname>`).
   */
  private step(property: ScriptProperty, segment: PropertySegment, owner: ChainOwner): Classification {
    const lookupValue = owner.kind === 'keyword' && property.owner === owner.keyword && property.type === owner.keyword.name;
    switch (segment.kind) {
      case 'literal':
        return lookupValue ? asValue : asProperty;
      case 'expression':
        return asValue;
      case 'any': {
        if (property.type === 'cue') {
          return asNamespace;
        }
        if (owner.kind === 'keyword' && property.owner === owner.keyword) {
          return lookupValue ? asValue : asProperty;
        }
        const key = `${property.name}\n${segment.name}`;
        let value = this.placeholderValues.get(key);
        if (value === undefined) {
          value = this.properties !== undefined && keywordForPlaceholder(segment.name, property, this.properties, this.schema) !== undefined;
          this.placeholderValues.set(key, value);
        }
        return value ? asValue : asProperty;
      }
      default:
        return asProperty;
    }
  }
}

/** Sorted by start, with any token that overlaps the one before it left out. */
function ordered(tokens: SemanticToken[]): SemanticToken[] {
  // A script's tokens come in text order and apart; a patch's come in the order of its target.
  if (tokens.every((token, index) => index === 0 || token.start >= tokens[index - 1].end)) {
    return tokens;
  }
  tokens.sort((a, b) => a.start - b.start || a.end - b.end);
  const result: SemanticToken[] = [];
  let end = -1;
  for (const token of tokens) {
    if (token.start >= end) {
      result.push(token);
      end = token.end;
    }
  }
  return result;
}

function scriptTokens(analysis: DocumentAnalysis, game: GameData | undefined, include: (start: number, end: number) => boolean): SemanticToken[] {
  const schema = analysis.detection.script?.schema;
  const xsd = schema && game?.schemas.schemas[schema];
  if (!schema || !xsd) {
    return [];
  }
  const classifier = new Classifier(analysis, schema, xsd, game.properties, include);
  classifier.classify();
  return classifier.tokens;
}

/**
 * The semantic tokens of a script or patch document, sorted and apart, with text offsets; undefined for
 * other documents, which other tooling colours. With `range` (text offsets), only the attribute values
 * that reach into it are classified.
 */
export function semanticTokens(analysis: DocumentAnalysis, game: GameData | undefined, range?: { start: number; end: number }): SemanticToken[] | undefined {
  if (!analysis.structure) {
    return undefined;
  }
  const reaches = (start: number, end: number): boolean => range === undefined || (start <= range.end && end >= range.start);
  if (!analysis.detection.isDiff) {
    return ordered(scriptTokens(analysis, game, reaches));
  }
  const view = patchedViewOf(analysis);
  if (!view) {
    return [];
  }
  // The patched target is classified only where the patch's own text lies in it.
  const touched = overlapsPieceOf(view.written, view.source);
  const tokens: SemanticToken[] = [];
  for (const token of scriptTokens(view.analysis, game, (start, end) => end > start && touched(start, end))) {
    const region = sourceRange(view.written, view.source, token.start, token.end);
    if (region && region.end > region.start && reaches(region.start, region.end)) {
      tokens.push({ ...token, start: region.start, end: region.end });
    }
  }
  return ordered(tokens);
}

const typeNumbers = new Map<SemanticTokenType, number>(semanticTokenTypes.map((type, index) => [type, index]));
const modifierBits = new Map<SemanticTokenModifier, number>(semanticTokenModifiers.map((modifier, index) => [modifier, 1 << index]));

/**
 * The tokens as the protocol takes them, in text order: a token that spans lines is split at the line
 * breaks, which it leaves out. The tokens must be sorted, as `semanticTokens` gives them.
 */
export function positionTokens(document: TextDocument, tokens: readonly SemanticToken[]): PositionedToken[] {
  const text = document.getText();
  const lastLine = document.lineCount - 1;
  const result: PositionedToken[] = [];
  // The line of the current offset and where it and the next one start, moved forward only.
  let line = 0;
  let lineStart = 0;
  let nextStart = lastLine > 0 ? document.offsetAt({ line: 1, character: 0 }) : Number.POSITIVE_INFINITY;
  const moveTo = (offset: number): void => {
    while (offset >= nextStart && line < lastLine) {
      line++;
      lineStart = nextStart;
      nextStart = line < lastLine ? document.offsetAt({ line: line + 1, character: 0 }) : Number.POSITIVE_INFINITY;
    }
  };
  for (const token of tokens) {
    const tokenType = typeNumbers.get(token.type) as number;
    const tokenModifiers = token.modifier ? (modifierBits.get(token.modifier) as number) : 0;
    let start = token.start;
    moveTo(start);
    // A token that reaches the start of the next line holds the line break.
    while (token.end >= nextStart) {
      let end = nextStart;
      while (end > start && (text.charCodeAt(end - 1) === 0x0a || text.charCodeAt(end - 1) === 0x0d)) {
        end--;
      }
      if (end > start) {
        result.push({ line, character: start - lineStart, length: end - start, tokenType, tokenModifiers });
      }
      start = nextStart;
      moveTo(start);
    }
    if (token.end > start) {
      result.push({ line, character: start - lineStart, length: token.end - start, tokenType, tokenModifiers });
    }
  }
  return result;
}
