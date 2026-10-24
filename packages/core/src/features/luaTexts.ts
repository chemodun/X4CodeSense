/**
 * Texts in Lua files: the calls of `ReadText(page, id)`, their arguments resolved within the file, and a
 * hover over the argument list that shows the text. The Lua extension the user has keeps its own hover,
 * `ReadText` itself included, so this one is only offered between the parentheses.
 *
 * An argument resolves when it is an integer literal, or a name that the file sets at least once and only
 * to one integer literal, and never binds as a parameter or a loop variable: the page constants of mods,
 * `local PAGE_ID = 1972092427`. A field resolves the same way, set in a table constructor
 * (`local eic = { PAGE = 1972092440 }`) or by an assignment (`eic.PAGE = …`). Scopes are not told apart,
 * so a name set to different values anywhere in the file is not resolved. `c and N or M` gives both
 * numbers. Other expressions are not followed.
 *
 * What the file does not set itself, a global or a field of a module (`require("extensions.<folder>.…")`
 * or a mod's own `X.Require`), comes from the other Lua files of the same extension through `LuaProject`.
 */
import * as path from 'node:path';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { Range, type CompletionItem, type Hover, type Location } from 'vscode-languageserver-types';
import { diskFiles, type FileSource } from '../files/fileSource';
import { scanLua, type LuaScan, type LuaToken } from '../lua/luaScanner';
import type { TextDatabase } from '../texts/textDatabase';
import { inlineCode } from './markdown';
import { describeText, textDefinitions, textIdCompletionItems, textPageCompletionItems, type TextDisplayOptions } from './texts';

/** What another file of the extension may tell about a name or field: a global, or a field of a module's table. */
export type LuaPending = { kind: 'global'; key: string } | { kind: 'module'; module: string; rest: string[] };

export interface ReadTextArgument {
  /** Offsets of the argument's tokens; both at the place of a missing argument. */
  start: number;
  end: number;
  value?: number;
  /** The two numbers of `c and N or M`, when they differ. */
  choices?: number[];
  /**
   * The name or field the value comes from, and where it is first set: in this file, or in `file`, another
   * file of the extension, on `line` (from 0).
   */
  constant?: { name: string; offset: number; file?: string; line?: number };
  /** Why the value is not known: `a parameter of a function`. */
  reason?: string;
  /** Set when another file of the extension may tell the value; `LuaProject.resolve` follows it. */
  pending?: { name: string; lookup: LuaPending };
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

/** The facts of a file about one name or field: the values it is set to, and whether it is bound otherwise. */
interface NameFacts {
  /** Integer values, or `NaN` for anything else. */
  values: Set<number>;
  /** Offset of the first place the file sets it. */
  offset?: number;
  /** How many times the file sets it. */
  sets: number;
  bound?: 'a parameter of a function' | 'a loop variable';
  /** Declared `local` somewhere in the file. */
  local?: boolean;
  /** The module it is set to, `local eic = require("extensions.mod.ui.eic_config")`. */
  module?: string;
}

/** What a file tells about a name or field: its value, why it is not known, or where else to look. */
type Lookup = { value: number; offset: number } | { reason: string } | LuaPending;

/** Words that open a block an `end` (or `until`) closes. */
const blockWords = new Set(['function', 'if', 'do', 'repeat']);

class LuaFile {
  readonly tokens: LuaToken[];
  /** The text of each name and operator; empty for strings and numbers, which are compared with nothing. */
  private readonly words: string[];
  private readonly names = new Map<string, NameFacts>();
  /** Fields by their dotted path, `eic.PAGE`. */
  private readonly fields = new Map<string, NameFacts>();
  /** The tables the file registers as modules (`Register_Require_Response("<module>", t)`), by module name. */
  private readonly registered = new Map<string, string>();
  /** The name of `return name` at the end of the file. */
  private returned?: string;

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

  private facts(name: string, map = this.names): NameFacts {
    let facts = map.get(name);
    if (!facts) {
      facts = { values: new Set(), sets: 0 };
      map.set(name, facts);
    }
    return facts;
  }

  /** The text of a quoted string token without its quotes, or undefined for any other token. */
  private quoted(index: number): string | undefined {
    const text = this.tokens[index]?.kind === 'string' ? this.textOf(index) : '';
    return /^(["']).*\1$/s.test(text) ? text.slice(1, -1) : undefined;
  }

  /** The index of the bracket that closes the one at `open`, or the number of tokens when none does. */
  private closing(open: number): number {
    let depth = 0;
    for (let at = open; at < this.tokens.length; at++) {
      if (this.is(at, '(') || this.is(at, '[') || this.is(at, '{')) {
        depth++;
      } else if (this.is(at, ')') || this.is(at, ']') || this.is(at, '}')) {
        depth--;
        if (depth === 0) {
          return at;
        }
      }
    }
    return this.tokens.length;
  }

  /** The index after the `end` that closes the block opening at `index`, or the number of tokens. */
  private blockEnd(index: number): number {
    let depth = 0;
    for (let at = index; at < this.tokens.length; at++) {
      if (this.tokens[at].kind !== 'name') {
        continue;
      }
      if (blockWords.has(this.words[at])) {
        depth++;
      } else if (this.words[at] === 'end' || this.words[at] === 'until') {
        depth--;
        if (depth === 0) {
          return at + 1;
        }
      }
    }
    return this.tokens.length;
  }

  /** True when tokens `[from, to)` are one table constructor. */
  private isConstructor(from: number, to: number): boolean {
    return this.is(from, '{') && this.closing(from) === to - 1;
  }

  /** The dotted path tokens `[from, to)` are, `eic.PAGE`, or undefined for anything else. */
  private chain(from: number, to: number): string | undefined {
    if (to <= from || (to - from) % 2 === 0) {
      return undefined;
    }
    const names: string[] = [];
    for (let index = from; index < to; index++) {
      if ((index - from) % 2 === 0 ? !this.isName(index) : !this.is(index, '.')) {
        return undefined;
      }
      if ((index - from) % 2 === 0) {
        names.push(this.words[index]);
      }
    }
    return names.join('.');
  }

  /** The module of `require("m")`, `require "m"` or a mod's own `X.Require("m")` in tokens `[from, to)`. */
  private requireOf(from: number, to: number): string | undefined {
    let at = from;
    if (this.isName(at) && this.is(at + 1, '.') && this.textOf(at + 2) === 'Require') {
      at += 2;
    } else if (this.textOf(at) !== 'require') {
      return undefined;
    }
    const string = this.is(at + 1, '(') ? at + 2 : at + 1;
    const end = this.is(at + 1, '(') ? string + 2 : string + 1;
    return end === to && (string === at + 1 || this.is(string + 1, ')')) ? this.quoted(string) : undefined;
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
        this.facts(this.textOf(index + 2)).local = true;
        this.set(this.textOf(index + 2), NaN, tokens[index + 2].start);
      } else if (text === 'local') {
        // `local a, b <const> = …`: the names it declares.
        for (let at = index + 1; this.isName(at); at++) {
          this.facts(this.textOf(at)).local = true;
          at += this.is(at + 1, '<') ? 4 : 1;
          if (!this.is(at, ',')) {
            break;
          }
        }
      } else if (this.is(index + 1, '(') && this.is(index + 3, ',') && this.isName(index + 4)) {
        // `Register_Require_Response("<module>", t)`, `Register_Require_With_Init(…)`, a mod's own `X.Register(…)`.
        const module = this.quoted(index + 2);
        if (module && (text.startsWith('Register_Require_') || (text === 'Register' && this.is(index - 1, '.')))) {
          this.registered.set(module, this.textOf(index + 4));
        }
      }
    }
    if (this.is(tokens.length - 2, 'return') && this.isName(tokens.length - 1)) {
      this.returned = this.textOf(tokens.length - 1);
    }
  }

  private set(name: string, value: number, offset: number, map = this.names): NameFacts {
    const facts = this.facts(name, map);
    facts.values.add(value);
    facts.offset ??= offset;
    facts.sets++;
    return facts;
  }

  /**
   * The fields of a table constructor at `open` under a dotted path: `{ PAGE = 1, sub = { ID = 2 } }` sets
   * `prefix.PAGE` and `prefix.sub.ID`. Entries by position or by `[key]` are skipped, and so is a function
   * body, whose assignments are its own.
   */
  private constructorFields(open: number, prefix: string): void {
    const close = this.closing(open);
    let at = open + 1;
    while (at < close) {
      const start = at;
      if (this.isName(at) && this.is(at + 1, '=')) {
        const from = at + 2;
        const end = this.is(from, 'function') ? this.blockEnd(from) : Math.min(this.expressionEnd(from), close);
        const key = `${prefix}.${this.textOf(at)}`;
        this.set(key, this.integer(from, end) ?? NaN, this.tokens[at].start, this.fields);
        if (this.isConstructor(from, end)) {
          this.constructorFields(from, key);
        }
        at = end;
      } else if (this.is(at, 'function')) {
        at = this.blockEnd(at);
      } else {
        at = this.expressionEnd(at);
        if (this.is(at, '=')) {
          at = this.is(at + 1, 'function') ? this.blockEnd(at + 1) : this.expressionEnd(at + 1);
        }
      }
      if (this.is(at, ',') || this.is(at, ';')) {
        at++;
      }
      if (at <= start) {
        at = start + 1;
      }
    }
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
    // The targets, split at commas outside brackets: names and fields (`t.x`) are recorded, indexes (`t[1]`) not.
    const targets: { key: string; offset: number }[] = [];
    let first = this.statementStart(equals - 1);
    let depth = 0;
    for (let index = first; index <= equals; index++) {
      if (index === equals || (depth === 0 && this.is(index, ','))) {
        const key = this.chain(first, index);
        targets.push({ key: key ?? '', offset: this.tokens[first]?.start ?? 0 });
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
      if (target.key) {
        const facts = this.set(target.key, this.integer(from, end) ?? NaN, target.offset, target.key.includes('.') ? this.fields : this.names);
        if (this.isConstructor(from, end)) {
          this.constructorFields(from, target.key);
        }
        facts.module = this.requireOf(from, end) ?? facts.module;
      }
      from = this.is(end, ',') ? end + 1 : end;
    }
  }

  /**
   * What the file tells about a name or a dotted field: its one integer value, why there is none, or where
   * else to look: the files of the extension for a global, the module's file for a field of a module.
   */
  lookup(key: string): Lookup {
    const parts = key.split('.');
    const base = this.names.get(parts[0]);
    if (base?.bound) {
      return { reason: parts.length === 1 ? base.bound : `a field of ${base.bound}` };
    }
    const facts = parts.length === 1 ? base : this.fields.get(key);
    if (facts && facts.values.size > 0) {
      if (facts.values.size > 1) {
        return { reason: 'set to different values in this file' };
      }
      const [only] = facts.values;
      return Number.isNaN(only) ? { reason: 'set to something other than a whole number' } : { value: only, offset: facts.offset ?? 0 };
    }
    if (parts.length > 1 && base?.module && base.sets === 1) {
      return { kind: 'module', module: base.module, rest: parts.slice(1) };
    }
    if (!base?.local) {
      return { kind: 'global', key };
    }
    return { reason: parts.length === 1 ? 'not set in this file' : 'a field this file does not set' };
  }

  /** The facts of a global name or field this file sets, or undefined when it sets none or the name is its own. */
  globalFacts(key: string): NameFacts | undefined {
    const base = this.names.get(key.split('.')[0]);
    if (base?.local || base?.bound) {
      return undefined;
    }
    const facts = key.includes('.') ? this.fields.get(key) : base;
    return facts && facts.values.size > 0 ? facts : undefined;
  }

  /** The name of the table the file gives as a module: registered under the module's name, or returned at its end. */
  moduleTable(module: string): string | undefined {
    return this.registered.get(module) ?? this.returned;
  }

  /** The line of an offset, from 0. */
  lineAt(offset: number): number {
    let line = 0;
    for (let at = this.text.indexOf('\n'); at !== -1 && at < offset; at = this.text.indexOf('\n', at + 1)) {
      line++;
    }
    return line;
  }

  /** The numbers of `c and N or M` in tokens `[from, to)`, each an integer or a name of this file; undefined for any other expression. */
  private choices(from: number, to: number): number[] | undefined {
    let depth = 0;
    let lastAnd = -1;
    let or = -1;
    for (let index = from; index < to; index++) {
      if (this.is(index, '(') || this.is(index, '[') || this.is(index, '{')) {
        depth++;
      } else if (this.is(index, ')') || this.is(index, ']') || this.is(index, '}')) {
        depth--;
      } else if (depth === 0 && this.tokens[index].kind === 'name' && (this.words[index] === 'and' || this.words[index] === 'or')) {
        if (this.words[index] === 'or') {
          if (or !== -1) {
            return undefined;
          }
          or = index;
        } else if (or !== -1) {
          return undefined;
        } else {
          lastAnd = index;
        }
      }
    }
    if (lastAnd === -1 || or === -1) {
      return undefined;
    }
    const number = (start: number, end: number): number | undefined => {
      const literal = this.integer(start, end);
      if (literal !== undefined || end - start !== 1 || !this.isName(start)) {
        return literal;
      }
      const found = this.lookup(this.textOf(start));
      return 'value' in found ? found.value : undefined;
    };
    const [first, second] = [number(lastAnd + 1, or), number(or + 1, to)];
    return first === undefined || second === undefined ? undefined : [...new Set([first, second])];
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
    const name = this.chain(from, to);
    if (name) {
      const found = this.lookup(name);
      if ('value' in found) {
        return { ...argument, value: found.value, constant: { name, offset: found.offset } };
      }
      if ('reason' in found) {
        return { ...argument, reason: found.reason };
      }
      // What the file alone tells, until another file of the extension is asked.
      const reason = name.includes('.') ? 'a field this file does not set' : 'not set in this file';
      return { ...argument, reason, pending: { name, lookup: found } };
    }
    const choices = this.choices(from, to);
    if (choices) {
      return choices.length === 1 ? { ...argument, value: choices[0] } : { ...argument, choices };
    }
    return { ...argument, reason: 'an expression' };
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

/** The values an argument may have: its value, the two of `c and N or M`, or none. */
function valuesOf(argument: ReadTextArgument): number[] {
  return argument.value !== undefined ? [argument.value] : (argument.choices ?? []);
}

/** The texts a call may read, as `[page, id]`: one, or each pair of the choices; none while either is not known. */
export function readTextPairs(call: ReadTextCall): [number, number][] {
  return valuesOf(call.page).flatMap((page) => valuesOf(call.id).map((id): [number, number] => [page, id]));
}

/** Markdown for a call: the text when page and id are known, and where each came from or why it is not known. */
export function describeReadText(document: TextDocument, call: ReadTextCall, texts: TextDatabase, options: TextDisplayOptions = {}): string {
  const text = document.getText();
  const lines: string[] = [];
  const pairs = readTextPairs(call);
  if (pairs.length > 0) {
    lines.push(pairs.map(([page, id]) => describeText(texts, page, id, options)).join('\n\n'));
  } else {
    lines.push(`**ReadText**(${inlineCode(argumentText(text, call.page) || ' ')}, ${inlineCode(argumentText(text, call.id) || ' ')})`);
  }
  const notes: string[] = [];
  for (const [role, argument] of [
    ['page', call.page],
    ['id', call.id],
  ] as const) {
    const constant = argument.constant;
    if (constant) {
      const where =
        constant.file !== undefined
          ? `set in ${inlineCode(path.basename(constant.file))} on line ${(constant.line ?? 0) + 1}`
          : `set on line ${document.positionAt(constant.offset).line + 1}`;
      notes.push(`The ${role} ${inlineCode(constant.name)} is ${argument.value}, ${where}.`);
    } else if (argument.choices) {
      notes.push(`The ${role} ${inlineCode(argumentText(text, argument))} is ${argument.choices.join(' or ')}.`);
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

/** Where the text of the `ReadText` call around the offset is defined, when its page and id are known. */
export function readTextDefinitions(calls: readonly ReadTextCall[], offset: number, texts: TextDatabase, options: TextDisplayOptions = {}): Location[] {
  const call = readTextCallAt(calls, offset);
  return call ? readTextPairs(call).flatMap(([page, id]) => textDefinitions(texts, page, id, options)) : [];
}

/**
 * Completion in the argument list of the `ReadText` call around the offset: the pages in the page
 * argument, the ids of a known page in the id argument. Only where the argument is empty or digits, so
 * a name being typed is left to the Lua extension; the digits around the caret are replaced.
 */
export function readTextCompletions(
  document: TextDocument,
  calls: readonly ReadTextCall[],
  offset: number,
  texts: TextDatabase,
  options: TextDisplayOptions = {}
): CompletionItem[] | undefined {
  const text = document.getText();
  // A call cut off while typing ends with its last token: the caret may be in the white space after it.
  const call =
    readTextCallAt(calls, offset) ??
    calls
      .filter((cut) => !cut.closed && cut.end <= offset && offset - cut.end < 1000 && /^\s*$/.test(text.slice(cut.end, offset)))
      .reduce<ReadTextCall | undefined>((found, cut) => (!found || cut.open > found.open ? cut : found), undefined);
  if (!call || offset <= call.open) {
    return undefined;
  }
  const typed = /\d*$/.exec(text.slice(call.open + 1, offset))?.[0] ?? '';
  const digitsAfter = /^\d*/.exec(text.slice(offset, offset + 20))?.[0].length ?? 0;
  // After the digits the argument ends: a name or more of an expression there is no place for a number.
  if (!/^[ \t]*([,)\r\n]|$)/.test(text.slice(offset + digitsAfter, offset + digitsAfter + 100))) {
    return undefined;
  }
  const from = offset - typed.length;
  const range = Range.create(document.positionAt(from), document.positionAt(offset + digitsAfter));
  if (/^\s*$/.test(text.slice(call.open + 1, from))) {
    return textPageCompletionItems(texts, range, typed);
  }
  if (call.page.value !== undefined && call.page.end <= from && /^\s*,\s*$/.test(text.slice(call.page.end, from))) {
    return textIdCompletionItems(texts, call.page.value, range, typed, options);
  }
  return undefined;
}

/** A file's key for the caches: its full path without case, as Windows compares names. */
function fileKey(file: string): string {
  return path.resolve(file).toLowerCase();
}

/** What a lookup in the files of an extension found: a value and where, or why there is none. */
type Found = { value: number; offset: number; file: string; line: number } | { reason: string };

/**
 * The Lua files of the extensions, for what a file reads from the others of its own extension: a global
 * that another file sets (`RKN_Configio = { config = { textId = … } }`), or a field of a module's table
 * (`local eic = require("extensions.<folder>.ui.eic_config")`, or a mod's own `X.Require`), the table the
 * module registers (`Register_Require_Response`, `Register_Require_With_Init`, `X.Register`) or returns.
 *
 * Only within the extension folder that holds the file: a module of another extension, the game's own
 * files and a file outside every extension (a `dist` copy, which is an extension of its own below the
 * other) are not followed. A text comes from the open document first, then from the file; each file is
 * read and scanned once, until `forget`.
 */
export class LuaProject {
  private readonly folders: string[];
  private readonly listings = new Map<string, string[]>();
  private readonly read = new Map<string, string | undefined>();
  private readonly parsed = new Map<string, { text: string; lua: LuaFile }>();

  constructor(
    extensionFolders: readonly string[],
    private readonly files: FileSource = diskFiles,
    private readonly openText: (file: string) => string | undefined = () => undefined
  ) {
    this.folders = extensionFolders.map((folder) => path.resolve(folder));
  }

  /** Forgets a file's text read from disk, after it changed there. */
  forget(file: string): void {
    this.read.delete(fileKey(file));
  }

  /** Forgets which Lua files the extensions have, after one was created or deleted. */
  forgetListings(): void {
    this.listings.clear();
  }

  /** The extension folder that holds a file, the innermost one; undefined for a file outside them. */
  extensionOf(file: string): string | undefined {
    const key = fileKey(file);
    let found: string | undefined;
    for (const folder of this.folders) {
      if (key.startsWith(folder.toLowerCase() + path.sep) && (!found || folder.length > found.length)) {
        found = folder;
      }
    }
    return found;
  }

  /** The Lua files of an extension folder: dot folders, `node_modules` and the folders of extensions below it left out. */
  luaFilesOf(folder: string): string[] {
    const known = this.listings.get(folder.toLowerCase());
    if (known) {
      return known;
    }
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of this.files.list(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.directory) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && !this.files.exists(path.join(full, 'content.xml'))) {
            walk(full);
          }
        } else if (/\.(lua|xpl)$/i.test(entry.name)) {
          found.push(full);
        }
      }
    };
    walk(folder);
    this.listings.set(folder.toLowerCase(), found);
    return found;
  }

  /** The calls with what other files of the extension tell about their arguments. */
  resolveAll(calls: readonly ReadTextCall[], file: string): ReadTextCall[] {
    return calls.map((call) => this.resolve(call, file));
  }

  /** A call with what other files of the extension tell about its arguments; the same call when it needs none. */
  resolve(call: ReadTextCall, file: string): ReadTextCall {
    if (!call.page.pending && !call.id.pending) {
      return call;
    }
    const folder = this.extensionOf(file);
    if (!folder) {
      return call;
    }
    return { ...call, page: this.resolveArgument(call.page, file, folder), id: this.resolveArgument(call.id, file, folder) };
  }

  private resolveArgument(argument: ReadTextArgument, file: string, folder: string): ReadTextArgument {
    if (!argument.pending) {
      return argument;
    }
    const { name, lookup } = argument.pending;
    const found = this.follow(lookup, folder, new Set([fileKey(file)]));
    const { pending: _pending, reason: _reason, ...rest } = argument;
    if ('reason' in found) {
      return { ...rest, reason: found.reason };
    }
    return { ...rest, value: found.value, constant: { name, offset: found.offset, file: found.file, line: found.line } };
  }

  private follow(lookup: LuaPending, folder: string, seen: Set<string>): Found {
    if (lookup.kind === 'global') {
      return this.global(lookup.key, folder);
    }
    const target = this.moduleFile(lookup.module, folder);
    if (!target) {
      return { reason: `a field of the module ${lookup.module}, which is no file of this extension` };
    }
    const lua = this.lua(target);
    const table = lua?.moduleTable(lookup.module);
    if (!lua || !table) {
      return { reason: `a field of the module ${lookup.module}, whose table is not found` };
    }
    if (seen.has(fileKey(target))) {
      return { reason: `a field of the module ${lookup.module}, which requires itself` };
    }
    seen.add(fileKey(target));
    const found = lua.lookup([table, ...lookup.rest].join('.'));
    if ('value' in found) {
      return { ...found, file: target, line: lua.lineAt(found.offset) };
    }
    return 'reason' in found ? found : this.follow(found, folder, seen);
  }

  /** A global name or field in the files of the extension: set only to one integer, in one file or several. */
  private global(key: string, folder: string): Found {
    let found: Found | undefined;
    let other = false;
    for (const file of this.luaFilesOf(folder)) {
      const lua = this.lua(file);
      const facts = lua?.globalFacts(key);
      if (!lua || !facts) {
        continue;
      }
      for (const value of facts.values) {
        if (Number.isNaN(value)) {
          other = true;
        } else if (!found) {
          found = { value, offset: facts.offset ?? 0, file, line: lua.lineAt(facts.offset ?? 0) };
        } else if ('value' in found && found.value !== value) {
          return { reason: 'set to different values in the files of this extension' };
        }
      }
    }
    if (found && other) {
      return { reason: 'set to different values in the files of this extension' };
    }
    if (other) {
      return { reason: 'set to something other than a whole number' };
    }
    return found ?? { reason: key.includes('.') ? 'a field no file of this extension sets' : 'not set in the files of this extension' };
  }

  /** The file of a module of the extension, `extensions.<folder>.ui.eic_config` for `<folder>/ui/eic_config.lua`. */
  private moduleFile(module: string, folder: string): string | undefined {
    const parts = module.split('.');
    if (parts.length < 3 || parts[0] !== 'extensions' || parts[1].toLowerCase() !== path.basename(folder).toLowerCase()) {
      return undefined;
    }
    const wanted = path.join(folder, ...parts.slice(2)).toLowerCase();
    return this.luaFilesOf(folder).find((file) => file.toLowerCase().replace(/\.(lua|xpl)$/, '') === wanted);
  }

  private lua(file: string): LuaFile | undefined {
    const key = fileKey(file);
    let text = this.openText(file);
    if (text === undefined) {
      if (!this.read.has(key)) {
        try {
          this.read.set(key, this.files.readText(file));
        } catch {
          this.read.set(key, undefined);
        }
      }
      text = this.read.get(key);
    }
    if (text === undefined) {
      return undefined;
    }
    const known = this.parsed.get(key);
    if (known?.text === text) {
      return known.lua;
    }
    const lua = new LuaFile(text, scanLua(text));
    lua.collect();
    this.parsed.set(key, { text, lua });
    return lua;
  }
}
