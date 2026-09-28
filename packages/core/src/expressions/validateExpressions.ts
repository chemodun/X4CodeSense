import type { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range, type Diagnostic } from 'vscode-languageserver-types';
import type { ScriptProperties } from '../properties/scriptProperties';
import type { ScriptSchema } from '../types';
import { offsetInValue, type XmlElement } from '../xml/xmlStructure';
import { enumerationsOf, isExpressionAttribute, type XsdElement } from '../xsd/schema';
import { parseExpression, walkExpression, type Expression } from './parser';
import { resolveChain, type ChainStep } from './propertyChain';

export type ExpressionDiagnosticCode =
  | 'expression-syntax'
  | 'expression-null-safe-exists'
  | 'expression-text-reference'
  | 'expression-format-specifier'
  | 'expression-unknown-keyword'
  | 'expression-unknown-property';

export interface ExpressionValidationOptions {
  /** Script properties; without them keywords and properties are not checked. */
  properties?: ScriptProperties;
  /** Script kind of the document, needed for the keyword set. */
  schema?: ScriptSchema;
  /** Names that may start a chain besides keywords: the cues and libraries of the document. */
  knownHeads?: ReadonlySet<string>;
}

type ChainNode = Extract<Expression, { kind: 'property' | 'dynamic' | 'args' }>;

function isChainNode(node: Expression): node is ChainNode {
  return node.kind === 'property' || node.kind === 'dynamic' || node.kind === 'args';
}

/** The chain steps of an outermost chain node, head first, in the form the resolver takes. */
function stepsOf(outer: ChainNode, text: string): { head: Expression; steps: ChainStep[] } {
  const steps: ChainStep[] = [];
  let current: Expression = outer;
  while (isChainNode(current)) {
    const kind = current.kind === 'property' ? (current.name.startsWith('$') ? 'variable' : 'identifier') : current.kind === 'dynamic' ? 'braces' : 'brackets';
    const start = current.kind === 'property' ? current.nameStart : current.object.end + 1;
    steps.unshift({ kind, start, end: current.end, text: text.slice(start, current.end), suffix: '' });
    current = current.object;
  }
  const head = current;
  const headKind: ChainStep['kind'] =
    head.kind === 'name'
      ? 'identifier'
      : head.kind === 'variable'
        ? 'variable'
        : head.kind === 'string'
          ? 'string'
          : head.kind === 'number'
            ? 'number'
            : head.kind === 'list'
              ? 'brackets'
              : head.kind === 'textref'
                ? 'braces'
                : 'parens';
  steps.unshift({
    kind: headKind,
    start: head.start,
    end: head.end,
    text: text.slice(head.start, head.end),
    suffix: head.kind === 'number' ? head.suffix : '',
  });
  return { head, steps };
}

/**
 * Parses every attribute value that takes an expression and reports what the game would reject:
 * syntax errors, `@` combined with `?`, text references that are not numeric literals, `%d` in a
 * format string (fails at run time), and, with the script properties at hand, keywords and properties
 * that do not exist.
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
      const report = (code: ExpressionDiagnosticCode, message: string, start: number, end: number, severity: DiagnosticSeverity): void => {
        diagnostics.push({
          range: Range.create(document.positionAt(offsetInValue(attribute, start)), document.positionAt(offsetInValue(attribute, end))),
          message,
          severity,
          code,
          source,
        });
      };
      const parsed = parseExpression(text);
      for (const error of parsed.errors) {
        report(`expression-${error.code}`, error.message, error.start, error.end, DiagnosticSeverity.Error);
      }
      walkExpression(parsed.expression, (node) => {
        if (node.kind !== 'args' || node.object.kind !== 'string') {
          return;
        }
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
        const { head, steps } = stepsOf(outer, text);
        const resolved = resolveChain({ steps }, properties, schema);
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
