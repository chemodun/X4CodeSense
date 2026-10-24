/**
 * Code lens with reference counts: over each cue and library of a Mission Director script, and each
 * label and interrupt library item of an AI script, how often it is referenced, as Find All References
 * finds it without its definitions. In a patch document, over those of what the patch brings in, at their
 * names in the patch. Read from the names the analysis collects, so a half-typed cue still has its lens.
 */
import { Range, type Location } from 'vscode-languageserver-types';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { GameData } from '../gameData';
import type { NamedOccurrence } from '../names/namedItems';
import { definitionAt } from './definition';
import { patchedViewOf, placeKey, rangeInPatch } from './patchContent';
import { referencesAtEach } from './rename';

function definitionsIn(analysis: DocumentAnalysis): NamedOccurrence[] {
  return (analysis.names?.occurrences ?? []).filter((occurrence) => occurrence.role === 'definition');
}

function rangeOf(analysis: DocumentAnalysis, occurrence: NamedOccurrence): Range {
  return Range.create(analysis.document.positionAt(occurrence.start), analysis.document.positionAt(occurrence.end));
}

/**
 * The names of the definitions that get a lens, in text order; undefined for other XML, and for a patch
 * whose target is not known.
 */
export function referenceLensRanges(analysis: DocumentAnalysis): Range[] | undefined {
  if (analysis.detection.script) {
    return definitionsIn(analysis).map((occurrence) => rangeOf(analysis, occurrence));
  }
  const view = analysis.detection.isDiff ? patchedViewOf(analysis) : undefined;
  if (!view) {
    return undefined;
  }
  const ranges: Range[] = [];
  for (const occurrence of definitionsIn(view.analysis)) {
    const range = rangeInPatch(view, rangeOf(view.analysis, occurrence));
    if (range) {
      ranges.push(range);
    }
  }
  return ranges;
}

/** A lens: a definition's name and its references. */
export interface ReferenceLens {
  range: Range;
  references: Location[];
}

/**
 * The lenses of a document with their references: what Find All References finds at each name, its
 * definitions left out. All at once, so the patches' paths are read once for the document.
 */
export function referenceLenses(analysis: DocumentAnalysis, game?: GameData): ReferenceLens[] | undefined {
  const ranges = referenceLensRanges(analysis);
  if (!ranges) {
    return undefined;
  }
  const document = analysis.document;
  const offsets = ranges.map((range) => document.offsetAt(range.start));
  const found = referencesAtEach(analysis, offsets, game);
  return ranges.map((range, number) => {
    const definitions = new Set([placeKey(document.uri, range.start.line, range.start.character)]);
    for (const definition of definitionAt(analysis, offsets[number], game)) {
      definitions.add(placeKey(definition.uri, definition.range.start.line, definition.range.start.character));
    }
    const references = found[number].filter((location) => !definitions.has(placeKey(location.uri, location.range.start.line, location.range.start.character)));
    return { range, references };
  });
}

/** The title of a lens over references. */
export function referenceLensTitle(count: number): string {
  return `${count} reference${count === 1 ? '' : 's'}`;
}
