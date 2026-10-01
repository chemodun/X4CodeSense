import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import {
  analyzeComparisonSide,
  analyzeText,
  comparisonSideOf,
  completionAt,
  hoverAt,
  loadGameData,
  newProblems,
  patchAfterScheme,
  patchBeforeScheme,
  type AnalysisContext,
  type DocumentAnalysis,
} from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);
const context: AnalysisContext = { schemas: game.schemas, properties: game.properties };

const patchUri = 'file:///c%3A/mods/patcher/md/setup.xml';
/** A side's uri as VS Code sends it: the query, `patch=<uri>`, encoded once more. */
const vscodeUri = (scheme: string, name: string): string => `${scheme}:/${name}?${encodeURIComponent(new URLSearchParams({ patch: patchUri }).toString())}`;

describe('sides of a patch comparison', () => {
  it('knows a side by its scheme, and its patch by the query, however often encoded', () => {
    expect(comparisonSideOf(vscodeUri(patchAfterScheme, 'md/setup.xml'))).toEqual({ side: 'after', patch: patchUri });
    expect(comparisonSideOf(vscodeUri(patchBeforeScheme, 'before/md/setup.xml'))).toEqual({ side: 'before', patch: patchUri });
    const plain = comparisonSideOf(`${patchAfterScheme}:/md/setup.xml?${new URLSearchParams({ patch: patchUri }).toString()}`);
    expect(plain?.side).toBe('after');
    expect(decodeURIComponent(plain?.patch ?? '')).toBe(decodeURIComponent(patchUri));
    expect(comparisonSideOf(`${patchAfterScheme}:/md/setup.xml`)).toBeUndefined();
    expect(comparisonSideOf(patchUri)).toBeUndefined();
    expect(comparisonSideOf('untitled:Untitled-1')).toBeUndefined();
  });

  it('analyses a side as the file the patch changes, when that is known', () => {
    const uri = vscodeUri(patchAfterScheme, 'md/setup.xml');
    const document = TextDocument.create(uri, 'xml', 7, '<mdscript name="S">\n  <cues/>\n</mdscript>\n');
    const target = fileURLToPath(new URL('./fixtures/project/game/md/setup.xml', import.meta.url));
    const analysis = analyzeComparisonSide(document, 'after', target, context);
    expect(analysis.document.uri.endsWith('/md/setup.xml#after')).toBe(true);
    expect(fileURLToPath(analysis.document.uri)).toBe(target);
    expect(analysis.document.version).toBe(7);
    expect(analysis.detection.script?.name).toBe('S');
    expect(analyzeComparisonSide(document, 'before', undefined, context).document.uri).toBe(uri);
  });

  describe('problems of the side with the patch', () => {
    const lines = [
      '<mdscript name="S">',
      '  <cues>',
      '    <cue name="A">',
      '      <actions>',
      '        <set_value name="$a" exact="1 +"/>',
      '      </actions>',
      '    </cue>',
      '    <cue name="A"/>',
      '  </cues>',
      '</mdscript>',
    ];
    const analyze = (text: string): DocumentAnalysis => analyzeText(text, context, 'untitled:side.xml');
    const before = analyze(`${lines.join('\n')}\n`);
    const summary = (analysis: DocumentAnalysis, before?: DocumentAnalysis): string[] =>
      newProblems(analysis, before).map((problem) => `${problem.range.start.line + 1} ${String(problem.code)}`);

    it("are those the side before it does not have, the target's own moved or not", () => {
      expect(before.diagnostics.length).toBeGreaterThanOrEqual(2);
      expect(before.diagnostics.some((diagnostic) => String(diagnostic.message).includes('at line 3'))).toBe(true);
      // A cue brought in before A moves the target's problems down, and the line its duplicate names.
      const added = ['    <cue name="B">', '      <actions>', '        <set_value name="$b" exact="2 *"/>', '      </actions>', '    </cue>'];
      const after = analyze(`${[...lines.slice(0, 2), ...added, ...lines.slice(2)].join('\n')}\n`);
      expect(after.diagnostics.some((diagnostic) => String(diagnostic.message).includes('at line 8'))).toBe(true);
      expect(summary(after, before)).toEqual(['5 expression-syntax']);
      expect(summary(before, before)).toEqual([]);
    });

    it('count as often as the side before lacks them', () => {
      const doubled = analyze(`${[...lines.slice(0, 5), lines[4], ...lines.slice(5)].join('\n')}\n`);
      expect(summary(doubled, before)).toEqual(['6 expression-syntax']);
    });

    it('include what the patch breaks elsewhere in the script', () => {
      // A `remove` of the `set_value` leaves the read of `$count` unset, far from anything the patch brings in.
      const counting = (setValue: string[]): DocumentAnalysis =>
        analyzeText(
          [
            '<mdscript name="S">',
            '  <cues>',
            '    <cue name="A">',
            '      <actions>',
            ...setValue,
            '        <debug_text text="$count"/>',
            '      </actions>',
            '    </cue>',
            '  </cues>',
            '</mdscript>',
            '',
          ].join('\n'),
          { ...context, validateVariables: true },
          'untitled:side.xml'
        );
      const unpatched = counting(['        <set_value name="$count" exact="1"/>']);
      expect(unpatched.diagnostics).toEqual([]);
      expect(summary(counting([]), unpatched)).toEqual(['5 variable-undefined']);
    });

    it('are the well-formedness problems alone without an analysed side before it', () => {
      const typing = analyze(`${[...lines.slice(0, 7), '    <cue name="C', ...lines.slice(7)].join('\n')}\n`);
      const wellFormedness = typing.diagnostics
        .slice(0, typing.structure?.problems.length)
        .map((problem) => `${problem.range.start.line + 1} ${String(problem.code)}`);
      expect(wellFormedness.length).toBeGreaterThan(0);
      expect(summary(typing)).toEqual(wellFormedness);
      // The side before still shows its placeholder: no script, nothing to compare with.
      expect(summary(typing, analyze('The game files are being read'))).toEqual(wellFormedness);
      // With it, the half-typed cue's problems and nothing of the target's.
      expect(summary(typing, before)).toEqual(expect.arrayContaining(wellFormedness));
      expect(summary(typing, before).filter((problem) => problem.endsWith('expression-syntax'))).toEqual([]);
    });
  });

  describe('while typing', () => {
    const lines = [
      '<mdscript name="S">',
      '  <cues>',
      '    <cue name="A">',
      '      <actions>',
      '        <set_value name="$x" exact="player.ship."/>',
      '        <set_value name="$y" exact="player',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
    ];
    const text = `${lines.join('\n')}\n`;
    const side = analyzeComparisonSide(TextDocument.create(vscodeUri(patchAfterScheme, 'md/s.xml'), 'xml', 1, text), 'after', undefined, context);
    const offset = (line: number, needle: string, delta: number): number => side.document.offsetAt({ line, character: lines[line].indexOf(needle) + delta });

    it('hovers and completes in a half-typed side', () => {
      const hover = hoverAt(side, offset(4, 'player', 2), game);
      expect(hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '').toContain('**player** *(keyword)*');
      const labels = completionAt(side, offset(4, 'player.ship.', 'player.ship.'.length), game).map((item) => item.label);
      expect(labels).toContain('pilot');
      expect(newProblems(side, undefined).length).toBeGreaterThan(0);
    });
  });
});
