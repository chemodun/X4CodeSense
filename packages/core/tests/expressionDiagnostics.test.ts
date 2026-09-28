import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);

const actions = (body: string): string =>
  `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <actions>\n        ${body}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;

function report(body: string, validateExpressions?: boolean): string[] {
  return analyzeText(actions(body), { schemas: game.schemas, validateExpressions })
    .diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('expression-'))
    .map(
      (diagnostic) =>
        `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}-${diagnostic.range.end.character + 1} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`
    );
}

describe('expression diagnostics', () => {
  it('reports syntax errors with positions inside the attribute value', () => {
    expect(report('<set_value name="$x" exact="$a +"/>')).toEqual(['5:41-41 1 expression-syntax: Expression expected']);
    expect(report('<set_value name="$x" exact="[1, 2"/>')).toEqual(["5:42-42 1 expression-syntax: ']' expected"]);
    expect(report('<do_if value="$a $b"><set_value name="$x" exact="1"/></do_if>')).toEqual(["5:26-28 1 expression-syntax: Unexpected '$b'"]);
  });

  it('reports what the game rejects beyond syntax', () => {
    expect(report('<set_value name="$x" exact="@$a.$b?"/>')).toEqual([
      "5:43-44 1 expression-null-safe-exists: '@' and '?' cannot be combined in one expression",
    ]);
    expect(report('<set_value name="$x" exact="{1001, $id}"/>')).toEqual([
      '5:44-47 1 expression-text-reference: A text reference takes numeric literals only; resolve the text to a string first',
    ]);
    expect(report('<debug_text text="\'%d of %s\'.[$n, $total]"/>')).toEqual([
      "5:28-30 2 expression-format-specifier: '%d' is not a format specifier the game knows; numbers format with '%s'",
    ]);
  });

  it('maps positions through entity references', () => {
    expect(report('<do_if value="$a &lt; $b +"><set_value name="$x" exact="1"/></do_if>')).toEqual(['5:35-35 1 expression-syntax: Expression expected']);
  });

  it('leaves non-expression attributes, empty values and unknown elements alone', () => {
    expect(report('<set_value name="$x" comment="$a +"/>')).toEqual([]);
    expect(report('<set_value name="$x" exact=""/>')).toEqual([]);
    expect(report('<frobnicate value="$a +"/>')).toEqual([]);
    expect(report('<set_value name="$x" exact="$a +"/>', false)).toEqual([]);
    expect(analyzeText(actions('<set_value name="$x" exact="$a +"/>')).diagnostics).toEqual([]);
  });

  it('accepts what the game accepts', () => {
    expect(report('<set_value name="$x" exact="if $a? then ($b + 1)s else [1, 2].{1}"/>')).toEqual([]);
    expect(report('<set_value name="player.entity.$cfg" exact="table[$a = \'x\', {faction.argon} = sin(90deg)]"/>')).toEqual([]);
    expect(report('<debug_text text="\'%s: %,s\'.[{1001, 5}, @$ship.knownname]"/>')).toEqual([]);
  });
});

describe('unknown keywords and properties', () => {
  const ai = (body: string): string =>
    `<aiscript name="a">\n  <attention min="1">\n    <actions>\n      ${body}\n    </actions>\n  </attention>\n</aiscript>\n`;

  function reportWith(text: string): string[] {
    return analyzeText(text, { schemas: game.schemas, properties: game.properties })
      .diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('expression-unknown'))
      .map(
        (diagnostic) =>
          `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}-${diagnostic.range.end.character + 1} ${diagnostic.code}: ${diagnostic.message}`
      );
  }

  it('reports unknown chain heads in AI scripts only', () => {
    expect(reportWith(ai('<set_value name="$x" exact="frobnicate.ship"/>'))).toEqual(["4:35-45 expression-unknown-keyword: Unknown keyword 'frobnicate'"]);
    expect(reportWith(ai('<set_value name="$x" exact="1 + frobnicate"/>'))).toEqual(["4:39-49 expression-unknown-keyword: Unknown keyword 'frobnicate'"]);
    expect(reportWith(ai('<set_value name="$x" exact="frobnicate"/>'))).toEqual([]);
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.name"/>'))).toEqual([]);
    expect(reportWith(actions('<set_value name="$x" exact="SomeCue.$value"/>'))).toEqual([]);
  });

  it('reports unknown properties on known types', () => {
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.frobnicate"/>'))).toEqual([
      "4:47-57 expression-unknown-property: 'ship' has no property 'frobnicate'",
    ]);
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.cargo.{$w}.count.frobnicate"/>'))).toEqual([
      "4:64-74 expression-unknown-property: 'integer' has no property 'frobnicate'",
    ]);
    expect(reportWith(ai('<set_value name="$x" exact="this.controlled.frobnicate"/>'))).toEqual([
      "4:51-61 expression-unknown-property: 'object' has no property 'frobnicate'",
    ]);
  });

  it('leaves alone what the data cannot describe', () => {
    expect(reportWith(ai('<set_value name="$x" exact="class.nope"/>'))).toEqual([]);
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.{$name}.frobnicate"/>'))).toEqual([]);
    expect(reportWith(ai('<set_value name="$x" exact="$x.frobnicate"/>'))).toEqual([]);
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.owner.haslicence.{$l}"/>'))).toEqual([]);
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.dock.container.name"/>'))).toEqual([]);
    expect(reportWith(ai('<set_value name="$x" exact="this.$var.frobnicate"/>'))).toEqual([]);
    expect(reportWith(ai('<find_ship name="$s" class="ship"/>'))).toEqual([]);
    expect(analyzeText(ai('<set_value name="$x" exact="player.ship.frobnicate"/>'), { schemas: game.schemas }).diagnostics).toEqual([]);
  });
});
