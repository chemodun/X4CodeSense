import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { ScriptProperties } from '../properties/scriptProperties';
import type { TextDatabase } from '../texts/textDatabase';
import type { ScriptSchema } from '../types';
import { stepTypesIn, type DocumentVariables, type VariableType } from '../variables/variables';
import { offsetInValue, type XmlElement } from '../xml/xmlStructure';
import { enumerationsOf, isExpressionAttribute, type XsdElement } from '../xsd/schema';
import { isChainNode, resolvedChainOf, type ChainNode } from './astChain';
import { parsedValue } from './attributeExpression';
import { formatArgumentCount, formatPlaceholders } from './formats';
import { walkExpression, type Expression } from './parser';
import type { ResolvedChain } from './propertyChain';

export type ExpressionDiagnosticCode =
  | 'expression-syntax'
  | 'expression-null-safe-exists'
  | 'expression-text-reference'
  | 'expression-format-specifier'
  | 'expression-unknown-keyword'
  | 'expression-unknown-property'
  | 'expression-unknown-property-guessed';

/** The arguments of a format: fewer than it takes, or more. */
export type FormatDiagnosticCode = 'format-arguments-missing' | 'format-arguments-unused';

export interface ExpressionValidationOptions {
  /** Script properties; without them keywords and properties are not checked. */
  properties?: ScriptProperties;
  /** The texts, for the formats that `{page, id}.[…]` names; without them only formats written as strings are counted. */
  texts?: TextDatabase;
  /** Count the arguments of formats; defaults to true. */
  formats?: boolean;
  /** Script kind of the document, needed for the keyword set. */
  schema?: ScriptSchema;
  /** Names that may start a chain besides keywords: the cues and libraries of the document. */
  knownHeads?: ReadonlySet<string>;
  /** Check only the attributes of the elements for which this holds. */
  checkElement?: (element: XmlElement) => boolean;
  /** The document's variables: a chain on a variable of known type is resolved on that type. */
  variables?: DocumentVariables;
  /**
   * With `variables`, also report properties a variable's type does not have (`$ship.foo` where `$ship` is a
   * ship), also under `@` or tested with `?`: the game gives null or false there instead of an error, and
   * the script still reads what the type does not have. A
   * type the script or the schema states gives a warning; a guessed one information of its own code,
   * `expression-unknown-property-guessed`, whose message says the type is a guess. Without, chains are
   * resolved on the types, and what they lack is not reported.
   */
  typedProperties?: boolean;
  /** Where offsets of the document were written, when that is elsewhere (a patch's target as patched): messages name those lines. */
  origin?: (offset: number) => { line: number; file?: string } | undefined;
}

/**
 * How a variable got its type, for a message: "$ship is a ship, set by set_value at line 12", or for a
 * guess "if $ship is a ship, as guessed from create_ship at line 12". With an origin, the line where the
 * definition was written: "at line 6", or "at line 40 of setup.xml".
 */
export function describeVariableType(name: string, type: VariableType, document: TextDocument, origin?: ExpressionValidationOptions['origin']): string {
  const element = type.definition.element.name;
  const place = origin?.(type.definition.start) ?? { line: document.positionAt(type.definition.start).line };
  const at = `line ${place.line + 1}${place.file === undefined ? '' : ` of ${place.file}`}`;
  const article = /^[aeiou]/i.test(type.name) ? 'an' : 'a';
  if (type.guessed) {
    return `if ${name} is ${article} ${type.name}, as guessed from ${element} at ${at}`;
  }
  const how = type.source === 'param type' ? 'declared by its param' : `set by ${element}`;
  return `${name} is ${article} ${type.name}, ${how} at ${at}`;
}

/**
 * The `data` of a diagnostic on a chain that stops inside a property name, `$table.keys`: what completes it
 * to a property (`.count`, `.list`), for its quick fixes.
 */
export interface PropertyEndings {
  endings: string[];
}

/**
 * Where the chain stops at step `index` inside a property name that goes on with a name, `$table.keys` of
 * `keys.count` and `keys.list`: the first step of that property, the names it may be (those of the
 * properties that fit as well beside it), and the endings that complete them without a placeholder. A
 * chain that stops before a placeholder, `haslicence.<licencetype>` of
 * `haslicence.<licencetype>.{$faction}`, uses the first part of the name and is not reported.
 */
function stoppedInside(resolved: ResolvedChain, index: number): { first: number; names: string[]; endings: string[] } | undefined {
  const property = resolved.steps[index].property;
  if (!property) {
    return undefined;
  }
  let first = index;
  while (first > 1 && resolved.steps[first - 1].property === property && index - first + 1 < property.segments.length) {
    first--;
  }
  const covered = index - first + 1;
  if (covered >= property.segments.length || property.segments[covered].kind !== 'literal') {
    return undefined;
  }
  const names: string[] = [];
  const endings: string[] = [];
  for (const candidate of [property, ...(resolved.steps[index].candidates ?? [])]) {
    if (names.includes(candidate.name) || candidate.segments[covered]?.kind !== 'literal') {
      continue;
    }
    names.push(candidate.name);
    const rest = candidate.segments.slice(covered);
    if (rest.every((segment) => segment.kind === 'literal')) {
      endings.push(rest.map((segment) => `.${segment.text}`).join(''));
    }
  }
  return { first, names, endings };
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The text of a format: a string, or the English text a `{page, id}` with numbers names; undefined when not
 * known. A string that holds a text reference, `'{1972092429, 9011}'.[$x]`, is not known either: whether
 * the game puts the text in before it formats is not known.
 */
function formatOf(object: Expression, texts: TextDatabase | undefined): string | undefined {
  if (object.kind === 'string') {
    const text = object.text.slice(1, -1);
    return object.unterminated || /\{\s*\d+\s*,\s*\d+\s*\}/.test(text) ? undefined : text;
  }
  if (object.kind === 'textref' && object.page.kind === 'number' && object.id.kind === 'number' && texts) {
    const picked = texts.pick(Number(object.page.text), Number(object.id.text), '44');
    return picked && texts.display(picked.text, picked.language);
  }
  return undefined;
}

/**
 * Parses every attribute value that takes an expression and reports what the game would reject:
 * syntax errors, `@` combined with `?`, text references that are not numeric literals, `%d` in a
 * format string (fails at run time), a format given fewer arguments than it takes (a warning) or more
 * (information: they are not shown), and, with the script properties at hand, keywords and properties
 * that do not exist. The arguments of a format are counted only in an expression that parses.
 */
export function validateExpressions(
  declarations: ReadonlyMap<XmlElement, XsdElement>,
  document: TextDocument,
  source: string,
  options: ExpressionValidationOptions = {}
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { properties, schema } = options;
  const knownHeads = options.knownHeads ?? new Set<string>();

  for (const [element, declaration] of declarations) {
    if (options.checkElement && !options.checkElement(element)) {
      continue;
    }
    for (const attribute of element.attributes) {
      const declared = declaration.attributes.get(attribute.name);
      if (attribute.quote === '' || attribute.value.trim() === '' || !declared || !isExpressionAttribute(declared)) {
        continue;
      }
      const text = attribute.value;
      if (enumerationsOf(declared.type).some((enumeration) => enumeration.value === text.trim())) {
        // A value of the attribute's own enumeration, not an expression: `position="top_right"`.
        continue;
      }
      const report = (
        code: ExpressionDiagnosticCode | FormatDiagnosticCode,
        message: string,
        start: number,
        end: number,
        severity: DiagnosticSeverity,
        data?: PropertyEndings
      ): void => {
        const diagnostic: Diagnostic = {
          range: Range.create(document.positionAt(offsetInValue(attribute, start)), document.positionAt(offsetInValue(attribute, end))),
          message,
          severity,
          code,
          source,
        };
        if (data) {
          diagnostic.data = data;
        }
        diagnostics.push(diagnostic);
      };
      const parsed = parsedValue(attribute);
      for (const error of parsed.errors) {
        report(`expression-${error.code}`, error.message, error.start, error.end, DiagnosticSeverity.Error);
      }
      walkExpression(parsed.expression, (node) => {
        if (node.kind !== 'args') {
          return;
        }
        let unknownSpecifier = false;
        if (node.object.kind === 'string') {
          // `%%` is a percent sign: `100%%d` holds no `%d`.
          for (const match of node.object.text.matchAll(/%[%d]/g)) {
            if (match[0] === '%d') {
              const start = node.object.start + match.index;
              unknownSpecifier = true;
              report(
                'expression-format-specifier',
                "'%d' is not a format specifier the game knows; numbers format with '%s'",
                start,
                start + 2,
                DiagnosticSeverity.Warning
              );
            }
          }
        }
        // A format with a `%d` was meant to take an argument there: its count would only repeat the warning.
        if (options.formats === false || parsed.errors.length > 0 || unknownSpecifier) {
          return;
        }
        const format = formatOf(node.object, options.texts);
        const takes = format === undefined ? undefined : formatArgumentCount(formatPlaceholders(format));
        const given = node.args.length;
        if (takes === undefined || takes === given) {
          return;
        }
        const plural = (count: number): string => `${count} argument${count === 1 ? '' : 's'}`;
        if (given < takes) {
          const open = text.indexOf('[', node.object.end);
          report('format-arguments-missing', `The format takes ${plural(takes)} but is given ${given}`, open, node.end, DiagnosticSeverity.Warning);
        } else {
          const extra = given - takes;
          report(
            'format-arguments-unused',
            `The format takes ${plural(takes)}: ${extra === 1 ? 'this one is' : `these ${extra} are`} not shown`,
            node.args[takes].start,
            node.args[given - 1].end,
            DiagnosticSeverity.Information
          );
        }
      });
      if (!properties || !schema) {
        continue;
      }

      const checkHead = (head: Expression, resolvedKeyword: boolean): void => {
        if (head.kind !== 'name' || resolvedKeyword || knownHeads.has(head.name)) {
          return;
        }
        // A bare name that is the whole value may be a cue, a macro, a sound or another id the attribute
        // takes as is; in Mission Director scripts any name may be a cue of another script as well,
        // until cues are indexed across files.
        if (head === parsed.expression || schema === 'md') {
          return;
        }
        report('expression-unknown-keyword', `Unknown keyword '${head.name}'`, head.start, head.end, DiagnosticSeverity.Warning);
      };

      const variables = options.variables;
      const stepTypes = variables ? stepTypesIn(variables, element, properties) : undefined;
      const checkChain = (outer: ChainNode): void => {
        const { head, steps, resolved } = resolvedChainOf(outer, text, properties, schema, stepTypes);
        checkHead(head, resolved.steps[0].keyword !== undefined);
        let typedFrom = -1;
        for (let index = 1; index < steps.length; index++) {
          if (steps[index].text === '' || steps[index + 1]?.text === '') {
            // The name after a dot still to be typed: the syntax error says so, and the name before it may
            // start a longer one (`$table.keys.` of `keys.list`).
            break;
          }
          if (resolved.steps[index - 1].fromVariable) {
            typedFrom = index - 1;
          }
          const owner = resolved.owners[index];
          const step = resolved.steps[index];
          const stopped = index === steps.length - 1 ? stoppedInside(resolved, index) : undefined;
          if (owner.kind === 'unknown' || ((step.property || step.candidates || step.fromVariable) && !stopped)) {
            continue;
          }
          if (owner.kind === 'keyword' && owner.keyword.imported) {
            // A lookup whose values come from game data files: the list lags behind the game and its DLCs.
            break;
          }
          if (steps[index].kind === 'variable' || steps[index].kind === 'brackets' || steps[index].kind === 'braces') {
            // Variables on objects, argument lists and dynamic lookups (`$ship.{$name}`) are not described by the data.
            break;
          }
          const variableType = typedFrom >= 0 ? variables?.typeAt(element, steps, typedFrom) : undefined;
          if (typedFrom >= 0 && (!options.typedProperties || !variableType)) {
            break;
          }
          const ownerName = owner.kind === 'keyword' ? owner.keyword.name : owner.datatype.name;
          const because = variableType ? ` (${describeVariableType(steps[typedFrom].text, variableType, document, options.origin)})` : '';
          const guessed = variableType?.guessed === true;
          const first = stopped ? stopped.first : index;
          const name = text.slice(steps[first].start, steps[index].end);
          const only = stopped ? `, only ${listed(stopped.names)}` : '';
          report(
            guessed ? 'expression-unknown-property-guessed' : 'expression-unknown-property',
            `'${ownerName}' has no property '${name}'${only}${because}`,
            steps[first].start,
            steps[index].end,
            guessed ? DiagnosticSeverity.Information : DiagnosticSeverity.Warning,
            stopped && stopped.endings.length > 0 ? { endings: stopped.endings } : undefined
          );
          break;
        }
      };

      /** Visits a node; `chainObject` is true when the node is the object of a chain node above it. */
      const visit = (node: Expression, chainObject: boolean): void => {
        if (isChainNode(node)) {
          if (!chainObject) {
            checkChain(node);
          }
          visit(node.object, true);
          if (node.kind === 'dynamic') {
            visit(node.key, false);
          } else if (node.kind === 'args') {
            for (const argument of node.args) {
              visit(argument, false);
            }
          }
          return;
        }
        if (node.kind === 'name') {
          if (!chainObject) {
            checkHead(node, properties.keyword(node.name, schema) !== undefined);
          }
          return;
        }
        switch (node.kind) {
          case 'textref':
            visit(node.page, false);
            visit(node.id, false);
            break;
          case 'list':
            for (const item of node.items) {
              visit(item, false);
            }
            break;
          case 'table':
            for (const entry of node.entries) {
              visit(entry.key, false);
              visit(entry.value, false);
            }
            break;
          case 'call':
            for (const argument of node.args) {
              visit(argument, false);
            }
            break;
          case 'unary':
          case 'exists':
          case 'cast':
            visit(node.operand, false);
            break;
          case 'group':
            visit(node.expression, false);
            break;
          case 'binary':
            visit(node.left, false);
            visit(node.right, false);
            break;
          case 'conditional':
            visit(node.condition, false);
            visit(node.then, false);
            if (node.else) {
              visit(node.else, false);
            }
            break;
          default:
            break;
        }
      };
      visit(parsed.expression, false);
    }
  }
  diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return diagnostics;
}
