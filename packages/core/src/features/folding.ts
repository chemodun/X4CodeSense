/**
 * Folding of script and patch documents: each element that spans lines, from its start tag to the line
 * before its end tag, so the end tag stays in sight; each comment that spans lines; and the stretch from a
 * `<!-- #region -->` comment to its `<!-- #endregion -->`, as VS Code's own folding of XML has them. Read
 * from the structure alone, so it works on half-typed XML: an element that is not closed folds up to where
 * it was cut off.
 */
import { FoldingRangeKind, type FoldingRange } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';

const regionStart = /^\s*#region\b/;
const regionEnd = /^\s*#endregion\b/;

/**
 * The folding ranges of a script or patch document, by start line; undefined for other documents, which
 * other XML tooling folds.
 */
export function foldingRanges(analysis: DocumentAnalysis): FoldingRange[] | undefined {
  const structure = analysis.structure;
  if (!structure || (!analysis.detection.script && !analysis.detection.isDiff)) {
    return undefined;
  }
  const document = analysis.document;
  const text = document.getText();
  const lineOf = (offset: number): number => document.positionAt(offset).line;
  const ranges: FoldingRange[] = [];
  for (const element of structure.elements) {
    const startLine = lineOf(element.start);
    if (element.selfClosing && element.startTagClosed) {
      const endLine = lineOf(element.end);
      if (endLine > startLine) {
        ranges.push({ startLine, endLine });
      }
      continue;
    }
    // The end tag, or what follows where an element was cut off, keeps its line unless more stands before it there.
    const end = element.endTag?.start ?? element.end;
    let endLine = lineOf(end);
    if (text.slice(document.offsetAt({ line: endLine, character: 0 }), end).trim() === '') {
      endLine--;
    }
    if (endLine > startLine) {
      ranges.push({ startLine, endLine });
    }
  }
  const regions: number[] = [];
  for (const comment of structure.comments) {
    const startLine = lineOf(comment.start);
    const endLine = lineOf(comment.end);
    if (endLine > startLine) {
      ranges.push({ startLine, endLine, kind: FoldingRangeKind.Comment });
    }
    const content = text.slice(comment.start + 4, comment.end);
    if (regionStart.test(content)) {
      regions.push(startLine);
    } else if (regionEnd.test(content)) {
      const regionLine = regions.pop();
      if (regionLine !== undefined && startLine > regionLine) {
        ranges.push({ startLine: regionLine, endLine: startLine, kind: FoldingRangeKind.Region });
      }
    }
  }
  return ranges.sort((a, b) => a.startLine - b.startLine);
}
