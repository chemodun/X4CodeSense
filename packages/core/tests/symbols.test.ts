import { fileURLToPath } from 'node:url';
import { SymbolKind, type DocumentSymbol, type Range } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import { analyzeText, documentSymbols, loadGameData, type AnalysisContext, type OutlineTexts } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);
const withSchemas: AnalysisContext = { schemas: game.schemas, properties: game.properties };

const kindNames = new Map<number, string>(Object.entries(SymbolKind).map(([name, kind]) => [kind, name]));

/** The outline as lines: indented name, kind and detail. */
function outline(text: string, context: AnalysisContext = withSchemas, uri?: string, texts?: OutlineTexts): string[] {
  const lines: string[] = [];
  const add = (symbols: DocumentSymbol[], depth: number): void => {
    for (const symbol of symbols) {
      lines.push(`${'  '.repeat(depth)}${symbol.name} (${kindNames.get(symbol.kind)})${symbol.detail ? `: ${symbol.detail}` : ''}`);
      add(symbol.children ?? [], depth + 1);
    }
  };
  add(documentSymbols(analyzeText(text, context, uri), texts), 0);
  return lines;
}

const before = (a: Range['start'], b: Range['start']): boolean => a.line < b.line || (a.line === b.line && a.character <= b.character);
const inside = (inner: Range, outer: Range): boolean => before(outer.start, inner.start) && before(inner.end, outer.end);

/** Every symbol has a name, its selection inside its range, and its range inside its parent's. */
function checkShape(symbols: DocumentSymbol[], parent?: DocumentSymbol): void {
  for (const symbol of symbols) {
    expect(symbol.name).not.toBe('');
    expect(inside(symbol.selectionRange, symbol.range)).toBe(true);
    if (parent) {
      expect(inside(symbol.range, parent.range)).toBe(true);
    }
    checkShape(symbol.children ?? [], symbol);
  }
}

const mdScript = `<mdscript name="Outline">
  <cues>
    <cue name="Start" instantiate="true" namespace="this">
      <conditions>
        <event_object_destroyed object="player.ship"/>
      </conditions>
      <actions>
        <set_value name="$count" exact="1"/>
        <run_actions ref="Lib">
          <param name="target" value="player.ship"/>
        </run_actions>
      </actions>
      <cues>
        <cue name="Inner">
          <actions>
            <set_value name="$inner" exact="player.ship"/>
            <set_value name="Later.$remote" exact="2"/>
          </actions>
        </cue>
      </cues>
    </cue>
    <cue name="Later"/>
    <library name="Lib" purpose="run_actions">
      <params>
        <param name="target"/>
      </params>
      <actions>
        <set_value name="$result" exact="$target"/>
      </actions>
    </library>
    <cue name="Instance" ref="Lib">
      <param name="target" value="player.ship"/>
    </cue>
  </cues>
</mdscript>
`;

const aiScript = `<aiscript name="order.outline" version="1">
  <order id="Outline" name="Outline">
    <params>
      <param name="target" type="object" text="Target"/>
    </params>
  </order>
  <interrupts>
    <handler ref="SharedHandler"/>
    <handler>
      <conditions>
        <event_object_destroyed object="this.ship"/>
      </conditions>
      <actions>
        <set_value name="$lost" exact="1"/>
      </actions>
    </handler>
    <library>
      <actions name="Shared">
        <set_value name="$shared" exact="1"/>
      </actions>
      <handler name="SharedHandler">
        <conditions>
          <event_object_destroyed object="this.ship"/>
        </conditions>
      </handler>
    </library>
  </interrupts>
  <init>
    <set_value name="$start" exact="player.ship"/>
  </init>
  <patch sinceversion="2"/>
  <attention min="unknown">
    <actions>
      <label name="start"/>
      <set_value name="$count" exact="0"/>
      <resume label="start"/>
    </actions>
  </attention>
  <on_abort/>
</aiscript>
`;

const patchDocument = `<diff>
  <add sel="//cue[@name='Start']/cues">
    <cue name="Added">
      <actions/>
    </cue>
  </add>
  <replace sel="//cue[@name='Start']/@instantiate">false</replace>
  <remove sel="
    //cue[@name='Old']"/>
  <add sel="//cue[@name='Start']" type="@comment">x</add>
</diff>
`;

describe('document symbols', () => {
  // The call to Lib in Start sets `$target` in Lib's table before Lib's own parameter does: it stays a parameter.
  it('outlines a Mission Director script: cues as they nest, libraries, parameters and variables', () => {
    expect(outline(mdScript)).toEqual([
      'Outline (Module)',
      '  Start (Event): instantiated, namespace this',
      '    $count (Variable): integer',
      '    Inner (Event)',
      '      $inner (Variable): ship, of cue Start',
      '      $remote (Variable): integer, of cue Later',
      '  Later (Event)',
      '  Lib (Function): library, purpose run_actions',
      '    $target (Property): param',
      '    $result (Variable)',
      '  Instance (Event): instance of Lib',
      '    $target (Property): param',
    ]);
  });

  it('outlines an AI script: order, interrupts, blocks, labels and variables where they are first set', () => {
    expect(outline(aiScript)).toEqual([
      'order.outline (Module)',
      '  Outline (Interface): order',
      '    $target (Property): param, object',
      '  interrupts (Namespace)',
      '    SharedHandler (Event): handler ref',
      '    handler (Event): event_object_destroyed',
      '      $lost (Variable): integer',
      '    library (Namespace)',
      '      Shared (Function): actions',
      '        $shared (Variable): integer',
      '      SharedHandler (Event): handler',
      '  init (Constructor)',
      '    $start (Variable): ship',
      '  patch (Namespace): since version 2',
      '  attention (Namespace): min unknown',
      '    start (Key): label',
      '    $count (Variable): integer',
      '  on_abort (Event)',
    ]);
  });

  it('names an order as the game shows it, with the texts', () => {
    const named = aiScript.replace('<order id="Outline" name="Outline">', '<order id="Outline" name="{1001, 1}">');
    expect(outline(named, withSchemas, undefined, { database: game.texts })[1]).toBe('  Outline (Interface): order, Hull');
    expect(outline(aiScript, withSchemas, undefined, { database: game.texts })[1]).toBe('  Outline (Interface): order, Outline');
    expect(outline(named)[1]).toBe('  Outline (Interface): order');
  });

  it('outlines a patch: each operation by its path, with what it brings in', () => {
    expect(outline(patchDocument)).toEqual([
      'diff (Module)',
      "  //cue[@name='Start']/cues (Operator): add",
      '    Added (Event)',
      "  //cue[@name='Start']/@instantiate (Operator): replace",
      "  //cue[@name='Old'] (Operator): remove",
      "  //cue[@name='Start'] (Operator): add @comment",
    ]);
  });

  it('tells the libraries a patch brings in by its folder', () => {
    const library = '<diff>\n  <add sel="/*/interrupts">\n    <library>\n      <actions name="Shared"/>\n    </library>\n  </add>\n</diff>\n';
    expect(outline(library, withSchemas, 'file:///mod/aiscripts/order.patched.xml')).toEqual([
      'diff (Module)',
      '  /*/interrupts (Operator): add',
      '    library (Namespace)',
      '      Shared (Function): actions',
    ]);
    const cues = '<diff>\n  <add sel="//cues">\n    <library name="Lib"/>\n  </add>\n</diff>\n';
    expect(outline(cues, withSchemas, 'file:///mod/md/patched.xml').slice(2)).toEqual(['    Lib (Function): library']);
    // Outside those folders a name tells.
    expect(outline(library).slice(2)).toEqual(['    library (Namespace)', '      Shared (Function): actions']);
    expect(outline(cues).slice(2)).toEqual(['    Lib (Function): library']);
  });

  it('selects the name, and spans the element', () => {
    const analysis = analyzeText(mdScript, withSchemas);
    const start = documentSymbols(analysis)[0].children?.[0];
    const text = (range: Range): string => mdScript.slice(analysis.document.offsetAt(range.start), analysis.document.offsetAt(range.end));
    expect(start && text(start.selectionRange)).toBe('Start');
    expect(start && text(start.range)).toMatch(/^<cue name="Start"[^]*<\/cue>$/);
    const count = start?.children?.[0];
    expect(count && text(count.selectionRange)).toBe('$count');
    expect(count && text(count.range)).toBe('name="$count"');
    checkShape(documentSymbols(analysis));
  });

  it('outlines without game data, variables aside, and nothing but scripts and patches', () => {
    expect(outline(mdScript, {})).toEqual([
      'Outline (Module)',
      '  Start (Event): instantiated, namespace this',
      '    Inner (Event)',
      '  Later (Event)',
      '  Lib (Function): library, purpose run_actions',
      '    $target (Property): param',
      '  Instance (Event): instance of Lib',
      '    $target (Property): param',
    ]);
    expect(outline('<macros>\n  <macro name="ship_s_fighter_01"/>\n</macros>\n')).toEqual([]);
  });

  describe('while typing', () => {
    it('names what has no name yet after its element', () => {
      expect(outline('<mdscript name="S">\n  <cues>\n    <cue \n    <cue name="B"/>\n  </cues>\n</mdscript>\n')).toEqual([
        'S (Module)',
        '  cue (Event)',
        '  B (Event)',
      ]);
      expect(outline('<mdscript name="S">\n  <cues>\n    <cue name="Sta\n      <actions/>\n    </cue>\n  </cues>\n</mdscript>\n')).toEqual([
        'S (Module)',
        '  Sta (Event)',
      ]);
      expect(outline('<diff>\n  <add sel="">\n    <cue name="A"/>\n  </add>\n  <remove \n</diff>\n')).toEqual([
        'diff (Module)',
        '  add (Operator): add',
        '    A (Event)',
        '  remove (Operator): remove',
      ]);
    });

    it('keeps the items after a start tag that is not closed', () => {
      const cut = mdScript.replace('<cue name="Later"/>', '<cue name="Later"\n    <set_value name="$half');
      expect(outline(cut).map((line) => line.trim())).toEqual(expect.arrayContaining(['Later (Event)', 'Lib (Function): library, purpose run_actions']));
    });

    it('gives a well-formed outline at every cut of every document', () => {
      for (const text of [mdScript, aiScript, patchDocument]) {
        for (let end = 0; end <= text.length; end += 3) {
          const analysis = analyzeText(text.slice(0, end), withSchemas);
          checkShape(documentSymbols(analysis));
        }
      }
    });
  });
});
