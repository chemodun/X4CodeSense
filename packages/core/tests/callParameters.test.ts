import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem, Location, MarkupContent } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  callSignatureHelp,
  callTarget,
  completionAt,
  definitionAt,
  hoverAt,
  loadGameData,
  parseXml,
  quickFixes,
  ScriptIndex,
  type DocumentAnalysis,
  type GameData,
} from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const folder = path.join(path.parse(unpacked).root, 'x4-call-parameters');
const file = (relative: string): string => path.join(folder, relative);

const targets: Record<string, string[]> = {
  'aiscripts/move.go.xml': [
    '<aiscript name="move.go">',
    '  <params>',
    '    <param name="destination" comment="Where to go"/>',
    '    <param name="speed" default="1"/>',
    '  </params>',
    '</aiscript>',
  ],
  'aiscripts/order.attack.xml': [
    '<aiscript name="order.attack">',
    '  <order id="Attack" name="{1001, 1}">',
    '    <params>',
    '      <param name="target" type="object" text="The target" required="true"/>',
    '      <param name="range" type="number" default="10km"/>',
    '      <param name="pursue" default="if this.ship.isplayerowned then true else false"/>',
    '    </params>',
    '  </order>',
    '</aiscript>',
  ],
  'aiscripts/move.bare.xml': ['<aiscript name="move.bare">', '  <attention min="unknown">', '    <actions/>', '  </attention>', '</aiscript>'],
  'aiscripts/move.empty.xml': ['<aiscript name="move.empty">', '  <params/>', '  <attention min="unknown">', '    <actions/>', '  </attention>', '</aiscript>'],
  'md/lib.xml': [
    '<mdscript name="Lib">',
    '  <cues>',
    '    <library name="Reward" purpose="run_actions">',
    '      <params>',
    '        <param name="Amount" default="1" comment="How much"/>',
    '        <param name="Faction"/>',
    '      </params>',
    '    </library>',
    '  </cues>',
    '</mdscript>',
  ],
};

const mdCaller = [
  '<mdscript name="Caller">',
  '  <cues>',
  '    <library name="Local">',
  '      <params>',
  '        <param name="Own"/>',
  '      </params>',
  '    </library>',
  '    <cue name="Start">',
  '      <actions>',
  '        <run_actions ref="md.Lib.Reward">',
  '          <param name="Amount" value="2"/>',
  '          <param name="" value="3"/>',
  '        </run_actions>',
  '        <run_actions ref="Local">',
  '          <param name="Own" value="1"/>',
  '        </run_actions>',
  '        <run_actions ref="$library">',
  '          <param name="Amount" value="2"/>',
  '        </run_actions>',
  '      </actions>',
  '    </cue>',
  '    <cue name="Instance" ref="md.Lib.Reward">',
  '      <param name="Faction" value="faction.argon"/>',
  '    </cue>',
  '  </cues>',
  '</mdscript>',
  '',
].join('\n');

const aiCaller = [
  '<aiscript name="caller">',
  '  <attention min="unknown">',
  '    <actions>',
  '      <run_script name="\'move.go\'">',
  '        <param name="speed" value="2"/>',
  '        <param name="nope" value="1"/>',
  '      </run_script>',
  '      <create_order object="this.ship" id="\'Attack\'">',
  '        <param name="target" value="null"/>',
  '      </create_order>',
  '      <run_script name="$script">',
  '        <param name="speed" value="2"/>',
  '      </run_script>',
  '    </actions>',
  '  </attention>',
  '</aiscript>',
  '',
].join('\n');

function gameWithTargets(): GameData {
  const game = loadGameData(unpacked);
  const index = new ScriptIndex();
  for (const [relative, lines] of Object.entries(targets)) {
    // As open documents: their text is the index's, no file on disk needed.
    const text = `${lines.join('\n')}\n`;
    index.setStructure(file(relative), text, parseXml(text), 'game', true);
  }
  game.index = index;
  return game;
}

const game = gameWithTargets();
const md = analyzeText(mdCaller, { schemas: game.schemas }, pathToFileURL(file('md/caller.xml')).toString());
const ai = analyzeText(aiCaller, { schemas: game.schemas }, pathToFileURL(file('aiscripts/caller.xml')).toString());

/** The offset inside the first occurrence of `part` on the first line holding `line`. */
function offsetOf(text: string, line: string, part: string, into = 1): number {
  const start = text.indexOf(line);
  return start + line.indexOf(part) + into;
}

const hoverText = (analysis: DocumentAnalysis, offset: number): string | undefined =>
  (hoverAt(analysis, offset, game)?.contents as MarkupContent | undefined)?.value;
const where = (locations: Location[]): string[] =>
  locations.map((location) => `${path.basename(fileURLToPath(location.uri))}:${location.range.start.line}:${location.range.start.character}`);
/** The labels in the order the editor shows them: by `sortText`. */
const labels = (items: CompletionItem[]): string[] =>
  [...items].sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label)).map((item) => item.label);

describe('call parameters', () => {
  it('resolves what a call calls when it is written literally: a script, an order, a library here or in another script', () => {
    const calls = [...md.structure!.elements, ...ai.structure!.elements].filter((element) =>
      ['run_actions', 'cue', 'run_script', 'create_order'].includes(element.name)
    );
    const resolved = calls.map((call) => {
      const analysis = md.structure!.elements.includes(call) ? md : ai;
      const target = callTarget(analysis, call, game.index);
      return target ? `${target.kind} ${target.name}: ${target.parameters.map((parameter) => parameter.name).join(', ')}` : `${call.name}: none`;
    });
    expect(resolved).toEqual([
      'cue: none',
      'library md.Lib.Reward: Amount, Faction',
      'library md.Caller.Local: Own',
      'run_actions: none',
      'library md.Lib.Reward: Amount, Faction',
      'script move.go: destination, speed',
      'order Attack: target, range, pursue',
      'run_script: none',
    ]);
  });

  it('completes the parameters a call does not pass yet, those without a default first', () => {
    expect(labels(completionAt(md, offsetOf(mdCaller, '<param name="" value="3"/>', 'name=""', 6), game))).toEqual(['Faction']);
    expect(labels(completionAt(md, offsetOf(mdCaller, '<param name="Amount" value="2"/>', 'Amount'), game))).toEqual(['Faction', 'Amount']);
    const order = completionAt(ai, offsetOf(aiCaller, '<param name="target"', 'target'), game);
    expect(labels(order)).toEqual(['target', 'range', 'pursue']);
    expect(order[1].detail).toBe('= 10km');
    // A call whose target is a value: nothing to offer.
    expect(completionAt(md, offsetOf(mdCaller, '<run_actions ref="$library">\n          <param name="Amount"', 'name="Amount"', 7), game)).toEqual([]);
  });

  it('hovers a passed parameter with its declaration, and one the target does not declare with those it does', () => {
    expect(hoverText(md, offsetOf(mdCaller, '<param name="Faction" value="faction.argon"/>', 'Faction'))).toBe(
      ['**Faction** *(parameter of library `md.Lib.Reward`)*', '', 'No default', '', 'In lib.xml of `game`, line 6'].join('\n')
    );
    expect(hoverText(ai, offsetOf(aiCaller, '<param name="target"', 'target'))).toBe(
      [
        '**target** *(parameter of order `Attack` of `order.attack`)*',
        '',
        'The target',
        '',
        'No default · Type: `object` · Required: `true`',
        '',
        'In order.attack.xml of `game`, line 4',
      ].join('\n')
    );
    expect(hoverText(ai, offsetOf(aiCaller, '<param name="nope"', 'nope'))).toBe(
      ['**nope** is no parameter of script `move.go`.', '', 'Its parameters: `destination`, `speed`'].join('\n')
    );
    // A library of the same script: its parameter is a variable of the library, as before.
    expect(hoverText(md, offsetOf(mdCaller, '<param name="Own" value="1"/>', 'Own'))).toMatch(/^\*\*\$Own\*\* \*\(variable of library `Local`\)\*/);
  });

  it('goes from a passed parameter to its declaration in the target', () => {
    expect(where(definitionAt(md, offsetOf(mdCaller, '<param name="Amount" value="2"/>', 'Amount'), game))).toEqual(['lib.xml:4:21']);
    expect(where(definitionAt(ai, offsetOf(aiCaller, '<param name="speed" value="2"/>', 'speed'), game))).toEqual(['move.go.xml:3:17']);
    expect(where(definitionAt(ai, offsetOf(aiCaller, '<param name="target"', 'target'), game))).toEqual(['order.attack.xml:3:19']);
    expect(definitionAt(ai, offsetOf(aiCaller, '<param name="nope"', 'nope'), game)).toEqual([]);
  });

  it('shows the parameters of a call in signature help, the one under the caret or the first not passed active', () => {
    const help = (analysis: DocumentAnalysis, offset: number): string | undefined => {
      const found = callSignatureHelp(analysis, offset, game);
      const signature = found?.signatures[0];
      const active = signature?.parameters?.[found?.activeParameter ?? 0]?.label as [number, number] | undefined;
      return signature && active ? `${signature.label} [${signature.label.slice(active[0], active[1])}]` : undefined;
    };
    expect(help(ai, offsetOf(aiCaller, '<param name="speed" value="2"/>', 'value', 8))).toBe('move.go(destination, speed = 1) [speed]');
    // In the call's own start tag: the first parameter it does not pass.
    expect(help(ai, offsetOf(aiCaller, '<run_script name="\'move.go\'">', 'name'))).toBe('move.go(destination, speed = 1) [destination]');
    // A long default shows as `…`; the parameter's documentation has it.
    expect(help(ai, offsetOf(aiCaller, '<create_order', 'object'))).toBe('Attack(target, range = 10km, pursue = …) [range]');
    expect(callSignatureHelp(ai, offsetOf(aiCaller, '<create_order', 'object'), game)?.signatures[0].parameters?.[2].documentation).toEqual({
      kind: 'markdown',
      value: 'Default: `if this.ship.isplayerowned then true else false`',
    });
    expect(help(md, offsetOf(mdCaller, '<cue name="Instance"', 'Instance'))).toBe('md.Lib.Reward(Amount = 1, Faction) [Amount]');
    expect(help(ai, offsetOf(aiCaller, '<run_script name="$script">', 'name'))).toBeUndefined();
    expect(help(ai, offsetOf(aiCaller, '<attention', 'min'))).toBeUndefined();
  });

  it('reports a parameter the target does not declare, and offers the declared names close to it', () => {
    const unknown = (analysis: DocumentAnalysis): string[] =>
      analysis.diagnostics
        .filter((diagnostic) => diagnostic.code === 'param-unknown')
        .map((diagnostic) => `${diagnostic.range.start.line}:${diagnostic.range.start.character} ${diagnostic.severity} ${diagnostic.message}`);
    const context = { schemas: game.schemas, index: game.index };
    const checkedAi = analyzeText(aiCaller, context, pathToFileURL(file('aiscripts/caller.xml')).toString());
    // Warning (2); the call to a value is not checked.
    expect(unknown(checkedAi)).toEqual(["5:21 2 'nope' is not a parameter of script 'move.go'"]);
    const checkedMd = analyzeText(
      mdCaller.replace('name="Amount" value="2"/>\n          <param name=""', 'name="Amonut" value="2"/>\n          <param name=""'),
      context,
      pathToFileURL(file('md/caller.xml')).toString()
    );
    expect(unknown(checkedMd)).toEqual(["10:23 2 'Amonut' is not a parameter of library 'md.Lib.Reward'"]);
    const fixes = quickFixes(
      checkedMd,
      checkedMd.diagnostics.filter((diagnostic) => diagnostic.code === 'param-unknown'),
      game
    );
    expect(fixes.map((fix) => `${fix.title}${fix.isPreferred ? ' (preferred)' : ''}`)).toEqual(["Change to 'Amount' (preferred)"]);
    // Without the index only a library of the same script is found: nothing to report here.
    expect(unknown(analyzeText(aiCaller, { schemas: game.schemas }, pathToFileURL(file('aiscripts/caller.xml')).toString()))).toEqual([]);
    expect(unknown(analyzeText(aiCaller, { ...context, validateCallParameters: false }, pathToFileURL(file('aiscripts/caller.xml')).toString()))).toEqual([]);
  });

  it('adds a parameter the call passes to what it calls, with its other parameters or in a new <params>', () => {
    const context = { schemas: game.schemas, index: game.index };
    const caller = (text: string, relative: string): DocumentAnalysis => analyzeText(text, context, pathToFileURL(file(relative)).toString());
    const fixesOf = (analysis: DocumentAnalysis, data: GameData = game): string[] =>
      quickFixes(
        analysis,
        analysis.diagnostics.filter((diagnostic) => diagnostic.code === 'param-unknown'),
        data
      ).map((fix) => fix.title);
    /** The target's text after the fix with the title, which changes only that file. */
    const targetAfter = (analysis: DocumentAnalysis, title: string, relative: string): string => {
      const action = quickFixes(analysis, analysis.diagnostics, game).find((candidate) => candidate.title === title);
      const uri = pathToFileURL(file(relative)).toString();
      expect(Object.keys(action?.edit?.changes ?? {})).toEqual([uri]);
      return TextDocument.applyEdits(TextDocument.create(uri, 'xml', 0, `${targets[relative].join('\n')}\n`), action?.edit?.changes?.[uri] ?? []);
    };

    const ai = caller(
      aiCaller
        .replace('<param name="target" value="null"/>', '<param name="target" value="null"/>\n        <param name="extra" value="1"/>')
        .replace(
          '<run_script name="$script">',
          '<run_script name="\'move.bare\'"><param name="first" value="1"/></run_script>\n      <run_script name="$script">'
        )
        .replace(
          '<run_script name="$script">',
          '<run_script name="\'move.empty\'"><param name="only" value="1"/></run_script>\n      <run_script name="$script">'
        ),
      'aiscripts/caller.xml'
    );
    expect(fixesOf(ai)).toEqual([
      "Add the parameter 'nope' to script 'move.go'",
      "Add the parameter 'extra' to order 'Attack' of 'order.attack'",
      "Add the parameter 'first' to script 'move.bare'",
      "Add the parameter 'only' to script 'move.empty'",
    ]);
    expect(targetAfter(ai, "Add the parameter 'nope' to script 'move.go'", 'aiscripts/move.go.xml')).toContain(
      '    <param name="speed" default="1"/>\n    <param name="nope"/>\n  </params>'
    );
    expect(targetAfter(ai, "Add the parameter 'extra' to order 'Attack' of 'order.attack'", 'aiscripts/order.attack.xml')).toContain(
      '      <param name="pursue" default="if this.ship.isplayerowned then true else false"/>\n      <param name="extra"/>\n    </params>\n  </order>'
    );
    // Where the schema allows a <params>: before the attention blocks.
    expect(targetAfter(ai, "Add the parameter 'first' to script 'move.bare'", 'aiscripts/move.bare.xml')).toBe(
      '<aiscript name="move.bare">\n  <params>\n    <param name="first"/>\n  </params>\n  <attention min="unknown">\n    <actions/>\n  </attention>\n</aiscript>\n'
    );
    expect(targetAfter(ai, "Add the parameter 'only' to script 'move.empty'", 'aiscripts/move.empty.xml')).toContain(
      '<aiscript name="move.empty">\n  <params>\n    <param name="only"/>\n  </params>\n  <attention'
    );

    const md = caller(
      mdCaller
        .replace('<param name="Own" value="1"/>', '<param name="Own" value="1"/>\n          <param name="Mine" value="2"/>')
        .replace('<param name="Faction" value="faction.argon"/>', '<param name="Faction" value="faction.argon"/>\n      <param name="Bonus" value="3"/>'),
      'md/caller.xml'
    );
    expect(fixesOf(md)).toEqual(["Add the parameter 'Mine' to library 'md.Caller.Local'", "Add the parameter 'Bonus' to library 'md.Lib.Reward'"]);
    expect(targetAfter(md, "Add the parameter 'Bonus' to library 'md.Lib.Reward'", 'md/lib.xml')).toContain(
      '        <param name="Faction"/>\n        <param name="Bonus"/>\n      </params>'
    );
    // A library of this script: the edit is this document's.
    const own = quickFixes(md, md.diagnostics, game).find((fix) => fix.title === "Add the parameter 'Mine' to library 'md.Caller.Local'");
    const ownText = TextDocument.applyEdits(md.document, own?.edit?.changes?.[md.document.uri] ?? []);
    expect(ownText).toContain('        <param name="Own"/>\n        <param name="Mine"/>\n      </params>');
    expect(caller(ownText, 'md/caller.xml').diagnostics.filter((diagnostic) => diagnostic.message.startsWith("'Mine'"))).toEqual([]);

    // Scripts of the game are not changed.
    expect(fixesOf(ai, { ...game, folder })).toEqual([]);
  });

  describe('while typing', () => {
    it('completes and helps in a parameter being written, and a call whose start tag is not closed', () => {
      const typing = aiCaller.replace('<param name="nope" value="1"/>', '<param name="');
      const analysis = analyzeText(typing, { schemas: game.schemas }, pathToFileURL(file('aiscripts/caller.xml')).toString());
      const offset = typing.indexOf('<param name="\n') + '<param name="'.length;
      expect(labels(completionAt(analysis, offset, game))).toEqual(['destination']);
      expect(callSignatureHelp(analysis, offset, game)?.signatures[0].label).toBe('move.go(destination, speed = 1)');

      const open = '<aiscript name="caller">\n  <attention min="unknown">\n    <actions>\n      <create_order id="\'Attack\'" ';
      const cut = analyzeText(open, { schemas: game.schemas }, pathToFileURL(file('aiscripts/caller.xml')).toString());
      expect(callSignatureHelp(cut, open.length, game)?.signatures[0].label).toBe('Attack(target, range = 10km, pursue = …)');
      // Every cut of the callers answers without throwing.
      for (const text of [mdCaller, aiCaller]) {
        for (let end = 0; end <= text.length; end += 13) {
          const part = analyzeText(
            text.slice(0, end),
            { schemas: game.schemas },
            pathToFileURL(file(text === mdCaller ? 'md/caller.xml' : 'aiscripts/caller.xml')).toString()
          );
          expect(() => [
            callSignatureHelp(part, end, game),
            hoverAt(part, end, game),
            completionAt(part, end, game),
            definitionAt(part, end, game),
          ]).not.toThrow();
        }
      }
    });
  });
});
