import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, foldingRanges, loadGameData, type AnalysisContext } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);
const withSchemas: AnalysisContext = { schemas: game.schemas, properties: game.properties };

/** The folding ranges as `first-last kind`, with lines counted from 1; undefined when the document is not folded here. */
function folds(text: string, uri?: string): string[] | undefined {
  return foldingRanges(analyzeText(text, withSchemas, uri))?.map((range) => `${range.startLine + 1}-${range.endLine + 1}${range.kind ? ` ${range.kind}` : ''}`);
}

describe('folding', () => {
  it('folds each element that spans lines up to its end tag, and each comment that spans lines', () => {
    const text = `<?xml version="1.0" encoding="utf-8"?>
<mdscript name="Folds">
  <cues>
    <!--
      The first cue.
    -->
    <cue name="Start">
      <conditions><event_game_started/></conditions>
      <actions>
        <do_if value="true">
          <set_value name="$x" exact="1"/>
        </do_if>
        <do_else>
          <set_value name="$x"
                     exact="2"/>
        </do_else>
        <!-- one line -->
      </actions>
    </cue>
  </cues>
</mdscript>
`;
    expect(folds(text)).toEqual(['2-20', '3-19', '4-6 comment', '7-18', '9-17', '10-11', '13-15', '14-15']);
  });

  it('folds an end tag that shares its line with content along with it', () => {
    const text = `<mdscript name="Folds">
  <cues>
    <cue name="Start">
      <actions/></cue></cues>
</mdscript>
`;
    expect(folds(text)).toEqual(['1-4', '2-4', '3-4']);
  });

  it('folds from a #region comment to its #endregion, nested', () => {
    const text = `<mdscript name="Folds">
  <cues>
    <!-- #region Setup -->
    <cue name="A"/>
    <!-- #region inner -->
    <cue name="B"/>
    <!-- #endregion -->
    <!-- #endregion -->
    <!-- #endregion without a start -->
    <!--region name="not a marker"-->
  </cues>
</mdscript>
`;
    expect(folds(text)).toEqual(['1-11', '2-10', '3-8 region', '5-7 region']);
  });

  it('folds patch documents, and leaves other XML to other tooling', () => {
    const patch = `<diff>
  <add sel="/mdscript/cues">
    <cue name="Added"/>
  </add>
</diff>
`;
    expect(folds(patch, 'file:///ext/md/folds.xml')).toEqual(['1-4', '2-3']);
    expect(folds('<language id="44">\n  <page id="1">\n  </page>\n</language>\n', 'file:///ext/t/0001-l044.xml')).toBeUndefined();
  });

  it('folds while typing: an element not closed folds up to where it is cut off', () => {
    const text = `<mdscript name="Folds">
  <cues>
    <cue name="Start">
      <actions>
        <do_if value="true">
          <set_value name="$x" exact="1"/>
      </actions>
    </cue>
    <cue name="Next"
  </cues>
</mdscript>
`;
    expect(folds(text)).toEqual(['1-10', '2-9', '3-7', '4-6', '5-6']);
    expect(folds(`<mdscript name="Folds">\n  <cues>\n    <!-- not closed\n    <cue name="A"/>\n`)).toEqual(['1-4', '2-4', '3-5 comment']);
  });
});
