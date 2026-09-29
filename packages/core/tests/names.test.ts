import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData, relatedOccurrences, type AnalysisContext, type DocumentAnalysis } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);

function analyze(text: string, context: AnalysisContext = {}): DocumentAnalysis {
  return analyzeText(text, { schemas: game.schemas, properties: game.properties, ...context });
}

/** One line per item: `kind scope name: definitions/references`. */
function items(analysis: DocumentAnalysis): string[] {
  return (analysis.names?.items ?? []).map((item) => `${item.kind} ${item.scope} ${item.name}: ${item.definitions.length}/${item.references.length}`);
}

function report(analysis: DocumentAnalysis): string[] {
  return analysis.diagnostics
    .filter((diagnostic) => ['label-undefined', 'name-duplicate', 'cue-undefined'].includes(String(diagnostic.code)))
    .map(
      (diagnostic) =>
        `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`
    );
}

const aiText = [
  '<aiscript name="a">',
  '  <interrupts>',
  '    <library>',
  '      <actions name="LibActions">',
  '        <abort_called_scripts resume="start"/>',
  '      </actions>',
  '      <handler name="LibHandler"/>',
  '      <conditions name="LibConditions"/>',
  '    </library>',
  '    <handler ref="LibHandler"/>',
  '    <handler ref="OtherHandler"/>',
  '    <handler>',
  '      <conditions ref="LibConditions"/>',
  '      <actions>',
  '        <abort_called_scripts resume="loop"/>',
  '        <resume label="gone"/>',
  '        <include_interrupt_actions ref="LibActions"/>',
  '      </actions>',
  '    </handler>',
  '  </interrupts>',
  '  <init>',
  '    <include_interrupt_actions ref="Elsewhere"/>',
  '  </init>',
  '  <attention min="unknown">',
  '    <actions>',
  '      <label name="loop"/>',
  '      <resume label="loop"/>',
  '      <resume label="nowhere"/>',
  '    </actions>',
  '  </attention>',
  '  <attention min="visible">',
  '    <actions>',
  '      <label name="loop"/>',
  '      <label name="only"/>',
  '      <label name="only"/>',
  '      <resume label=" only "/>',
  '    </actions>',
  '  </attention>',
  '</aiscript>',
  '',
].join('\n');

const mdText = [
  '<mdscript name="S">',
  '  <cues>',
  '    <cue name="Start">',
  '      <actions>',
  '        <signal_cue_instantly cue="Next"/>',
  '        <set_value name="$x" exact="Next.$y + md.S.Next.$z + md.Other.Cue.$w + player.money"/>',
  '        <include_actions ref="Lib"/>',
  '        <cancel_cue cue="Missing"/>',
  '        <set_value name="$t" exact="Typo.$x"/>',
  '        <set_value name="$u" exact="@Maybe.$x + Perhaps?"/>',
  '        <set_value name="$v" exact="md.S.Gone"/>',
  '        <debug_text text="some_sound_id" filter="error"/>',
  '      </actions>',
  '      <cues>',
  '        <cue name="Next"/>',
  '      </cues>',
  '    </cue>',
  '    <library name="Lib">',
  '      <actions>',
  '        <cancel_cue cue="Includer"/>',
  '      </actions>',
  '    </library>',
  '    <library name="Lib"/>',
  '  </cues>',
  '</mdscript>',
  '',
].join('\n');

describe('named items of an AI script', () => {
  it('scopes labels to their attention block and resolves handler references in every block', () => {
    const analysis = analyze(aiText);
    expect(items(analysis)).toEqual([
      'actions script LibActions: 1/1',
      'handler script LibHandler: 1/1',
      'conditions script LibConditions: 1/1',
      'label attention#0 loop: 1/2',
      'label attention#1 loop: 1/1',
      'label attention#1 only: 2/1',
      'label external start: 0/1',
      'handler script OtherHandler: 0/1',
      'label script gone: 0/1',
      'actions script Elsewhere: 0/1',
      'label attention#0 nowhere: 0/1',
    ]);
    const handlerReference = analysis.names?.occurrences.find(
      (occurrence) => occurrence.kind === 'label' && occurrence.element.name === 'abort_called_scripts' && occurrence.name === 'loop'
    );
    expect(handlerReference?.items.map((item) => item.scope)).toEqual(['attention#0', 'attention#1']);
    expect(analysis.names?.occurrences.find((occurrence) => occurrence.name === 'start')?.external).toBe(true);
    const trimmed = analysis.names?.occurrences.find((occurrence) => occurrence.role === 'reference' && occurrence.name === 'only');
    expect(trimmed && aiText.slice(trimmed.start, trimmed.end)).toBe('only');
  });

  it('reports duplicate and undefined labels, not library items of other scripts', () => {
    expect(report(analyze(aiText))).toEqual([
      "16:24 2 label-undefined: Label 'gone' is not defined in any attention block",
      "28:22 2 label-undefined: Label 'nowhere' is not defined in this attention block",
      "35:20 2 name-duplicate: Label 'only' is already defined in this attention block at line 34",
    ]);
    expect(report(analyze(aiText, { validateNames: false }))).toEqual([]);
  });

  it('connects every occurrence a rename has to change', () => {
    const analysis = analyze(aiText);
    const definition = analysis.names?.occurrences.find((occurrence) => occurrence.role === 'definition' && occurrence.name === 'loop');
    const lines = definition ? relatedOccurrences(definition).map((occurrence) => analysis.document.positionAt(occurrence.start).line + 1) : [];
    // The handler names `loop` for both blocks, so both definitions and every reference go together.
    expect(lines).toEqual([15, 26, 27, 33]);
  });

  it('offers the labels a reference may name', () => {
    const analysis = analyze(aiText);
    const names = analysis.names;
    const at = (line: number) => analysis.structure?.elements.find((element) => analysis.document.positionAt(element.start).line + 1 === line);
    const visible = (kind: 'label' | 'actions', line: number): string[] => {
      const element = at(line);
      return element && names ? names.visible(kind, element).map((item) => item.name) : [];
    };
    expect(visible('label', 27)).toEqual(['loop']);
    expect(visible('label', 36)).toEqual(['loop', 'only']);
    expect(visible('label', 15)).toEqual(['loop', 'only']);
    expect(visible('label', 5)).toEqual([]);
    expect(visible('actions', 22)).toEqual(['LibActions']);
  });
});

describe('named items of a Mission Director script', () => {
  it('collects cues, their references by name and through the script name', () => {
    const analysis = analyze(mdText);
    expect(items(analysis)).toEqual([
      'cue script Start: 1/0',
      'cue script Next: 1/3',
      'cue script Lib: 2/1',
      'cue script Missing: 0/1',
      'cue script Typo: 0/1',
      'cue script Maybe: 0/1',
      'cue script Perhaps: 0/1',
      'cue script Gone: 0/1',
      'cue script Includer: 0/1',
    ]);
    const guarded = (name: string) => analysis.names?.occurrences.find((occurrence) => occurrence.name === name)?.guarded;
    expect(guarded('Maybe')).toBe(true);
    expect(guarded('Perhaps')).toBe(true);
    expect(guarded('Typo')).toBe(false);
    expect(analysis.names?.occurrences.find((occurrence) => occurrence.name === 'Includer')?.external).toBe(true);
    const throughScript = analysis.names?.occurrences.find(
      (occurrence) => occurrence.name === 'Next' && occurrence.element.name === 'set_value' && mdText.slice(occurrence.start - 5, occurrence.start) === 'md.S.'
    );
    expect(throughScript).toBeDefined();
  });

  it('reports duplicate cue names and unknown names, which can be left out', () => {
    // Not `Maybe` and `Perhaps` (guarded), not `Includer` (a library resolves it in the including script).
    expect(report(analyze(mdText))).toEqual([
      "8:26 2 cue-undefined: 'Missing' is no keyword and no cue of this script",
      "9:37 2 cue-undefined: 'Typo' is no keyword and no cue of this script",
      "11:42 2 cue-undefined: 'Gone' is no keyword and no cue of this script",
      "23:20 2 name-duplicate: Library 'Lib' is already defined at line 18",
    ]);
    expect(report(analyze(mdText, { validateCueReferences: false }))).toEqual(["23:20 2 name-duplicate: Library 'Lib' is already defined at line 18"]);
  });

  it('needs the script properties to tell an unknown bare name from a keyword', () => {
    const analysis = analyzeText(mdText, { schemas: game.schemas });
    // `md.S.Gone` names a cue of this script by its syntax alone; bare names need the keyword list.
    expect(items(analysis).filter((line) => line.includes(' 0/'))).toEqual(['cue script Gone: 0/1']);
    expect(report(analysis)).toEqual([
      "11:42 2 cue-undefined: 'Gone' is no keyword and no cue of this script",
      "23:20 2 name-duplicate: Library 'Lib' is already defined at line 18",
    ]);
  });
});

describe('named items while typing', () => {
  it('keeps collecting around unclosed tags and values', () => {
    const analysis = analyze(
      [
        '<aiscript name="a">',
        '  <attention min="unknown">',
        '    <actions>',
        '      <label name="loop"/>',
        '      <resume label="loop"',
        '      <label name=',
        '      <resume label="lo',
        '    </actions>',
        '  </attention>',
        '</aiscript>',
      ].join('\n')
    );
    expect(items(analysis)[0]).toBe('label attention#0 loop: 1/1');
    expect(report(analysis).every((line) => !line.includes("'loop'"))).toBe(true);
  });

  it('collects cue references in a value whose quote is not closed', () => {
    const analysis = analyze(
      [
        '<mdscript name="S">',
        '  <cues>',
        '    <cue name="Start">',
        '      <actions>',
        '        <signal_cue_instantly cue="Start',
        '      </actions>',
        '    </cue>',
        '  </cues>',
        '</mdscript>',
      ].join('\n')
    );
    expect(items(analysis)).toEqual(['cue script Start: 1/1']);
  });
});
