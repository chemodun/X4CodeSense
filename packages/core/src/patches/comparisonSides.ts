/**
 * The two sides of a patch comparison as documents of their own: the file a patch changes before the
 * patch (read only), and after it (editable). Each is analysed as the script it shows, under the uri of
 * the target file with a fragment, as the patched target of a patch document is: the features that look
 * across files then take the target for the current file, whose indexed places are the side's own.
 *
 * The side with the patch shows the problems the side before it does not have: what the patch and the
 * edits of the side bring in, and what they break elsewhere in the script. The target's own problems are
 * the target's to report.
 */
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic } from 'vscode-languageserver-types';
import { analyzeDocument, type AnalysisContext, type DocumentAnalysis } from '../analysis/analyzeDocument';
import { patchAfterScheme, patchBeforeScheme } from '../protocol';

export type ComparisonSide = 'before' | 'after';

/** Which side of a patch comparison a document is, with the uri of the patch document; undefined for other documents. */
export function comparisonSideOf(uri: string): { side: ComparisonSide; patch: string } | undefined {
  const scheme = uri.slice(0, Math.max(0, uri.indexOf(':')));
  const side = scheme === patchBeforeScheme ? 'before' : scheme === patchAfterScheme ? 'after' : undefined;
  const question = uri.indexOf('?');
  if (!side || question < 0) {
    return undefined;
  }
  const hash = uri.indexOf('#', question);
  let query = uri.slice(question + 1, hash < 0 ? undefined : hash);
  // VS Code encodes the query once more when it sends the uri: `patch%3Dfile%253A...`.
  try {
    query = decodeURIComponent(query);
  } catch {
    // Not encoded so: read as it is.
  }
  const patch = new URLSearchParams(query).get('patch');
  return patch ? { side, patch } : undefined;
}

/** A side of a patch comparison analysed as the script it shows, as the file `target` when that is known. */
export function analyzeComparisonSide(document: TextDocument, side: ComparisonSide, target: string | undefined, context: AnalysisContext): DocumentAnalysis {
  const shown =
    target === undefined
      ? document
      : TextDocument.create(`${pathToFileURL(target).toString()}#${side}`, document.languageId, document.version, document.getText());
  return analyzeDocument(shown, context);
}

/** What makes two problems the same in both sides: a line number in the message aside, since lines move. */
function problemKey(analysis: DocumentAnalysis, diagnostic: Diagnostic): string {
  const document = analysis.document;
  const line = diagnostic.range.start.line;
  const message = typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
  return [
    String(diagnostic.code ?? ''),
    message.replace(/\bline \d+/g, 'line'),
    document.getText(diagnostic.range),
    document.getText({ start: { line, character: 0 }, end: { line: line + 1, character: 0 } }).trim(),
  ].join('\u0000');
}

/**
 * The problems of the side with the patch that the side before it does not have, each as many times as
 * that side lacks it. Without an analysed side before it, the well-formedness problems alone: the written
 * out text has none of its own.
 */
export function newProblems(after: DocumentAnalysis, before: DocumentAnalysis | undefined): Diagnostic[] {
  if (!before?.structure) {
    return after.diagnostics.slice(0, after.structure?.problems.length ?? 0);
  }
  const counts = new Map<string, number>();
  for (const diagnostic of before.diagnostics) {
    const key = problemKey(before, diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return after.diagnostics.filter((diagnostic) => {
    const key = problemKey(after, diagnostic);
    const left = counts.get(key) ?? 0;
    counts.set(key, left - 1);
    return left <= 0;
  });
}
