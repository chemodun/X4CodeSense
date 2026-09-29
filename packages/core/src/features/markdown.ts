import * as path from 'node:path';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ScriptKeyword, ScriptProperty } from '../properties/scriptProperties';
import type { SourceLocation } from '../sourceLocation';
import type { XsdAttribute, XsdElement } from '../xsd/schema';
import { enumerationsOf } from '../xsd/schema';

/** Escapes text so it renders literally in Markdown, including angle brackets that would be taken for HTML. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]<>#+!|]/g, (character) => (character === '<' ? '&lt;' : character === '>' ? '&gt;' : `\\${character}`));
}

/**
 * Text as inline code. Markdown takes code literally, so nothing is escaped: `run_actions` stays as it
 * is. The fence is longer than any run of backticks in the text.
 */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Where an offset of a document was written, when that is not the document itself (see `DocumentAnalysis.origin`). */
export type DocumentOrigin = (offset: number) => { line: number; file?: string } | undefined;

/**
 * The lines of offsets of a document, for a hover: `line 7`, `lines 3, 7`. With an origin, the lines
 * where they were written, those of other files named: `line 3, line 5 of setup.xml`.
 */
export function describeLines(document: TextDocument, offsets: readonly number[], origin?: DocumentOrigin): string {
  const groups: { file?: string; lines: number[] }[] = [];
  for (const offset of offsets) {
    const place = origin?.(offset) ?? { line: document.positionAt(offset).line };
    const last = groups[groups.length - 1];
    if (last && last.file === place.file) {
      last.lines.push(place.line + 1);
    } else {
      groups.push({ ...(place.file === undefined ? {} : { file: place.file }), lines: [place.line + 1] });
    }
  }
  return groups
    .map(
      (group) => `line${group.lines.length === 1 ? '' : 's'} ${group.lines.join(', ')}${group.file === undefined ? '' : ` of ${escapeMarkdown(group.file)}`}`
    )
    .join(', ');
}

function definedIn(location: SourceLocation | undefined): string[] {
  return location ? [`*Defined in ${escapeMarkdown(path.basename(location.file))}*`] : [];
}

/** Hover text for an element declaration. */
export function describeElement(declaration: XsdElement): string {
  const lines = [`**\\<${escapeMarkdown(declaration.name)}\\>**`];
  if (declaration.documentation) {
    lines.push('', escapeMarkdown(declaration.documentation));
  }
  const required = [...declaration.attributes.values()].filter((attribute) => attribute.required).map((attribute) => `\`${attribute.name}\``);
  if (required.length > 0) {
    lines.push('', `Required attributes: ${required.join(', ')}`);
  }
  lines.push('', ...definedIn(declaration.location));
  return lines.join('\n');
}

/** Hover text for an attribute declaration. */
export function describeAttribute(declaration: XsdAttribute, elementName: string): string {
  const lines = [`**${escapeMarkdown(declaration.name)}** of \\<${escapeMarkdown(elementName)}\\>`];
  if (declaration.documentation) {
    lines.push('', escapeMarkdown(declaration.documentation));
  }
  const facts: string[] = [];
  if (declaration.typeName !== undefined) {
    facts.push(`Type: \`${declaration.typeName}\``);
  }
  facts.push(declaration.required ? 'Required' : 'Optional');
  if (declaration.default !== undefined) {
    facts.push(`Default: \`${declaration.default}\``);
  }
  lines.push('', facts.join(' · '));
  const values = enumerationsOf(declaration.type);
  if (values.length > 0) {
    const shown = values.slice(0, 12).map((value) => `\`${value.value}\``);
    lines.push('', `Values: ${shown.join(', ')}${values.length > 12 ? `, ... (${values.length})` : ''}`);
  }
  lines.push('', ...definedIn(declaration.location));
  return lines.join('\n');
}

/** Hover text for a keyword. */
export function describeKeyword(keyword: ScriptKeyword): string {
  const lines = [`**${escapeMarkdown(keyword.name)}** *(keyword)*`];
  if (keyword.description) {
    lines.push('', escapeMarkdown(keyword.description));
  }
  const facts: string[] = [];
  if (keyword.typeName !== undefined) {
    facts.push(`Type: \`${keyword.typeName}\``);
  }
  if (keyword.script !== undefined) {
    facts.push(keyword.script === 'md' ? 'Mission Director scripts only' : 'AI scripts only');
  }
  if (facts.length > 0) {
    lines.push('', facts.join(' · '));
  }
  lines.push('', ...definedIn(keyword.location));
  return lines.join('\n');
}

/** Hover text for a property; the owner is named because the same property can exist on several datatypes. */
export function describeProperty(property: ScriptProperty): string {
  const lines = [`**${escapeMarkdown(property.owner.name)}.${escapeMarkdown(property.name)}**`];
  if (property.result) {
    lines.push('', escapeMarkdown(property.result));
  }
  if (property.type !== undefined) {
    lines.push('', `Type: \`${property.type}\``);
  }
  lines.push('', ...definedIn(property.location));
  return lines.join('\n');
}

/** Hover text when several datatypes offer a matching property. */
export function describeCandidates(candidates: readonly ScriptProperty[]): string {
  const shown = candidates.slice(0, 8);
  const lines = [`**${escapeMarkdown(shown[0].name)}** matches a property of ${candidates.length} datatypes:`, ''];
  for (const candidate of shown) {
    lines.push(
      `- **${escapeMarkdown(candidate.owner.name)}**${candidate.type !== undefined ? ` → \`${candidate.type}\`` : ''}: ${escapeMarkdown(candidate.result)}`
    );
  }
  if (candidates.length > shown.length) {
    lines.push(`- and ${candidates.length - shown.length} more`);
  }
  return lines.join('\n');
}
