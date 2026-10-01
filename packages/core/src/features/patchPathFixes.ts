/**
 * "Change to" for the step of a patch path that selects nothing (`patch-no-match`): the element name of
 * the step, and each value a predicate of it compares with (`cue[@name='Strat']`), changed to the names
 * close in spelling that the file has there, the same names completion in the path offers.
 */
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import { schemaOf } from '../analysis/positionContext';
import type { GameData } from '../gameData';
import { pathCompletionsAt } from './patchPaths';
import { spellingSuggestions } from './spelling';
import type { TextChange } from './textLayout';

export interface PatchPathFix {
  title: string;
  edits: TextChange[];
  preferred?: boolean;
}

/** The names completion offers at the offset changed for the written one, the closest first; preferred when no other is as close. */
function changes(analysis: DocumentAnalysis, offset: number, written: string, game: GameData): PatchPathFix[] {
  const document = analysis.document;
  const items = pathCompletionsAt(analysis, offset, game) ?? [];
  const labels = items.map((item) => item.label);
  const suggestions = spellingSuggestions(written, labels);
  return suggestions.flatMap((suggestion, index) => {
    const edit = items.find((item) => item.label === suggestion.name)?.textEdit;
    if (!edit || !('range' in edit)) {
      return [];
    }
    const preferred = index === 0 && (suggestions.length === 1 || suggestions[1].distance > suggestion.distance);
    return [
      {
        title: `Change to '${suggestion.name}'`,
        edits: [{ start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end), text: edit.newText }],
        preferred,
      },
    ];
  });
}

/** The fixes of a step of a patch path that selects nothing, the step being the text from start to end. */
export function patchPathFixes(analysis: DocumentAnalysis, start: number, end: number, game: GameData): PatchPathFix[] {
  const step = analysis.document.getText().slice(start, end);
  const fixes: PatchPathFix[] = [];
  // An element name the schema knows is meant as written (`cue` where the file has no cue), not a slip.
  const name = /^\/*([\w.:-]+)/.exec(step);
  if (name && !schemaOf(game, analysis)?.anyDeclaration(name[1])) {
    fixes.push(...changes(analysis, start + name[0].length - name[1].length, name[1], game));
  }
  // Values written in quotes after `@name =` or `. =`; values with entities are left alone.
  for (const compared of step.matchAll(/(?:@[\w.:-]+|\.)\s*!?=\s*(['"])([^'"&]*)\1/g)) {
    const valueStart = start + compared.index + compared[0].length - compared[2].length - 1;
    fixes.push(...changes(analysis, valueStart, compared[2], game));
  }
  return fixes;
}
