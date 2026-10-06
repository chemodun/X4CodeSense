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

describe('format arguments', () => {
  const formats = (body: string): string[] =>
    analyzeText(actions(body), { schemas: game.schemas, texts: game.texts })
      .diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('format-'))
      .map(
        (diagnostic) =>
          `${diagnostic.range.start.character + 1}-${diagnostic.range.end.character + 1} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`
      );
  const text = (value: string): string => `<debug_text text="${value}"/>`;
  const column = (value: string, part: string): number => '        <debug_text text="'.length + value.indexOf(part) + 1;

  it('warns of fewer arguments than the format takes, on the brackets', () => {
    const value = "'%s of %s'.[$a]";
    expect(formats(text(value))).toEqual([
      `${column(value, '[')}-${column(value, ']') + 1} 2 format-arguments-missing: The format takes 2 arguments but is given 1`,
    ]);
    expect(formats(text("'%1 has nothing to pick up %3'.[$ship]"))).toEqual([expect.stringContaining('takes 3 arguments but is given 1')]);
    // A text of the game that is the format.
    expect(formats(text('{2000, 1}.[$ship, $buyer]'))).toEqual([expect.stringContaining('takes 3 arguments but is given 2')]);
  });

  it('tells of more arguments than the format takes, on those', () => {
    const value = "'%s'.[$a, $b, $c]";
    expect(formats(text(value))).toEqual([
      `${column(value, '$b')}-${column(value, '$c') + 2} 3 format-arguments-unused: The format takes 1 argument: these 2 are not shown`,
    ]);
    expect(formats(text("'none'.[$a]"))).toEqual([expect.stringContaining('takes 0 arguments: this one is not shown')]);
  });

  it('counts what the game counts, and leaves alone what is not known', () => {
    for (const value of ["'%s of %s'.[$a, $b]", "'%2 and %1'.[$a, $b]", "'%4s left'.[$a, $b, $c, $d]", "'100%% of %,s'.[$a]", "'%s'.['%s and %s'.[$x, $y]]"]) {
      expect(formats(text(value))).toEqual([]);
    }
    // Mixing `%s` and numbered placeholders, a text no file has, a value that does not parse, a list lookup.
    for (const value of ["'%1 and %s'.[$a]", '{2000, 99}.[$a]', "'%s of %s'.[$a", '$list.[1]']) {
      expect(formats(text(value))).toEqual([]);
    }
    // Without the texts, a text's format is not known.
    expect(
      analyzeText(actions(text('{2000, 1}.[$a]')), { schemas: game.schemas }).diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('format-'))
    ).toEqual([]);
  });

  it('keeps counting while a value is being typed', () => {
    const value = "'%s: %s'.['%s and %s'.[$x, $y], {2000, 1}.[$a, $b, $c]]";
    for (let cut = 0; cut <= value.length; cut++) {
      // Until its brackets close the value does not parse, and nothing is counted; then every format fits.
      expect(formats(`<debug_text text="${value.slice(0, cut)}`), value.slice(0, cut)).toEqual([]);
    }
    // A format short of an argument is counted once its brackets close, the quote of the value still open.
    expect(formats(`<debug_text text="'%s: %s'.[$a]`)).toEqual([expect.stringContaining('takes 2 arguments but is given 1')]);
  });

  it("reads '%%d' as a percent sign and a d, and gives a format with '%d' no count beside its warning", () => {
    expect(report(text("'100%%d'.[$x]"))).toEqual([]);
    expect(report(text("'%d'.[$x]"))).toEqual([expect.stringContaining("'%d' is not a format specifier the game knows")]);
    expect(formats(text("'%d'.[$x]"))).toEqual([]);
  });

  it('does not count a string that holds a text reference, which the game may put in before it formats', () => {
    expect(formats(text("'{2000, 1}'.[$a]"))).toEqual([]);
    expect(formats(text("'{2000, 1}: %s'.[$a, $b]"))).toEqual([]);
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

  it('reports a bare name after a value of a datatype, which no placeholder of it takes', () => {
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.cargo.list.frob"/>'))).toEqual([expect.stringContaining("'list' has no property 'frob'")]);
    expect(reportWith(ai('<set_value name="$x" exact="[1, 2].frob"/>'))).toEqual([expect.stringContaining("'list' has no property 'frob'")]);
    // An index of the list, braced, is no bare name.
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.cargo.list.{1}.name"/>'))).toEqual([]);
  });

  it('reads a braced step after a list as its index or the longer property, and types neither', () => {
    // `sector.ships` is a list and `sector.ships.{$faction}` one too: `{$i}` may be either.
    expect(reportWith(ai('<set_value name="$x" exact="player.ship.sector.ships.{$i}.pilot"/>'))).toEqual([]);
  });

  it('reports only the syntax error while the name after a dot is still to be typed', () => {
    for (const value of ['player.ship.', 'player.', '1.']) {
      expect(reportWith(ai(`<set_value name="$x" exact="${value}"/>`)), value).toEqual([]);
    }
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

  describe('on variables of known type', () => {
    function reportTyped(body: string, context: { validateTypedProperties?: boolean; guessVariableTypes?: boolean } = {}): string[] {
      return analyzeText(ai(body), { schemas: game.schemas, properties: game.properties, validateVariables: true, ...context })
        .diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('expression-unknown'))
        .map(
          (diagnostic) =>
            `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}-${diagnostic.range.end.character + 1} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`
        );
    }
    const set = '<set_value name="$s" exact="player.ship"/>\n      ';

    it('reports what the type lacks and where the type comes from, a guessed type apart', () => {
      expect(reportTyped(`${set}<set_value name="$x" exact="$s.frobnicate"/>`)).toEqual([
        "5:38-48 2 expression-unknown-property: 'ship' has no property 'frobnicate' ($s is a ship, set by set_value at line 4)",
      ]);
      expect(reportTyped(`${set}<set_value name="$x" exact="$s.pilot.frobnicate"/>`)).toEqual([
        "5:44-54 2 expression-unknown-property: 'entity' has no property 'frobnicate' ($s is a ship, set by set_value at line 4)",
      ]);
      // Information of its own code, worded as the guess it rests on.
      expect(reportTyped('<create_ship name="$c" macro="m"/>\n      <set_value name="$x" exact="$c.frobnicate"/>')).toEqual([
        "5:38-48 3 expression-unknown-property-guessed: 'ship' has no property 'frobnicate' (if $c is a ship, as guessed from create_ship at line 4)",
      ]);
      expect(reportTyped(`${set}<set_value name="$x" exact="$s.speed + $s.cargo.{$w}.count + $s.isclass.ship"/>`)).toEqual([]);
    });

    describe('on a table, whose keys are read with $ or braces only', () => {
      const table = '<set_value name="$t" exact="table[]"/>\n      ';
      const because = '($t is a table, set by set_value at line 4)';

      it('reports a bare name, which is no key and no property', () => {
        expect(reportTyped(`${table}<set_value name="$x" exact="$t.frobnicate"/>`)).toEqual([
          `5:38-48 2 expression-unknown-property: 'table' has no property 'frobnicate' ${because}`,
        ]);
        expect(reportTyped(`${table}<set_value name="$x" exact="$t.keys.frobnicate"/>`)).toEqual([
          `5:38-42 2 expression-unknown-property: 'table' has no property 'keys' ${because}`,
        ]);
      });

      it('reports a chain that stops inside a property name, with the properties it may be', () => {
        expect(reportTyped(`${table}<set_value name="$x" exact="$t.keys"/>`)).toEqual([
          `5:38-42 2 expression-unknown-property: 'table' has no property 'keys', only keys.count, keys.list, keys.sorted, keys.random and keys.last ${because}`,
        ]);
        expect(reportTyped(`${table}<set_value name="$x" exact="$t.keys + 1"/>`)).toEqual([expect.stringContaining("has no property 'keys', only keys.count")]);
      });

      it('reports such a chain and a bare name under @ or tested with ? as well', () => {
        expect(reportTyped(`${table}<set_value name="$x" exact="@$t.keys"/>`)).toEqual([
          expect.stringMatching(/^5:39-43 2 expression-unknown-property: .*'keys', only/),
        ]);
        expect(reportTyped(`${table}<do_if value="$t.keys?"/>`)).toEqual([expect.stringMatching(/^5:\d+-\d+ 2 expression-unknown-property: .*'keys', only/)]);
        expect(reportTyped(`${table}<set_value name="$x" exact="@$t.frobnicate"/>`)).toEqual([
          expect.stringMatching(/^5:39-49 2 expression-unknown-property: 'table' has no property 'frobnicate'/),
        ]);
      });

      it('accepts its properties and its keys', () => {
        for (const value of ['$t.keys.list', '$t.keys.count', '$t.keys.{1}', '$t.$key', "$t.{'key'}", '$t.{$k}.name', '@$t.keys.list']) {
          expect(reportTyped(`${table}<set_value name="$x" exact="${value}"/>`), value).toEqual([]);
        }
        expect(reportTyped(`${table}<do_if value="$t.keys.count?"/>`)).toEqual([]);
      });

      it('reports nothing of the type while the name after keys is still to be typed', () => {
        expect(reportTyped(`${table}<set_value name="$x" exact="$t.keys."/>`)).toEqual([]);
        expect(reportTyped(`${table}<set_value name="$x" exact="$t.keys.\n    </actions>`)).toEqual([]);
      });
    });

    it('types a value cast to a unit', () => {
      expect(reportTyped('<set_value name="$t" exact="(1 + 1)s"/>\n      <set_value name="$x" exact="$t.frobnicate"/>')).toEqual([
        "5:38-48 2 expression-unknown-property: 'time' has no property 'frobnicate' ($t is a time, set by set_value at line 4)",
      ]);
    });

    it('reports nothing of the type while the name after a dot is still to be typed', () => {
      expect(reportTyped(`${set}<set_value name="$x" exact="$s."/>`)).toEqual([]);
      expect(reportTyped(`${set}<set_value name="$x" exact="$s.pilot."/>`)).toEqual([]);
    });

    it('reports chains under @ or tested with ? too: the game gives null or false, and the script still reads what the type lacks', () => {
      const warned = expect.stringMatching(/ 2 expression-unknown-property: 'ship' has no property 'frobnicate' /);
      expect(reportTyped(`${set}<set_value name="$x" exact="@$s.frobnicate"/>`)).toEqual([warned]);
      expect(reportTyped(`${set}<set_value name="$x" exact="@($s.frobnicate + 1)"/>`)).toEqual([warned]);
      expect(reportTyped(`${set}<do_if value="$s.frobnicate?"/>`)).toEqual([warned]);
    });

    it('resolves on the type without reporting unless asked, and without guesses when told so', () => {
      expect(reportTyped(`${set}<set_value name="$x" exact="$s.frobnicate"/>`, { validateTypedProperties: false })).toEqual([]);
      expect(reportTyped('<create_ship name="$c" macro="m"/>\n      <set_value name="$x" exact="$c.frobnicate"/>', { guessVariableTypes: false })).toEqual([]);
      // Two types: none is used.
      expect(reportTyped(`${set}<set_value name="$s" exact="player.money"/>\n      <set_value name="$x" exact="$s.frobnicate"/>`)).toEqual([]);
    });
  });

  describe('after a class test', () => {
    function reportNarrowed(body: string, wrap: (body: string) => string = ai): string[] {
      return analyzeText(wrap(body), { schemas: game.schemas, properties: game.properties, validateVariables: true })
        .diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('expression-unknown'))
        .map((diagnostic) => `${diagnostic.range.start.line + 1} ${diagnostic.code}: ${diagnostic.message}`);
    }
    // Properties of a value's subtypes are accepted on it already (an object may be a ship); a class test
    // matters across siblings, as an object and an npc are in the game. Here an entity and a ship: both
    // components, neither a subtype of the other.
    const entity = '<set_value name="$e" exact="player.entity"/>\n      ';
    const lacks = (name: string, line = 5, setAt = 4): string =>
      `${line} expression-unknown-property: 'entity' has no property '${name}' ($e is an entity, set by set_value at line ${setAt})`;

    it('takes the class further in the same expression: after and, after a negated test with or, in then', () => {
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.speed"/>`)).toEqual([lacks('speed')]);
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.isclass.ship and $e.speed"/>`)).toEqual([]);
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="@$e.isclass.ship and ($e.speed gt 0)"/>`)).toEqual([]);
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="not $e.isclass.ship or $e.speed"/>`)).toEqual([]);
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="if $e.isclass.ship then $e.speed else 0"/>`)).toEqual([]);
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="if $e.isclass.ship then 0 else $e.speed"/>`)).toEqual([lacks('speed')]);
      // Left of the test, and on the other side of a plain or, nothing is known.
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.speed and $e.isclass.ship"/>`)).toEqual([lacks('speed')]);
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.isclass.ship or $e.speed"/>`)).toEqual([lacks('speed')]);
    });

    it('checks against the class, and says which test tells it', () => {
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.isclass.ship and $e.frobnicate"/>`)).toEqual([
        "5 expression-unknown-property: 'ship' has no property 'frobnicate' ($e is a ship here, by isclass.ship at line 5)",
      ]);
      // A chain of keywords and properties, as the test names it.
      expect(reportNarrowed('<set_value name="$x" exact="player.entity.speed"/>')).toEqual(["4 expression-unknown-property: 'entity' has no property 'speed'"]);
      expect(reportNarrowed('<set_value name="$x" exact="player.entity.isclass.ship and player.entity.speed"/>')).toEqual([]);
    });

    it('takes the class from braces and lists: the datatype the classes share', () => {
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.isclass.{class.ship} and $e.speed"/>`)).toEqual([]);
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.isclass.{[class.ship, class.station]} and $e.cargo.list"/>`)).toEqual([]);
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.isclass.{[class.ship, class.station]} and $e.frobnicate"/>`)).toEqual([
        "5 expression-unknown-property: 'container' has no property 'frobnicate' ($e is a container here, by isclass.{[class.ship, class.station]} at line 5)",
      ]);
    });

    it('holds in the body of do_if, do_elseif and do_while, until the variable is set again', () => {
      const inside = (condition: string, body: string): string => `${entity}<${condition} value="$e.isclass.ship">\n        ${body}\n      </${condition}>`;
      for (const condition of ['do_if', 'do_while']) {
        expect(reportNarrowed(inside(condition, '<set_value name="$x" exact="$e.speed"/>'))).toEqual([]);
      }
      expect(
        reportNarrowed(
          `${entity}<do_if value="false"/>\n      <do_elseif value="$e.isclass.ship">\n        <set_value name="$x" exact="$e.speed"/>\n      </do_elseif>`
        )
      ).toEqual([]);
      // After the body, and after the variable is set again in it.
      expect(reportNarrowed(`${entity}<do_if value="$e.isclass.ship"/>\n      <set_value name="$x" exact="$e.speed"/>`)).toEqual([lacks('speed', 6)]);
      expect(reportNarrowed(inside('do_if', '<set_value name="$e" exact="player.entity"/>\n        <set_value name="$x" exact="$e.speed"/>'))).toEqual([
        "7 expression-unknown-property: 'entity' has no property 'speed' ($e is an entity, set by set_value at line 4)",
      ]);
    });

    it('holds where a negated test is false: in do_elseif and do_else after it, until the variable is set again', () => {
      const chain = (rest: string): string =>
        `${entity}<do_if value="not $e.isclass.ship">\n        <set_value name="$x" exact="0"/>\n      </do_if>\n      ${rest}`;
      expect(reportNarrowed(chain('<do_else>\n        <set_value name="$x" exact="$e.speed"/>\n      </do_else>'))).toEqual([]);
      // In the value of a do_elseif and its body, and in a do_else after both.
      expect(reportNarrowed(chain('<do_elseif value="$e.speed gt 0">\n        <set_value name="$x" exact="$e.speed"/>\n      </do_elseif>'))).toEqual([]);
      expect(
        reportNarrowed(chain('<do_elseif value="$e.isclass.station"/>\n      <do_else>\n        <set_value name="$x" exact="$e.speed"/>\n      </do_else>'))
      ).toEqual([]);
      // The test says which one tells it.
      expect(reportNarrowed(chain('<do_else>\n        <set_value name="$x" exact="$e.frobnicate"/>\n      </do_else>'))).toEqual([
        "9 expression-unknown-property: 'ship' has no property 'frobnicate' ($e is a ship here, by not isclass.ship at line 5)",
      ]);
      // A set in the body of the do_if does not run before the do_else; one in the do_else ends it.
      expect(
        reportNarrowed(
          chain('<do_else>\n        <set_value name="$e" exact="player.entity"/>\n        <set_value name="$x" exact="$e.speed"/>\n      </do_else>')
        )
      ).toEqual([lacks('speed', 10)]);
      // Not after the chain, nor where the test is true.
      expect(reportNarrowed(chain('<do_else/>\n      <set_value name="$x" exact="$e.speed"/>'))).toEqual([lacks('speed', 9)]);
      expect(
        reportNarrowed(`${entity}<do_if value="$e.isclass.ship"/>\n      <do_else>\n        <set_value name="$x" exact="$e.speed"/>\n      </do_else>`)
      ).toEqual([lacks('speed', 7)]);
    });

    it('holds after a do_if of a negated test whose body leaves the block', () => {
      const guard = (exit: string, rest = '<set_value name="$x" exact="$e.speed"/>'): string =>
        `${entity}<do_if value="not $e.isclass.ship">\n        <set_value name="$e" exact="player.entity"/>\n        ${exit}\n      </do_if>\n      ${rest}`;
      for (const exit of ['<return/>', '<break/>', '<continue/>', '<resume label="start"/>']) {
        expect(reportNarrowed(guard(exit)), exit).toEqual([]);
      }
      // Deeper in what follows, until the variable is set again.
      expect(reportNarrowed(guard('<return/>', '<do_if value="true">\n        <set_value name="$x" exact="$e.speed"/>\n      </do_if>'))).toEqual([]);
      expect(reportNarrowed(guard('<return/>', '<set_value name="$e" exact="player.entity"/>\n      <set_value name="$x" exact="$e.speed"/>'))).toEqual([
        lacks('speed', 10),
      ]);
      // Not when the body may go on, or a do_else follows.
      expect(reportNarrowed(guard('<set_value name="$y" exact="1"/>'))).toEqual([lacks('speed', 9)]);
      expect(reportNarrowed(guard('<return/>', '<do_else/>\n      <set_value name="$x" exact="$e.speed"/>'))).toEqual([lacks('speed', 10)]);
    });

    it("holds in a cue's actions for a check_value of its conditions", () => {
      const cue = (body: string): string =>
        `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <conditions>\n        <check_value value="player.entity.isclass.ship"/>\n      </conditions>\n      <actions>\n        ${body}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;
      expect(reportNarrowed('<set_value name="$x" exact="player.entity.speed"/>', cue)).toEqual([]);
    });

    it('leaves a value of no known type alone: it may be a macro, which has isclass too', () => {
      expect(reportNarrowed('<do_if value="$u.isclass.ship">\n        <set_value name="$x" exact="$u.frobnicate"/>\n      </do_if>')).toEqual([]);
    });

    it('works while typing: a test before an unclosed value', () => {
      expect(reportNarrowed(`${entity}<set_value name="$x" exact="$e.isclass.ship and $e.speed`)).toEqual([]);
    });
  });
});
