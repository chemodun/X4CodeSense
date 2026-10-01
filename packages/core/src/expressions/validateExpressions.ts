import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { ScriptProperties } from '../properties/scriptProperties';
import type { TextDatabase } from '../texts/textDatabase';
import type { ScriptSchema } from '../types';
import { offsetInValue, type XmlElement } from '../xml/xmlStructure';
import { enumerationsOf, isExpressionAttribute, type XsdElement } from '../xsd/schema';
import { isChainNode, resolvedChainOf, type ChainNode } from './astChain';
import { parsedValue } from './attributeExpression';
import { formatArgumentCount, formatPlaceholders } from './formats';
import { walkExpression, type Expression } from './parser';

export type ExpressionDiagnosticCode =
  | 'expression-syntax'
  | 'expression-null-safe-exists'
  | 'expression-text-reference'
  | 'expression-format-specifier'
  | 'expression-unknown-keyword'
  | 'expression-unknown-property';

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
}

/** The text of a format: a string, or the English text a `{page, id}` with numbers names; undefined when not known. */
function formatOf(object: Expression, texts: TextDatabase | undefined): string | undefined {
  if (object.kind === 'string') {
    return object.unterminated ? undefined : object.text.slice(1, -1);
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
        severity: DiagnosticSeverity
      ): void => {
        diagnostics.push({
          range: Range.create(document.positionAt(offsetInValue(attribute, start)), document.positionAt(offsetInValue(attribute, end))),
          message,
          severity,
          code,
          source,
        });
      };
      const parsed = parsedValue(attribute);
      for (const error of parsed.errors) {
        report(`expression-${error.code}`, error.message, error.start, error.end, DiagnosticSeverity.Error);
      }
      walkExpression(parsed.expression, (node) => {
        if (node.kind !== 'args') {
          return;
        }
        if (node.object.kind === 'string') {
          const literal = node.object.text;
          for (let index = literal.indexOf('%d'); index >= 0; index = literal.indexOf('%d', index + 2)) {
            const start = node.object.start + index;
            report(
              'expression-format-specifier',
              "'%d' is not a format specifier the game knows; numbers format with '%s'",
              start,
              start + 2,
              DiagnosticSeverity.Warning
            );
          }
        }
        if (options.formats === false || parsed.errors.length > 0) {
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

      const checkChain = (outer: ChainNode): void => {
        const { head, steps, resolved } = resolvedChainOf(outer, text, properties, schema);
        checkHead(head, resolved.steps[0].keyword !== undefined);
        for (let index = 1; index < steps.length; index++) {
          const owner = resolved.owners[index];
          const step = resolved.steps[index];
          if (owner.kind === 'unknown' || step.property || step.candidates) {
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
          const ownerName = owner.kind === 'keyword' ? owner.keyword.name : owner.datatype.name;
          report(
            'expression-unknown-property',
            `'${ownerName}' has no property '${steps[index].text}'`,
            steps[index].start,
            steps[index].end,
            DiagnosticSeverity.Warning
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
