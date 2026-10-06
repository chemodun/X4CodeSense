import { fileURLToPath } from 'node:url';
import { Range, type InlayHint } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import { analyzeText, inlayHints, loadGameData, type InlayHintOptions } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);

/** A script with the body inside the actions of a cue, the body on line 5 (one-based). */
const actions = (body: string): string =>
  `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <actions>\n        ${body}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;

/** The hints of the whole text, each as `line: word|label`: the one-based line, and the text from the last space before it. */
function hintsOf(text: string, options: InlayHintOptions = {}, range = Range.create(0, 0, text.split('\n').length, 0)): string[] {
  const analysis = analyzeText(text, { schemas: game.schemas, properties: game.properties });
  const lines = text.split('\n');
  return inlayHints(analysis, range, game, options).map((hint: InlayHint) => {
    const before = /\S*$/.exec(lines[hint.position.line].slice(0, hint.position.character))?.[0] ?? '';
    return `${hint.position.line + 1}: ${before}|${String(hint.label)}`;
  });
}

describe('inlay hints', () => {
  it('show the text after a text reference, as the game shows it', () => {
    expect(hintsOf(actions('<debug_text text="{1001,4}"/>'))).toEqual(['5: text="{1001,4}|Hull and Shield']);
    expect(hintsOf(actions('<debug_text text="{1001,5}"/>'))).toEqual(['5: text="{1001,5}|First line Second line (not a comment) & more']);
    expect(hintsOf(actions('<debug_text text="{1001, 3}"/>'))).toEqual(['5: 3}|None']);
    expect(hintsOf(actions('<speak page="1001" line="2"/>'))).toEqual(['5: line="2"|Shield']);
    // In the preferred language, else as the game falls back.
    expect(hintsOf(actions('<debug_text text="{1001,1} {1001,3}"/>'), { language: '49' })).toEqual(['5: text="{1001,1}|Hülle', '5: {1001,3}|None']);
    // Nothing for a missing text: the warning tells.
    expect(hintsOf(actions('<debug_text text="{1001,99} {1003,1}"/>'))).toEqual([]);
  });

  it('show texts in any XML, and while it does not parse', () => {
    expect(hintsOf('<wares>\n  <ware id="x" name="{1001,2}"/>\n</wares>\n')).toEqual(['2: name="{1001,2}|Shield']);
    expect(hintsOf(actions('<debug_text text="{1001,2}\n'))).toEqual(['5: text="{1001,2}|Shield']);
    expect(hintsOf('<!-- {1001,1} -->\n<wares')).toEqual(['1: {1001,1}|Hull']);
  });

  it('show only the hints of the range, a reference the range cuts included', () => {
    const text = '<wares>\n  <ware name="{1001,1}"/>\n  <ware name="{1001,2}"/>\n  <ware name="{1002,10}"/>\n</wares>\n';
    expect(hintsOf(text, {}, Range.create(2, 18, 2, 19))).toEqual(['3: name="{1001,2}|Shield']);
    expect(hintsOf(text, {}, Range.create(1, 0, 2, 0))).toEqual(['2: name="{1001,1}|Hull']);
    expect(hintsOf(text, {}, Range.create(3, 0, 5, 0))).toEqual(['4: name="{1002,10}|Yes']);
  });

  it("show a variable's type after the definition that tells it, once per variable", () => {
    const text = actions(
      [
        '<set_value name="$foo" exact="player.ship"/>',
        '<set_value name="$foo" exact="player.ship"/>',
        '<create_ship name="$made" macro="m"/>',
        '<set_value name="$count" exact="0"/>',
        '<set_value name="$mixed" exact="player.ship"/>',
        '<set_value name="$mixed" exact="player.money"/>',
      ].join('\n        ')
    );
    expect(hintsOf(text)).toEqual(['5: name="$foo|: ship', '7: name="$made|: ship?']);
    const analysis = analyzeText(text, { schemas: game.schemas, properties: game.properties });
    const made = inlayHints(analysis, Range.create(6, 0, 7, 0), game).find((hint) => hint.label === ': ship?');
    expect(made?.tooltip).toBe("Type from <create_ship>: guessed from the action's name");
  });

  it('leave a type out where the element shows it', () => {
    const text = actions(
      [
        '<set_value name="$text" exact="\'a\'"/>',
        '<set_value name="$name" exact="{1001,1}"/>',
        '<set_value name="$list" exact="[]"/>',
        '<set_value name="$table" exact="table[]"/>',
        '<set_value name="$ship" exact="player.ship"/>',
      ].join('\n        ')
    );
    expect(hintsOf(text, { texts: false })).toEqual(['9: name="$ship|: ship']);
    const params =
      '<aiscript name="a">\n  <params>\n    <param name="p" type="ship"/>\n    <param name="q" default="player.ship"/>\n  </params>\n</aiscript>\n';
    expect(hintsOf(params)).toEqual(['4: name="q|: ship']);
  });

  it('show each kind only when asked for', () => {
    const text = actions('<set_value name="$foo" exact="player.ship"/>\n        <debug_text text="{1001,2}"/>');
    expect(hintsOf(text)).toEqual(['5: name="$foo|: ship', '6: text="{1001,2}|Shield']);
    expect(hintsOf(text, { texts: false })).toEqual(['5: name="$foo|: ship']);
    expect(hintsOf(text, { variableTypes: false })).toEqual(['6: text="{1001,2}|Shield']);
  });
});
