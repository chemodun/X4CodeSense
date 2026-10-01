/**
 * Recursive descent parser for the script expression language.
 *
 * Precedence, highest first: property chains and postfix `?`; unary `- + not typeof @` and calls;
 * `^`; `* / %`; `+ -`; `lt le gt ge < <= > >=`; `== !=`; `and`; `or`; `if ... then ... else ...`.
 * Operators of one level associate left to right.
 *
 * The parser never throws: every problem becomes an `ExpressionError` and parsing goes on with a
 * `missing` node or by skipping tokens, so a half-typed expression still yields a tree.
 */
import { tokenize, type Token, type TokenKind } from './lexer';

export interface Span {
  start: number;
  end: number;
}

export type UnaryOperator = '-' | '+' | 'not' | 'typeof' | '@';
export type BinaryOperator = '^' | '*' | '/' | '%' | '+' | '-' | 'lt' | 'le' | 'gt' | 'ge' | '<' | '<=' | '>' | '>=' | '==' | '!=' | 'and' | 'or';

export type Expression =
  | (Span & { kind: 'number'; text: string; suffix: string })
  | (Span & { kind: 'string'; text: string; unterminated: boolean })
  | (Span & { kind: 'textref'; page: Expression; id: Expression })
  | (Span & { kind: 'variable'; name: string })
  | (Span & { kind: 'name'; name: string })
  | (Span & { kind: 'list'; items: Expression[] })
  | (Span & { kind: 'table'; entries: TableEntry[] })
  | (Span & { kind: 'property'; object: Expression; name: string; nameStart: number; nameEnd: number })
  | (Span & { kind: 'dynamic'; object: Expression; key: Expression })
  | (Span & { kind: 'args'; object: Expression; args: Expression[] })
  | (Span & { kind: 'call'; name: string; nameStart: number; nameEnd: number; args: Expression[] })
  | (Span & { kind: 'unary'; operator: UnaryOperator; operand: Expression })
  | (Span & { kind: 'exists'; operand: Expression })
  | (Span & { kind: 'cast'; operand: Expression; suffix: string })
  | (Span & { kind: 'group'; expression: Expression })
  | (Span & { kind: 'binary'; operator: BinaryOperator; left: Expression; right: Expression })
  | (Span & { kind: 'conditional'; condition: Expression; then: Expression; else?: Expression })
  | (Span & { kind: 'missing' });

export interface TableEntry {
  key: Expression;
  value: Expression;
}

export type ExpressionErrorCode = 'syntax' | 'null-safe-exists' | 'text-reference';

export interface ExpressionError {
  code: ExpressionErrorCode;
  message: string;
  start: number;
  end: number;
}

export interface ParsedExpression {
  expression: Expression;
  errors: ExpressionError[];
  tokens: Token[];
}

/** Errors reported for one expression at most; later ones are usually consequences of the first. */
const maxErrors = 5;

/** The binary operators by precedence, loosest first: the operands of a level are expressions of the next, those of the last unary. */
const binaryLevels: readonly ReadonlySet<string>[] = [
  new Set(['or']),
  new Set(['and']),
  new Set(['==', '!=']),
  new Set(['lt', 'le', 'gt', 'ge', '<', '<=', '>', '>=']),
  new Set(['+', '-']),
  new Set(['*', '/', '%']),
  new Set(['^']),
];

class Parser {
  private position = 0;
  readonly errors: ExpressionError[] = [];

  constructor(
    private readonly text: string,
    private readonly tokens: Token[]
  ) {}

  private get current(): Token | undefined {
    return this.tokens[this.position];
  }

  private at(kind: TokenKind, text?: string): boolean {
    const token = this.current;
    return token !== undefined && token.kind === kind && (text === undefined || token.text === text);
  }

  private atOperator(operators: ReadonlySet<string>): boolean {
    const token = this.current;
    return token !== undefined && (token.kind === 'operator' || token.kind === 'reserved') && operators.has(token.text);
  }

  private advance(): Token {
    return this.tokens[this.position++];
  }

  private error(code: ExpressionErrorCode, message: string, start: number, end: number): void {
    if (this.errors.length < maxErrors) {
      this.errors.push({ code, message, start, end });
    }
  }

  /** Offset where something is missing: at the current token, or at the end of the text. */
  private here(): number {
    return this.current?.start ?? this.text.length;
  }

  private missing(what: string): Expression {
    const at = this.here();
    this.error('syntax', `${what} expected`, at, at);
    return { kind: 'missing', start: at, end: at };
  }

  /** Consumes the expected token or reports it missing; returns its end offset or where it should have been. */
  private expect(kind: TokenKind, text: string): number {
    if (this.at(kind, text)) {
      return this.advance().end;
    }
    const at = this.here();
    this.error('syntax', `'${text}' expected`, at, at);
    return at;
  }

  parse(): Expression {
    const expression = this.parseExpression();
    while (this.current) {
      const token = this.advance();
      this.error('syntax', `Unexpected '${token.text}'`, token.start, token.end);
      // Keep going so later mistakes are reported too; the tree stays the first expression.
      if (this.current && this.canStartExpression(this.current)) {
        this.parseExpression();
      }
    }
    return expression;
  }

  /** True when an operand may begin with the token. */
  private canStartExpression(token: Token): boolean {
    switch (token.kind) {
      case 'number':
      case 'string':
      case 'variable':
      case 'identifier':
      case 'lparen':
      case 'lbracket':
      case 'lbrace':
      case 'at':
        return true;
      case 'operator':
        return token.text === '-' || token.text === '+';
      case 'reserved':
        return token.text === 'not' || token.text === 'typeof' || token.text === 'if';
      default:
        return false;
    }
  }

  parseExpression(): Expression {
    return this.at('reserved', 'if') ? this.parseConditional() : this.parseOr();
  }

  /**
   * `if condition then value else value`. The game also takes it as an operand inside a larger
   * expression (`$a + if $b then 1 else 2`); both branches then extend as far as they can.
   */
  private parseConditional(): Expression {
    const start = this.advance().start;
    const condition = this.parseOr();
    this.expect('reserved', 'then');
    const then = this.parseExpression();
    const node: Expression = { kind: 'conditional', condition, then, start, end: then.end };
    if (this.at('reserved', 'else')) {
      this.advance();
      const otherwise = this.parseExpression();
      node.else = otherwise;
      node.end = otherwise.end;
    }
    return node;
  }

  /** The operators of `binaryLevels[level]`, left-associative, between operands of the next level. */
  private parseBinary(level: number): Expression {
    let left = this.parseOperand(level + 1);
    while (this.atOperator(binaryLevels[level])) {
      const operator = this.advance().text as BinaryOperator;
      const right = this.parseOperand(level + 1);
      left = { kind: 'binary', operator, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseOperand(level: number): Expression {
    return level < binaryLevels.length ? this.parseBinary(level) : this.parseUnary();
  }

  private parseOr(): Expression {
    return this.parseBinary(0);
  }

  private parseUnary(): Expression {
    if (this.at('reserved', 'if')) {
      return this.parseConditional();
    }
    const token = this.current;
    if (
      token &&
      ((token.kind === 'operator' && (token.text === '-' || token.text === '+')) ||
        (token.kind === 'reserved' && (token.text === 'not' || token.text === 'typeof')) ||
        token.kind === 'at')
    ) {
      this.advance();
      const operator = token.text as UnaryOperator;
      const operand = this.parseUnary();
      if (operator === '@' && operand.kind === 'exists') {
        this.error('null-safe-exists', "'@' and '?' cannot be combined in one expression", operand.end - 1, operand.end);
      }
      return { kind: 'unary', operator, operand, start: token.start, end: operand.end };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expression {
    let node = this.parsePrimary();
    for (;;) {
      if (this.at('dot')) {
        const dot = this.advance();
        const next = this.current;
        if (next?.kind === 'identifier') {
          this.advance();
          node = { kind: 'property', object: node, name: next.text, nameStart: next.start, nameEnd: next.end, start: node.start, end: next.end };
        } else if (next?.kind === 'variable') {
          this.advance();
          node = { kind: 'property', object: node, name: next.text, nameStart: next.start, nameEnd: next.end, start: node.start, end: next.end };
        } else if (next?.kind === 'lbrace') {
          this.advance();
          const key = this.parseExpression();
          const end = this.expect('rbrace', '}');
          node = { kind: 'dynamic', object: node, key, start: node.start, end };
        } else if (next?.kind === 'lbracket') {
          this.advance();
          const { items, end } = this.parseItems('rbracket', ']');
          node = { kind: 'args', object: node, args: items, start: node.start, end };
        } else {
          this.error('syntax', "Property name expected after '.'", dot.end, dot.end);
          node = { kind: 'property', object: node, name: '', nameStart: dot.end, nameEnd: dot.end, start: node.start, end: dot.end };
          break;
        }
        continue;
      }
      if (this.at('question')) {
        const question = this.advance();
        node = { kind: 'exists', operand: node, start: node.start, end: question.end };
        break;
      }
      break;
    }
    return node;
  }

  /** Comma separated expressions up to the closing token, which is consumed when present. */
  private parseItems(closing: TokenKind, closingText: string): { items: Expression[]; end: number } {
    const items: Expression[] = [];
    while (this.current && !this.at(closing)) {
      items.push(this.parseExpression());
      if (this.at('comma')) {
        this.advance();
        continue;
      }
      if (!this.at(closing)) {
        break;
      }
    }
    return { items, end: this.expect(closing, closingText) };
  }

  private parsePrimary(): Expression {
    const token = this.current;
    if (!token) {
      return this.missing('Expression');
    }
    switch (token.kind) {
      case 'number':
        this.advance();
        return { kind: 'number', text: token.text, suffix: token.suffix, start: token.start, end: token.end };
      case 'string':
        this.advance();
        if (token.unterminated) {
          this.error('syntax', 'String is not closed', token.start, token.end);
        }
        return { kind: 'string', text: token.text, unterminated: token.unterminated, start: token.start, end: token.end };
      case 'variable':
        this.advance();
        return { kind: 'variable', name: token.text, start: token.start, end: token.end };
      case 'identifier':
        this.advance();
        if (token.text === 'table' && this.at('lbracket')) {
          return this.parseTable(token);
        }
        if (this.at('lparen')) {
          this.advance();
          const { items, end } = this.parseItems('rparen', ')');
          return { kind: 'call', name: token.text, nameStart: token.start, nameEnd: token.end, args: items, start: token.start, end };
        }
        return { kind: 'name', name: token.text, start: token.start, end: token.end };
      case 'lparen': {
        this.advance();
        const expression = this.parseExpression();
        const end = this.expect('rparen', ')');
        // A unit suffix glued to the closing parenthesis casts the value: `($x)s`, `(1 + 1)f`.
        const suffix = this.current;
        if (suffix && suffix.kind === 'identifier' && suffix.start === end) {
          this.advance();
          return { kind: 'cast', operand: expression, suffix: suffix.text, start: token.start, end: suffix.end };
        }
        return { kind: 'group', expression, start: token.start, end };
      }
      case 'lbracket': {
        this.advance();
        const { items, end } = this.parseItems('rbracket', ']');
        return { kind: 'list', items, start: token.start, end };
      }
      case 'lbrace': {
        this.advance();
        const { items, end } = this.parseItems('rbrace', '}');
        if (items.length !== 2) {
          this.error('text-reference', 'A text reference is {page, id} with two numbers', token.start, end);
        }
        const [page, id] = items;
        const node: Expression = {
          kind: 'textref',
          page: page ?? { kind: 'missing', start: end, end },
          id: id ?? { kind: 'missing', start: end, end },
          start: token.start,
          end,
        };
        for (const part of [node.page, node.id]) {
          if (part.kind !== 'number' && part.kind !== 'missing') {
            this.error('text-reference', 'A text reference takes numeric literals only; resolve the text to a string first', part.start, part.end);
          }
        }
        return node;
      }
      default:
        // An operator, a closing token or an unknown character where an operand should be: report the
        // gap and leave the token to the caller, so `1 +* 2` becomes `1 + (<missing> * 2)` with one error.
        return this.missing('Expression');
    }
  }

  private parseTable(keyword: Token): Expression {
    this.advance();
    const entries: TableEntry[] = [];
    while (this.current && !this.at('rbracket')) {
      const key = this.parseTableKey();
      let value: Expression;
      if (this.at('operator', '=')) {
        this.advance();
        value = this.parseExpression();
      } else {
        value = this.missing("'=' and a value");
      }
      entries.push({ key, value });
      if (this.at('comma')) {
        this.advance();
        continue;
      }
      if (!this.at('rbracket')) {
        break;
      }
    }
    const end = this.expect('rbracket', ']');
    return { kind: 'table', entries, start: keyword.start, end };
  }

  private parseTableKey(): Expression {
    const token = this.current;
    if (token?.kind === 'variable') {
      this.advance();
      return { kind: 'variable', name: token.text, start: token.start, end: token.end };
    }
    if (token?.kind === 'lbrace') {
      this.advance();
      const key = this.parseExpression();
      const end = this.expect('rbrace', '}');
      return { kind: 'group', expression: key, start: token.start, end };
    }
    const key = this.parseUnary();
    this.error('syntax', 'A table key is a $variable or a {braced expression}', key.start, key.end);
    return key;
  }
}

/** Parses an expression text. Never throws. */
export function parseExpression(text: string): ParsedExpression {
  const tokens = tokenize(text);
  const parser = new Parser(text, tokens);
  const expression = parser.parse();
  return { expression, errors: parser.errors, tokens };
}

/** Calls `visit` for every node of the tree, parents before children. */
export function walkExpression(expression: Expression, visit: (node: Expression) => void): void {
  visit(expression);
  switch (expression.kind) {
    case 'textref':
      walkExpression(expression.page, visit);
      walkExpression(expression.id, visit);
      break;
    case 'list':
      for (const item of expression.items) {
        walkExpression(item, visit);
      }
      break;
    case 'table':
      for (const entry of expression.entries) {
        walkExpression(entry.key, visit);
        walkExpression(entry.value, visit);
      }
      break;
    case 'property':
      walkExpression(expression.object, visit);
      break;
    case 'dynamic':
      walkExpression(expression.object, visit);
      walkExpression(expression.key, visit);
      break;
    case 'args':
      walkExpression(expression.object, visit);
      for (const argument of expression.args) {
        walkExpression(argument, visit);
      }
      break;
    case 'call':
      for (const argument of expression.args) {
        walkExpression(argument, visit);
      }
      break;
    case 'unary':
    case 'exists':
    case 'cast':
      walkExpression(expression.operand, visit);
      break;
    case 'group':
      walkExpression(expression.expression, visit);
      break;
    case 'binary':
      walkExpression(expression.left, visit);
      walkExpression(expression.right, visit);
      break;
    case 'conditional':
      walkExpression(expression.condition, visit);
      walkExpression(expression.then, visit);
      if (expression.else) {
        walkExpression(expression.else, visit);
      }
      break;
    default:
      break;
  }
}
