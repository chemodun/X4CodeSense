import { CompletionItemKind, InsertTextFormat, Range, type CompletionItem } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { positionContext, schemaOf, type PositionContext } from '../analysis/positionContext';
import { chainAtCaret, completeChain } from '../expressions/propertyChain';
import { isInsideString, tokenize, tokenIndexAt, type TokenKind } from '../expressions/lexer';
import type { GameData } from '../gameData';
import type { ScriptProperties } from '../properties/scriptProperties';
import type { ScriptSchema } from '../types';
import { offsetInValue, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';
import { enumerationsOf, isExpressionAttribute, type XsdAttribute, type XsdElement } from '../xsd/schema';
import { describeAttribute, describeElement, describeKeyword, describeProperty, escapeMarkdown } from './markdown';

export interface CompletionOptions {
  /** The client understands snippet syntax in inserted text. */
  snippetSupport?: boolean;
}

function markdown(value: string): { kind: 'markdown'; value: string } {
  return { kind: 'markdown', value };
}

/** Token kinds after which an operand, and so a keyword, may start. */
const operandMayFollow: ReadonlySet<TokenKind> = new Set<TokenKind>(['operator', 'reserved', 'lparen', 'lbracket', 'lbrace', 'comma', 'at']);

class Completer {
  readonly items: CompletionItem[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly analysis: DocumentAnalysis,
    private readonly game: GameData | undefined,
    private readonly options: CompletionOptions
  ) {}

  private range(start: number, end: number): Range {
    return Range.create(this.analysis.document.positionAt(start), this.analysis.document.positionAt(end));
  }

  private add(item: CompletionItem): void {
    if (!this.seen.has(item.label)) {
      this.seen.add(item.label);
      this.items.push(item);
    }
  }

  private get schema(): ScriptSchema | undefined {
    return this.analysis.detection.script?.schema;
  }

  complete(context: PositionContext): void {
    switch (context.kind) {
      case 'element-name':
        this.elementNames(context.parentDeclaration, context.parent, context.element, context.prefix, context.nameStart, context.nameEnd);
        break;
      case 'attribute-name':
        this.attributeNames(context.element, context.declaration, context.attribute, context.prefix, context.attribute.nameStart, context.attribute.nameEnd);
        break;
      case 'start-tag':
        this.attributeNames(context.element, context.declaration, undefined, '', -1, -1);
        break;
      case 'attribute-value':
        this.attributeValue(context.element, context.attribute, context.declared, context.expression, context.index);
        break;
    }
  }

  private elementNames(
    parentDeclaration: XsdElement | undefined,
    parent: XmlElement | undefined,
    element: XmlElement | undefined,
    prefix: string,
    nameStart: number,
    nameEnd: number
  ): void {
    if (!parentDeclaration || !parent) {
      return;
    }
    const model = parentDeclaration.contentModel;
    const previous = parent.children.filter((child) => child !== element && child.start < nameStart).map((child) => child.name);
    let names = model.expectedAfter(previous);
    if (names.length === 0) {
      names = [...model.declarations.keys()];
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) {
        continue;
      }
      const declaration = model.declarations.get(name);
      const item: CompletionItem = {
        label: name,
        kind: CompletionItemKind.Class,
        textEdit: { range: this.range(nameStart, nameEnd), newText: name },
      };
      if (declaration) {
        item.documentation = markdown(describeElement(declaration));
      }
      this.add(item);
    }
  }

  private attributeNames(
    element: XmlElement,
    declaration: XsdElement | undefined,
    editing: XmlAttribute | undefined,
    prefix: string,
    start: number,
    end: number
  ): void {
    if (!declaration) {
      return;
    }
    const present = new Set(element.attributes.filter((attribute) => attribute !== editing).map((attribute) => attribute.name));
    for (const [name, declared] of declaration.attributes) {
      if (present.has(name) || !name.startsWith(prefix)) {
        continue;
      }
      const item: CompletionItem = {
        label: name,
        kind: CompletionItemKind.Property,
        documentation: markdown(describeAttribute(declared, element.name)),
      };
      if (declared.typeName !== undefined) {
        item.detail = declared.typeName;
      }
      if (declared.required) {
        item.sortText = `0${name}`;
        item.label = name;
        item.labelDetails = { description: 'required' };
      }
      if (editing) {
        item.textEdit = { range: this.range(start, end), newText: name };
      } else if (this.options.snippetSupport) {
        item.insertText = `${name}="$1"`;
        item.insertTextFormat = InsertTextFormat.Snippet;
      } else {
        item.insertText = `${name}=""`;
      }
      this.add(item);
    }
  }

  private attributeValue(element: XmlElement, attribute: XmlAttribute, declared: XsdAttribute | undefined, expression: string, index: number): void {
    if (!declared) {
      return;
    }
    const values = enumerationsOf(declared.type);
    const typed = expression.slice(0, index);
    if (values.length > 0 && /^[\w.]*$/.test(typed)) {
      const wholeValue = this.range(attribute.valueStart, attribute.valueEnd);
      for (const value of values) {
        if (!value.value.startsWith(typed)) {
          continue;
        }
        const item: CompletionItem = { label: value.value, kind: CompletionItemKind.EnumMember, textEdit: { range: wholeValue, newText: value.value } };
        if (value.documentation) {
          item.documentation = markdown(escapeMarkdown(value.documentation));
        }
        this.add(item);
      }
    }
    const properties = this.game?.properties;
    const schema = this.schema;
    if (!properties || !schema || !isExpressionAttribute(declared)) {
      return;
    }
    const tokens = tokenize(expression);
    if (isInsideString(tokens, index)) {
      return;
    }
    const chain = chainAtCaret(expression, index);
    if (chain?.partial) {
      const partial = chain.partial;
      const range = this.range(offsetInValue(attribute, partial.start), offsetInValue(attribute, partial.end));
      for (const completion of completeChain(chain, properties, schema)) {
        const item: CompletionItem = {
          label: completion.label,
          kind: completion.value ? CompletionItemKind.EnumMember : CompletionItemKind.Field,
          detail: `${completion.property.owner.name}.${completion.property.name}${completion.property.type !== undefined ? ` → ${completion.property.type}` : ''}`,
          documentation: markdown(
            completion.value
              ? `${describeProperty(completion.value)}\n\n---\n\n${describeProperty(completion.property)}`
              : describeProperty(completion.property)
          ),
          textEdit: { range, newText: completion.label },
        };
        if (completion.label.startsWith('{$')) {
          if (this.options.snippetSupport) {
            item.insertTextFormat = InsertTextFormat.Snippet;
            item.textEdit = { range, newText: '{$1}' };
          } else {
            item.textEdit = { range, newText: '{}' };
          }
          item.filterText = completion.label;
          item.sortText = `~${completion.label}`;
        }
        this.add(item);
      }
      return;
    }
    this.keywords(tokens, expression, index, attribute, properties, schema);
  }

  /** Keywords, where an expression or a chain head may start. */
  private keywords(
    tokens: ReturnType<typeof tokenize>,
    expression: string,
    index: number,
    attribute: XmlAttribute,
    properties: ScriptProperties,
    schema: ScriptSchema
  ): void {
    let prefix = '';
    let start = index;
    let end = index;
    let tokenIndex = tokenIndexAt(tokens, index);
    if (tokenIndex < 0) {
      tokenIndex = tokens.findIndex((token) => token.end === index && (token.kind === 'identifier' || token.kind === 'reserved'));
    }
    if (tokenIndex >= 0 && (tokens[tokenIndex].kind === 'identifier' || tokens[tokenIndex].kind === 'reserved')) {
      // On a word: complete it, unless it is a property segment after a dot.
      const token = tokens[tokenIndex];
      if (tokenIndex > 0 && tokens[tokenIndex - 1].kind === 'dot') {
        return;
      }
      prefix = expression.slice(token.start, index);
      start = token.start;
      end = token.end;
    } else if (tokenIndex >= 0) {
      return;
    } else {
      // In whitespace or at the end: a keyword can only start an operand, so nothing may end one before the caret.
      const previous = tokens.filter((token) => token.end <= index).pop();
      if (previous && !operandMayFollow.has(previous.kind)) {
        return;
      }
    }
    const range = this.range(offsetInValue(attribute, start), offsetInValue(attribute, end));
    for (const keyword of properties.keywordsFor(schema)) {
      if (!keyword.name.startsWith(prefix)) {
        continue;
      }
      this.add({
        label: keyword.name,
        kind: CompletionItemKind.Keyword,
        detail: keyword.typeName,
        documentation: markdown(describeKeyword(keyword)),
        textEdit: { range, newText: keyword.name },
      });
    }
  }
}

/** Completion items for a caret offset in an analysed document. */
export function completionAt(analysis: DocumentAnalysis, offset: number, game: GameData | undefined, options: CompletionOptions = {}): CompletionItem[] {
  const completer = new Completer(analysis, game, options);
  completer.complete(positionContext(analysis, offset, schemaOf(game, analysis)));
  return completer.items;
}
