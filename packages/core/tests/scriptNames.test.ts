import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem, Location, MarkupContent, TextEdit } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  completionAt,
  definitionAt,
  fixAll,
  hoverAt,
  loadGameData,
  parseXml,
  prepareRenameAt,
  quickFixes,
  referencesAt,
  renameAt,
  ScriptIndex,
  type AnalysisContext,
  type DocumentAnalysis,
  type GameData,
} from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const folder = path.join(path.parse(unpacked).root, 'x4-script-names');
const file = (relative: string): string => path.join(folder, relative);

/** The scripts of the index, as open documents, in load order: the game's, then an extension's. */
const scripts: { relative: string; source: string; lines: string[] }[] = [
  {
    relative: 'game/aiscripts/move.go.xml',
    source: 'game',
    lines: [
      '<aiscript name="move.go">',
      '  <params>',
      '    <param name="destination"/>',
      '    <param name="speed" default="1"/>',
      '  </params>',
      '</aiscript>',
    ],
  },
  {
    relative: 'game/aiscripts/order.attack.xml',
    source: 'game',
    lines: [
      '<aiscript name="order.attack">',
      '  <order id="Attack" name="{1001, 1}" description="{1001, 4}" category="combat">',
      '    <params>',
      '      <param name="target"/>',
      '    </params>',
      '  </order>',
      '  <attention min="unknown">',
      '    <actions>',
      '      <run_script name="\'move.go\'"/>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
    ],
  },
  {
    relative: 'game/aiscripts/caller.xml',
    source: 'game',
    lines: [
      '<aiscript name="caller">',
      '  <attention min="unknown">',
      '    <actions>',
      '      <run_script name="\'move.go\'"/>',
      '      <create_order object="this.ship" id="\'Attack\'"/>',
      '      <clear_recurring_order_failure object="this.ship" id="\'Attack\'"/>',
      '      <run_script name="\'nothing\'"/>',
      '      <run_script name="$script"/>',
      '      <create_order object="this.ship" id="\'Attack\' + \'\'"/>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
    ],
  },
  {
    relative: 'game/md/caller.xml',
    source: 'game',
    lines: [
      '<mdscript name="Caller">',
      '  <cues>',
      '    <cue name="Start">',
      '      <actions>',
      '        <start_script object="player.ship" name="\'move.go\'"/>',
      '        <create_order object="player.ship" id="\'Attack\'"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
    ],
  },
  {
    relative: 'ext/aiscripts/move.go.xml',
    source: 'ext',
    lines: ['<aiscript name="move.go">', '  <params>', '    <param name="destination"/>', '  </params>', '</aiscript>'],
  },
];

const textOf = (relative: string): string => `${scripts.find((script) => script.relative === relative)!.lines.join('\n')}\n`;

function gameWithScripts(): GameData {
  const game = loadGameData(unpacked);
  const index = new ScriptIndex(game.schemas);
  for (const script of scripts) {
    const text = textOf(script.relative);
    index.setStructure(file(script.relative), text, parseXml(text), script.source, true);
  }
  game.index = index;
  return game;
}

const game = gameWithScripts();
const index = game.index!;
const analyze = (relative: string, text = textOf(relative)): DocumentAnalysis =>
  analyzeText(text, { schemas: game.schemas }, pathToFileURL(file(relative)).toString());
const caller = analyze('game/aiscripts/caller.xml');
const callerText = textOf('game/aiscripts/caller.xml');

/** The offset `into` characters into the first `needle` on the first line holding `line`. */
function offsetOf(text: string, line: string, needle: string, into = 1): number {
  const start = text.indexOf(line);
  return start + line.indexOf(needle) + into;
}

/** `file:line:character` of the first `needle` in a fixture file, `into` characters in: what a place is expected to be. */
function spot(relative: string, needle: string, into = 0, occurrence = 0): string {
  const lines = textOf(relative).split('\n');
  const found = lines.flatMap((text, line) =>
    [...text.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\']/g, '\\$&'), 'g'))].map((match) => ({ line, match }))
  );
  const { line, match } = found[occurrence];
  return `${relative}:${line}:${(match.index ?? 0) + into}`;
}

const place = (location: Location): string =>
  `${path.relative(folder, fileURLToPath(location.uri)).replace(/\\/g, '/')}:${location.range.start.line}:${location.range.start.character}`;
const hoverText = (analysis: DocumentAnalysis, offset: number): string | undefined =>
  (hoverAt(analysis, offset, game)?.contents as MarkupContent | undefined)?.value;
/** The labels in the order the editor shows them: by `sortText`. */
const labels = (items: CompletionItem[]): string[] =>
  [...items].sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label)).map((item) => item.label);

describe('AI script names and order ids', () => {
  it('indexes where calls name them literally, at the name inside the quotes', () => {
    const references = (kind: 'aiscript' | 'order', name: string): string[] =>
      index
        .scriptNameReferences(kind, name)
        .map((reference) => `${path.relative(folder, reference.position.file).replace(/\\/g, '/')}:${reference.position.line}:${reference.position.character}`);
    expect(references('aiscript', 'move.go')).toEqual([
      spot('game/aiscripts/order.attack.xml', "'move.go'", 1),
      spot('game/aiscripts/caller.xml', "'move.go'", 1),
      spot('game/md/caller.xml', "'move.go'", 1),
    ]);
    // `clear_recurring_order_failure id` names an order too; a value that is an expression names nothing.
    expect(references('order', 'Attack')).toEqual([
      spot('game/aiscripts/caller.xml', "'Attack'", 1, 0),
      spot('game/aiscripts/caller.xml', "'Attack'", 1, 1),
      spot('game/md/caller.xml', "'Attack'", 1),
    ]);
    expect(references('aiscript', 'nothing')).toEqual([spot('game/aiscripts/caller.xml', "'nothing'", 1)]);
    expect(index.orderIds()).toEqual(['Attack']);
  });

  it('completes the names the index knows in an empty value or a string being typed, with their quotes', () => {
    const typing = callerText.replace('<run_script name="$script"/>', '<run_script name=""/>');
    const analysis = analyze('game/aiscripts/caller.xml', typing);
    const empty = completionAt(analysis, offsetOf(typing, '<run_script name=""/>', 'name=""', 6), game);
    // First the scripts, before what may start an expression.
    expect(labels(empty).slice(0, 3)).toEqual(['caller', 'move.go', 'order.attack']);
    const quoted = callerText.replace('<run_script name="$script"/>', '<run_script name="\'mo"/>');
    const items = completionAt(analyze('game/aiscripts/caller.xml', quoted), offsetOf(quoted, '<run_script name="\'mo"/>', "'mo", 3), game);
    expect(labels(items)).toEqual(['caller', 'move.go', 'order.attack']);
    const move = items.find((item) => item.label === 'move.go')!;
    // The script a call runs: the last in load order.
    expect(move.detail).toBe('move.go.xml (ext)');
    expect((move.textEdit as TextEdit).newText).toBe("'move.go'");
    expect(move.filterText).toBe("'move.go'");
    const line = quoted.split('\n').findIndex((text) => text.includes('<run_script name="\'mo"'));
    const character = quoted.split('\n')[line].indexOf("'mo");
    expect((move.textEdit as TextEdit).range).toEqual({ start: { line, character }, end: { line, character: character + 3 } });

    const order = completionAt(caller, offsetOf(callerText, '<create_order object="this.ship" id="\'Attack\'"/>', "'Attack'", 1), game);
    expect(labels(order)).toEqual(['Attack']);
    expect(order[0].detail).toBe('Hull · order.attack');
    expect((order[0].documentation as MarkupContent).value).toBe(
      ['**Attack** *(order of `order.attack`)*', '', '**Hull**: Hull and Shield', '', 'Category: `combat`', '', 'In order.attack.xml of `game`, line 2'].join(
        '\n'
      )
    );
    // In a Mission Director script, and nothing of it in a value that is an expression.
    const md = analyze('game/md/caller.xml');
    expect(labels(completionAt(md, offsetOf(textOf('game/md/caller.xml'), 'name="\'move.go\'"', "'move.go'", 1), game))).toEqual([
      'caller',
      'move.go',
      'order.attack',
    ]);
    expect(labels(completionAt(caller, offsetOf(callerText, '<run_script name="$script"/>', '$script', 2), game))).not.toContain('move.go');
  });

  it('hovers a name with what it is, its parameters, every definition, and how often other files name it', () => {
    expect(hoverText(caller, offsetOf(callerText, '<run_script name="\'move.go\'"/>', 'move.go'))).toBe(
      [
        '**move.go** *(AI script)*',
        '',
        'Parameters: `destination`',
        '',
        'In move.go.xml of `game`, line 1  ',
        'In move.go.xml of `ext`, line 1  ',
        '',
        'Defined 2 times',
        '',
        'Referenced 2 times in 2 other files',
      ].join('\n')
    );
    // Where it is defined: an order's name and description as the game shows them.
    const attack = analyze('game/aiscripts/order.attack.xml');
    expect(hoverText(attack, offsetOf(textOf('game/aiscripts/order.attack.xml'), '<order id="Attack"', 'Attack'))).toBe(
      [
        '**Attack** *(order of `order.attack`)*',
        '',
        '**Hull**: Hull and Shield',
        '',
        'Category: `combat`',
        '',
        'Parameters: `target`',
        '',
        'In order.attack.xml of `game`, line 2  ',
        '',
        'Referenced 3 times in 2 other files',
      ].join('\n')
    );
    // Named only here: no other file to count.
    expect(hoverText(caller, offsetOf(callerText, "'nothing'", 'nothing'))).toBe('**nothing**\n\nNo AI script of this name is known');
    expect(hoverText(caller, offsetOf(callerText, '<run_script name="$script"/>', '$script', 2)) ?? '').not.toContain('AI script');
  });

  it('goes to every definition, in load order', () => {
    expect(definitionAt(caller, offsetOf(callerText, '<run_script name="\'move.go\'"/>', 'move.go'), game).map(place)).toEqual([
      spot('game/aiscripts/move.go.xml', 'move.go'),
      spot('ext/aiscripts/move.go.xml', 'move.go'),
    ]);
    const order = definitionAt(caller, offsetOf(callerText, '<create_order object="this.ship" id="\'Attack\'"/>', 'Attack'), game);
    expect(order.map(place)).toEqual([spot('game/aiscripts/order.attack.xml', 'Attack')]);
    expect(order[0].range.end.character - order[0].range.start.character).toBe('Attack'.length);
    expect(definitionAt(caller, offsetOf(callerText, "'nothing'", 'nothing'), game)).toEqual([]);
  });

  it('finds every place a name is written, from where it is named or defined, and does not rename it', () => {
    const expected = [
      spot('game/aiscripts/caller.xml', "'Attack'", 1, 0),
      spot('game/aiscripts/caller.xml', "'Attack'", 1, 1),
      spot('game/aiscripts/order.attack.xml', 'Attack'),
      spot('game/md/caller.xml', "'Attack'", 1),
    ];
    const offset = offsetOf(callerText, '<clear_recurring_order_failure object="this.ship" id="\'Attack\'"/>', 'Attack');
    expect(referencesAt(caller, offset, game).map(place)).toEqual(expected);
    const attack = analyze('game/aiscripts/order.attack.xml');
    const fromDefinition = referencesAt(attack, offsetOf(textOf('game/aiscripts/order.attack.xml'), '<order id="Attack"', 'Attack'), game).map(place);
    expect([...fromDefinition].sort()).toEqual([...expected].sort());
    expect(referencesAt(caller, offsetOf(callerText, '<run_script name="\'move.go\'"/>', 'move.go'), game).map(place)).toEqual([
      spot('game/aiscripts/caller.xml', "'move.go'", 1),
      spot('ext/aiscripts/move.go.xml', 'move.go'),
      spot('game/aiscripts/move.go.xml', 'move.go'),
      spot('game/aiscripts/order.attack.xml', "'move.go'", 1),
      spot('game/md/caller.xml', "'move.go'", 1),
    ]);
    // Refused at the prompt already, with the reason, also without the index.
    const refused = { refused: 'order Attack is not renamed: the game and any extension may name it' };
    expect(prepareRenameAt(caller, offset, game, { editableFolders: [folder] })).toEqual(refused);
    expect(prepareRenameAt(caller, offset)).toEqual(refused);
    expect(renameAt(caller, offset, 'Charge', game, { editableFolders: [folder] })).toEqual(refused);
    expect(prepareRenameAt(caller, offsetOf(callerText, '<run_script name="\'move.go\'"/>', 'move.go'), game)).toEqual({
      refused: 'AI script move.go is not renamed: the game and any extension may name it',
    });
  });

  it('warns of a name no script defines, with the closest known one as the fix', () => {
    const uri = pathToFileURL(file('game/aiscripts/caller.xml')).toString();
    const problems = (text: string, context: AnalysisContext = { schemas: game.schemas, index }): string[] =>
      analyzeText(text, context, uri)
        .diagnostics.filter((diagnostic) => diagnostic.code === 'aiscript-undefined' || diagnostic.code === 'order-undefined')
        .map(
          (diagnostic) =>
            `${diagnostic.range.start.line}:${diagnostic.range.start.character}-${diagnostic.range.end.character} ${diagnostic.severity} ${diagnostic.message}`
        );
    // On the name inside the quotes; not on a variable or an expression.
    const nothing = spot('game/aiscripts/caller.xml', "'nothing'", 1).split(':');
    expect(problems(callerText)).toEqual([`${nothing[1]}:${nothing[2]}-${Number(nothing[2]) + 'nothing'.length} 2 No AI script 'nothing' is known`]);
    expect(problems(callerText, { schemas: game.schemas })).toEqual([]);
    expect(problems(callerText, { schemas: game.schemas, index, validateScriptNames: false })).toEqual([]);

    // A misspelt order: changed to the known one, also by fix all.
    const misspelt = callerText.replace('<create_order object="this.ship" id="\'Attack\'"/>', '<create_order object="this.ship" id="\'Atack\'"/>');
    const analysis = analyzeText(misspelt, { schemas: game.schemas, index }, uri);
    const diagnostic = analysis.diagnostics.find((found) => found.code === 'order-undefined');
    expect(diagnostic?.message).toBe("No order 'Atack' is known");
    const fixes = quickFixes(analysis, diagnostic ? [diagnostic] : [], game);
    expect(fixes.map((fix) => `${fix.title}${fix.isPreferred ? ' (preferred)' : ''}`)).toEqual(["Change to 'Attack' (preferred)"]);
    // 'nothing' is close to no known name: it stays.
    const all = fixAll(analysis, game);
    expect(TextDocument.applyEdits(analysis.document, all?.edit?.changes?.[uri] ?? [])).toBe(callerText);

    // An order the document defines itself counts before the index has it.
    const own = [
      '<aiscript name="order.new">',
      '  <order id="NewOrder"/>',
      '  <attention min="unknown">',
      '    <actions>',
      '      <create_order object="this.ship" id="\'NewOrder\'"/>',
      '      <run_script name="\'order.new\'"/>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
    ].join('\n');
    expect(problems(own)).toEqual([]);
  });

  describe('while typing', () => {
    it('reports no name before its quote is closed', () => {
      const typing = callerText.replace('<run_script name="$script"/>', '<run_script name="\'nothin');
      const messages = analyzeText(typing, { schemas: game.schemas, index }).diagnostics.map((diagnostic) => diagnostic.message);
      expect(messages).toContain("No AI script 'nothing' is known");
      expect(messages.filter((message) => message.includes("'nothin'"))).toEqual([]);
      for (let end = 0; end <= callerText.length; end += 7) {
        expect(() => analyzeText(callerText.slice(0, end), { schemas: game.schemas, index })).not.toThrow();
      }
    });

    it('completes a name whose value is not closed, and answers on every cut without throwing', () => {
      const typing = callerText.replace('<run_script name="$script"/>', '<run_script name="\'move');
      const analysis = analyze('game/aiscripts/caller.xml', typing);
      const offset = typing.indexOf("'move\n") + "'move".length;
      expect(labels(completionAt(analysis, offset, game))).toEqual(['caller', 'move.go', 'order.attack']);
      for (let end = 0; end <= callerText.length; end += 7) {
        const part = analyze('game/aiscripts/caller.xml', callerText.slice(0, end));
        expect(() => [hoverAt(part, end, game), completionAt(part, end, game), definitionAt(part, end, game), referencesAt(part, end, game)]).not.toThrow();
      }
    });
  });
});
