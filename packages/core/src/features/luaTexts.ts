/**
 * Texts in Lua files: the calls of `ReadText(page, id)`, their arguments resolved within the file, and a
 * hover over the argument list that shows the text. The Lua extension the user has keeps its own hover,
 * `ReadText` itself included, so this one is only offered between the parentheses.
 *
 * An argument resolves when it is an integer literal, or a name that the file sets at least once and only
 * to one integer literal, and never binds as a parameter or a loop variable: the page constants of mods,
 * `local PAGE_ID = 1972092427`. Scopes are not told apart, so a name set to different values anywhere in
 * the file is not resolved. Fields, expressions and other files are not followed.
 */
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { Range, type Hover } from 'vscode-languageserver-types';
import { scanLua, type LuaScan, type LuaToken } from '../lua/luaScanner';
import type { TextDatabase } from '../texts/textDatabase';
import { inlineCode } from './markdown';
import { describeText, type TextDisplayOptions } from './texts';

export interface ReadTextArgument {
  /** Offsets of the argument's tokens; both at the place of a missing argument. */
  start: number;
  end: number;
  value?: number;
  /** The name the value comes from, and where the file first sets it. */
  constant?: { name: string; offset: number };
  /** Why the value is not known: `a parameter of a function`. */
  reason?: string;
}

export interface ReadTextCall {
  /** Offset of the name `ReadText`. */
  start: number;
  /** Offset of `(`. */
  open: number;
  /** Offset after `)`, or after the last token of a call cut off while typing. */
  end: number;
  closed: boolean;
  page: ReadTextArgument;
  id: ReadTextArgument;
}

const statementWords = new Set(['break', 'do', 'else', 'elseif', 'end', 'for', 'goto', 'if', 'in', 'local', 'repeat', 'return', 'then', 'until', 'while']);
const operatorWords = new Set(['and', 'or', 'not']);

/** The facts of a file about one name: the values it is set to, and whether it is bound otherwise. */
interface NameFacts {
  /** Integer values, or `NaN` for anything else. */
  values: Set<number>;
  /** Offset of the first place the file sets it. */
  offset?: number;
  bound?: 'a parameter of a function' | 'a loop variable';
}

class LuaFile {
  readonly tokens: LuaToken[];
  /** The text of each name and operator; empty for strings and numbers, which are compared with nothing. */
  private readonly words: string[];
  private readonly names = new Map<string, NameFacts>();

  constructor(
    readonly text: string,
    scanned: LuaScan
  ) {
    this.tokens = scanned.tokens;
    this.words = this.tokens.map((token) => (token.kind === 'name' || token.kind === 'operator' ? text.slice(token.start, token.end) : ''));
  }

  textOf(index: number): string {
    const token = this.tokens[index];
    return token === undefined ? '' : this.words[index] || this.text.slice(token.start, token.end);
  }

  private is(index: number, text: string): boolean {
    return this.words[index] === text;
  }

  private isName(index: number): boolean {
    const word = this.words[index];
    return this.tokens[index]?.kind === 'name' && !statementWords.has(word) && !operatorWords.has(word);
  }

  /** True for a token that can end an operand: a name, a number, a string, a closing bracket. */
  private endsOperand(index: number): boolean {
    const token = this.tokens[index];
    if (!token) {
      return false;
    }
    return (
      token.kind === 'string' ||
      token.kind === 'number' ||
      this.isName(index) ||
      this.is(index, ')') ||
      this.is(index, ']') ||
      this.is(index, '}') ||
      this.is(index, '...')
    );
  }

  /**
   * True when a statement ends before the token: a statement keyword, `;`, or an operand after an
   * operand, where Lua starts a new statement without a separator. A string, `{` or `(` after an operand
   * continues it as a call.
   */
  private endsStatementBefore(index: number): boolean {
    const token = this.tokens[index];
    if (!token || this.startsStatement(index)) {
      return true;
    }
    return (this.isName(index) || token.kind === 'number') && this.endsOperand(index - 1);
  }

  /** True for a statement keyword or `;`, which no expression holds. */
  private startsStatement(index: number): boolean {
    return (this.tokens[index]?.kind === 'name' && statementWords.has(this.words[index])) || this.is(index, ';');
  }

  private facts(name: string): NameFacts {
    let facts = this.names.get(name);
    if (!facts) {
      facts = { values: new Set() };
      this.names.set(name, facts);
    }
    return facts;
  }

  /** The integer an argument or value of tokens `[from, to)` is, when it is one integer literal. */
  private integer(from: number, to: number): number | undefined {
    if (to - from !== 1 || this.tokens[from].kind !== 'number') {
      return undefined;
    }
    const text = this.textOf(from);
    return /^\d+$/.test(text) ? Number(text) : /^0[xX][0-9a-fA-F]+$/.test(text) ? parseInt(text.slice(2), 16) : undefined;
  }

  /** The end of an expression starting at `from`: a comma, a closing bracket or `=` outside brackets, or the end of the statement. */
  private expressionEnd(from: number): number {
    let depth = 0;
    let at = from;
    for (; at < this.tokens.length; at++) {
      if (depth === 0 && (at > from ? this.endsStatementBefore(at) : this.startsStatement(at))) {
        break;
      }
      const token = this.tokens[at];
      if (token.kind !== 'operator') {
        continue;
      }
      const text = this.textOf(at);
      if (text === '(' || text === '[' || text === '{') {
        depth++;
      } else if (text === ')' || text === ']' || text === '}') {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (depth === 0 && (text === ',' || text === '=')) {
        break;
      }
    }
    return at;
  }

  /**
   * Collects what the file sets its names to, and the names it binds as parameters and loop variables:
   * `local a, b = 1, 2`, `a = 1`, `function (a, b)`, `for i = …`, `for k, v in …`. The fields of a table
   * constructor are no assignments of a name.
   *
   * The open brackets and blocks are kept on a stack: an `=` directly in a block, a function body passed
   * as an argument included, is an assignment. A statement keyword closes the brackets a block has left
   * open, as while typing.
   */
  collect(): void {
    const tokens = this.tokens;
    const open: string[] = [];
    const closeBrackets = (): void => {
      while (open.length > 0 && open[open.length - 1] !== 'block') {
        open.pop();
      }
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const text = token.kind === 'string' || token.kind === 'number' ? '' : this.textOf(index);
      if (token.kind === 'operator') {
        if (text === '(' || text === '[' || text === '{') {
          open.push(text);
        } else if (text === ')' || text === ']' || text === '}') {
          open.pop();
        } else if (text === '=' && (open.length === 0 || open[open.length - 1] === 'block')) {
          // In brackets an `=` names a field of a table constructor, or is out of place.
          this.assignment(index);
        }
        continue;
      }
      if (token.kind !== 'name') {
        continue;
      }
      if (text === 'if' || text === 'do' || text === 'repeat') {
        closeBrackets();
        open.push('block');
      } else if (text === 'end' || text === 'until') {
        closeBrackets();
        open.pop();
      } else if (text === 'local' || text === 'return' || text === 'while' || text === 'for') {
        closeBrackets();
      }
      if (text === 'function') {
        open.push('block');
        let at = index + 1;
        while (at < tokens.length && !this.is(at, '(')) {
          at++;
        }
        for (at++; at < tokens.length && !this.is(at, ')'); at++) {
          if (this.isName(at)) {
            this.facts(this.textOf(at)).bound = 'a parameter of a function';
          }
        }
      } else if (text === 'for') {
        for (let at = index + 1; at < tokens.length && !this.is(at, '=') && !this.is(at, 'in') && !this.is(at, 'do'); at++) {
          if (this.isName(at)) {
            this.facts(this.textOf(at)).bound = 'a loop variable';
          }
        }
      } else if (text === 'local' && this.is(index + 1, 'function') && this.isName(index + 2)) {
        this.set(this.textOf(index + 2), NaN, tokens[index + 2].start);
      }
    }
  }

  private set(name: string, value: number, offset: number): void {
    const facts = this.facts(name);
    facts.values.add(value);
    facts.offset ??= offset;
  }

  /** Where the statement starts that holds the token, looking back over brackets. */
  private statementStart(index: number): number {
    let depth = 0;
    let at = index;
    for (; at >= 0; at--) {
      if (this.is(at, ')') || this.is(at, ']') || this.is(at, '}')) {
        depth++;
      } else if (this.is(at, '(') || this.is(at, '[') || this.is(at, '{')) {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (depth === 0) {
        const token = this.tokens[at];
        if ((token.kind === 'name' && statementWords.has(this.textOf(at))) || this.is(at, ';')) {
          break;
        }
        if (at > 0 && (this.isName(at) || token.kind === 'number') && this.endsOperand(at - 1)) {
          return at;
        }
      }
    }
    return at + 1;
  }

  /** An `=` of a statement: the targets before it, the values after it, one by one. */
  private assignment(equals: number): void {
    // The targets, split at commas outside brackets: names are recorded, fields and indexes (`t.x`, `t[1]`) not.
    const targets: (number | undefined)[] = [];
    let first = this.statementStart(equals - 1);
    let depth = 0;
    for (let index = first; index <= equals; index++) {
      if (index === equals || (depth === 0 && this.is(index, ','))) {
        targets.push(index - first === 1 && this.isName(first) ? first : undefined);
        first = index + 1;
      } else if (this.is(index, '(') || this.is(index, '[') || this.is(index, '{')) {
        depth++;
      } else if (this.is(index, ')') || this.is(index, ']') || this.is(index, '}')) {
        depth--;
      }
    }
    let from = equals + 1;
    for (const target of targets) {
      const end = this.expressionEnd(from);
      if (target !== undefined) {
        this.set(this.textOf(target), this.integer(from, end) ?? NaN, this.tokens[target].start);
      }
      from = this.is(end, ',') ? end + 1 : end;
    }
  }

  /** The value of an argument of tokens `[from, to)`, or why it is not known. */
  resolve(from: number, to: number, at: number): ReadTextArgument {
    const tokens = this.tokens;
    if (to <= from) {
      return { start: at, end: at, reason: 'missing' };
    }
    const argument: ReadTextArgument = { start: tokens[from].start, end: tokens[to - 1].end };
    const value = this.integer(from, to);
    if (value !== undefined) {
      return { ...argument, value };
    }
    if (to - from === 1 && tokens[from].kind === 'number') {
      return { ...argument, reason: 'not a whole number' };
    }
    if (to - from === 1 && this.isName(from)) {
      const name = this.textOf(from);
      const facts = this.names.get(name);
      if (facts?.bound) {
        return { ...argument, reason: facts.bound };
      }
      if (!facts || facts.values.size === 0) {
        return { ...argument, reason: 'not set in this file' };
      }
      if (facts.values.size > 1) {
        return { ...argument, reason: 'set to different values in this file' };
      }
      const [only] = facts.values;
      if (Number.isNaN(only)) {
        return { ...argument, reason: 'set to something other than a whole number' };
      }
      return { ...argument, value: only, constant: { name, offset: facts.offset ?? argument.start } };
    }
    let field = true;
    for (let index = from; index < to; index++) {
      field &&= (index - from) % 2 === 0 ? this.isName(index) : this.is(index, '.');
    }
    return { ...argument, reason: field && (to - from) % 2 === 1 ? 'a field of a table, which is not followed' : 'an expression' };
  }

  /** The calls of `ReadText`: not a method (`a.ReadText`, `a:ReadText`) and not its definition. */
  calls(): ReadTextCall[] {
    const tokens = this.tokens;
    const calls: ReadTextCall[] = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].kind !== 'name' || !this.is(index, 'ReadText') || !this.is(index + 1, '(')) {
        continue;
      }
      if (this.is(index - 1, '.') || this.is(index - 1, ':') || this.is(index - 1, 'function')) {
        continue;
      }
      // The arguments, split at commas; the list ends at `)`, or where a statement starts when it is cut off.
      const open = index + 1;
      const args: [number, number][] = [];
      let from = open + 1;
      let end = this.expressionEnd(from);
      args.push([from, end]);
      while (this.is(end, ',')) {
        from = end + 1;
        end = this.expressionEnd(from);
        args.push([from, end]);
      }
      const closed = this.is(end, ')');
      // Cut off: the list ends with its last token, `(` or a comma included.
      const after = tokens[closed ? end : end - 1].end;
      const at = (argument: [number, number] | undefined): number => tokens[argument?.[1] ?? end]?.start ?? after;
      const [page, id] = [args[0], args[1] ?? [end, end]];
      calls.push({
        start: tokens[index].start,
        open: tokens[open].start,
        end: after,
        closed,
        page: this.resolve(page[0], page[1], Math.min(at(page), after)),
        id: this.resolve(id[0], id[1], Math.min(at(args[1]), after)),
      });
    }
    return calls;
  }
}

/** The calls of `ReadText` in a Lua file, their arguments resolved within the file. */
export function readTextCalls(text: string, scanned: LuaScan = scanLua(text)): ReadTextCall[] {
  const file = new LuaFile(text, scanned);
  file.collect();
  return file.calls();
}

/** The innermost call whose argument list holds the offset, parentheses included. */
export function readTextCallAt(calls: readonly ReadTextCall[], offset: number): ReadTextCall | undefined {
  let found: ReadTextCall | undefined;
  for (const call of calls) {
    if (call.open <= offset && (offset < call.end || (!call.closed && offset === call.end)) && (!found || call.open > found.open)) {
      found = call;
    }
  }
  return found;
}

/** An argument's text on one line, shortened. */
function argumentText(text: string, argument: ReadTextArgument): string {
  const written = text.slice(argument.start, argument.end).replace(/\s+/g, ' ').trim();
  return written.length > 60 ? `${written.slice(0, 59)}…` : written;
}

/** Markdown for a call: the text when page and id are known, and where each came from or why it is not known. */
export function describeReadText(document: TextDocument, call: ReadTextCall, texts: TextDatabase, options: TextDisplayOptions = {}): string {
  const text = document.getText();
  const lines: string[] = [];
  const page = call.page.value;
  const id = call.id.value;
  if (page !== undefined && id !== undefined) {
    lines.push(describeText(texts, page, id, options));
  } else {
    lines.push(`**ReadText**(${inlineCode(argumentText(text, call.page) || ' ')}, ${inlineCode(argumentText(text, call.id) || ' ')})`);
  }
  const notes: string[] = [];
  for (const [role, argument] of [
    ['page', call.page],
    ['id', call.id],
  ] as const) {
    if (argument.constant) {
      const line = document.positionAt(argument.constant.offset).line + 1;
      notes.push(`The ${role} ${inlineCode(argument.constant.name)} is ${argument.value}, set on line ${line}.`);
    } else if (argument.reason === 'missing') {
      notes.push(`The ${role} is missing.`);
    } else if (argument.reason) {
      notes.push(`The ${role} ${inlineCode(argumentText(text, argument))} is not known here: ${argument.reason}.`);
    }
  }
  if (notes.length > 0) {
    lines.push('', ...notes.map((note) => `${note}  `));
  }
  return lines.join('\n').trimEnd();
}

/** The hover over the argument list of the `ReadText` call around the offset. */
export function readTextHover(
  document: TextDocument,
  calls: readonly ReadTextCall[],
  offset: number,
  texts: TextDatabase,
  options: TextDisplayOptions = {}
): Hover | undefined {
  const call = readTextCallAt(calls, offset);
  if (!call) {
    return undefined;
  }
  return {
    contents: { kind: 'markdown', value: describeReadText(document, call, texts, options) },
    range: Range.create(document.positionAt(call.open), document.positionAt(call.end)),
  };
}
