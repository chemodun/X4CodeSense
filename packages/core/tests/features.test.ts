import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TextEdit } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  completionAt,
  definitionAt,
  hoverAt,
  loadGameData,
  positionContext,
  prepareRenameAt,
  referencesAt,
  renameAt,
  type DocumentAnalysis,
} from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);

/** Analyses a text with a `|` marker for the caret and returns the analysis and the caret offset. */
function at(marked: string): { analysis: DocumentAnalysis; offset: number } {
  const offset = marked.indexOf('|');
  if (offset < 0) {
    throw new Error('no caret marker');
  }
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  return { analysis: analyzeText(text, { schemas: game.schemas, properties: game.properties }), offset };
}

function labels(marked: string): string[] {
  const { analysis, offset } = at(marked);
  return completionAt(analysis, offset, game, { snippetSupport: true }).map((item) => item.label);
}

function hoverText(marked: string): string | undefined {
  const { analysis, offset } = at(marked);
  const hover = hoverAt(analysis, offset, game);
  return hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : undefined;
}

function definitionFiles(marked: string): string[] {
  const { analysis, offset } = at(marked);
  return definitionAt(analysis, offset, game).map((location) => path.basename(location.uri));
}

/** The edits a rename makes in the analysed document. */
function editsOf(renamed: ReturnType<typeof renameAt>): TextEdit[] {
  return renamed && 'changes' in renamed ? (renamed.changes?.['untitled:document.xml'] ?? []) : [];
}

/** A script with the body inside a cue. */
const cue = (body: string): string => `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      ${body}\n    </cue>\n  </cues>\n</mdscript>\n`;
/** A script with the body inside the actions of a cue. */
const actions = (body: string): string => cue(`<actions>\n        ${body}\n      </actions>`);

describe('game data', () => {
  it('loads schemas and properties from the unpacked folder', () => {
    expect(Object.keys(game.schemas.schemas).sort()).toEqual(['aiscripts', 'md']);
    expect(game.properties?.keyword('player', 'md')).toBeDefined();
    expect(game.problems.length).toBeGreaterThan(0);
    const missing = loadGameData(path.join(unpacked, 'nowhere'));
    expect(missing.properties).toBeUndefined();
    expect(Object.keys(missing.schemas.schemas)).toEqual([]);
  });

  it('turns source locations into LSP locations', () => {
    const player = game.properties?.keyword('player', 'md');
    const location = player?.location && game.locationOf(player.location);
    expect(path.basename(location?.uri ?? '')).toBe('scriptproperties.xml');
    expect(location?.range.start.line).toBeGreaterThan(0);
    expect(game.locationOf({ file: 'C:/nowhere.xml', start: 0, end: 1 })).toBeUndefined();
  });
});

describe('positionContext', () => {
  it('classifies carets in a start tag', () => {
    const name = at(actions('<set_value na|me="$x" exact="1"/>'));
    expect(positionContext(name.analysis, name.offset)).toMatchObject({ kind: 'attribute-name', prefix: 'na' });
    const value = at(actions('<set_value name="$x" exact="pla|yer"/>'));
    expect(positionContext(value.analysis, value.offset)).toMatchObject({ kind: 'attribute-value', index: 3 });
    const between = at(actions('<set_value name="$x" | exact="1"/>'));
    expect(positionContext(between.analysis, between.offset).kind).toBe('start-tag');
    const afterEquals = at(actions('<set_value name=|"$x"/>'));
    expect(positionContext(afterEquals.analysis, afterEquals.offset).kind).toBe('none');
    const element = at(actions('<set_|value name="$x"/>'));
    expect(positionContext(element.analysis, element.offset)).toMatchObject({ kind: 'element-name', prefix: 'set_' });
  });

  it('classifies carets in content, after < and on end tags', () => {
    const content = at(cue('<actions>\n        |\n      </actions>'));
    expect(positionContext(content.analysis, content.offset)).toMatchObject({ kind: 'content' });
    const open = at(cue('<actions>\n        <|\n      </actions>'));
    expect(positionContext(open.analysis, open.offset)).toMatchObject({ kind: 'element-name', prefix: '' });
    const endTag = at(cue('<actions></act|ions>'));
    expect(positionContext(endTag.analysis, endTag.offset)).toMatchObject({ kind: 'end-tag-name' });
    const comment = at(cue('<!-- <set_|value/> -->'));
    expect(positionContext(comment.analysis, comment.offset).kind).toBe('none');
  });
});

describe('completion', () => {
  it('offers child elements allowed after the previous siblings', () => {
    expect(labels(cue('<|'))).toEqual(['actions', 'conditions', 'cues', 'delay', 'param', 'patch']);
    expect(labels(cue('<actions/>\n      <|'))).toEqual(['cues', 'patch']);
    expect(labels(cue('<ac|\n'))).toEqual(['actions']);
    expect(labels(cue('<actions>\n        <|\n      </actions>'))).toEqual([
      'append_to_list',
      'cancel_cue',
      'create_ship',
      'debug_text',
      'deliver',
      'do_else',
      'do_elseif',
      'do_if',
      'find_closest_resource',
      'find_ship',
      'include_actions',
      'remove_value',
      'run_actions',
      'set_value',
      'signal_cue_instantly',
    ]);
    expect(labels(actions('<do_if value="1"><|</do_if>'))).toContain('set_value');
  });

  it('offers no child element where the schema allows nothing more', () => {
    expect(labels(cue('<actions/>\n      <cues/>\n      <|'))).toEqual([]);
    expect(labels(cue('<actions/>\n      <cues/>\n      <ac|'))).toEqual([]);
    expect(labels('<mdscript name="S">\n  <cues/>\n  <|\n</mdscript>\n')).toEqual([]);
  });

  it('offers attribute names that are not present yet', () => {
    const { analysis, offset } = at(actions('<set_value |/>'));
    const items = completionAt(analysis, offset, game, { snippetSupport: true });
    expect(items.map((item) => item.label)).toEqual(['name', 'exact', 'operation', 'comment']);
    expect(items[0].insertText).toBe('name="$1"');
    expect(items[0].labelDetails?.description).toBe('required');
    expect(items[1].detail).toBe('expression');
    expect(completionAt(analysis, offset, game).find((item) => item.label === 'exact')?.insertText).toBe('exact=""');
    expect(labels(actions('<set_value na|/>'))).toEqual(['name']);
    expect(labels(actions('<set_value name="$x" |/>'))).toEqual(['exact', 'operation', 'comment']);
  });

  it('offers enumeration values', () => {
    expect(labels(actions('<set_value name="$x" operation="|"/>'))).toEqual(['set', 'add', 'subtract']);
    expect(labels(actions('<set_value name="$x" operation="a|"/>'))).toEqual(['add']);
    expect(labels(cue('<cues><cue name="B" instantiate="|"/></cues>'))).toEqual(['true', 'false']);
  });

  it('offers property chains, keywords and enumeration values in expressions', () => {
    expect(labels(actions('<set_value name="$x" exact="player.ship.|"/>'))).toEqual([
      'pilot',
      'speed',
      'dock',
      'cargo',
      'owner',
      'exists',
      'name',
      'isclass',
      'distanceto',
      'sector',
    ]);
    expect(labels(actions('<set_value name="$x" exact="player.ship.cargo.|"/>'))).toEqual(['{$ware}', 'list']);
    // As the editor lists them, by sort text: `{…}` first, then the bare values of the shortcut.
    const { analysis, offset } = at(actions('<set_value name="$x" exact="$ship.isclass.|"/>'));
    const sorted = completionAt(analysis, offset, game, { snippetSupport: true }).sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
    expect(sorted.map((item) => item.label)).toEqual(['{$class}', '{$list}', 'ship', 'station']);
    expect(sorted[0].textEdit && 'newText' in sorted[0].textEdit ? sorted[0].textEdit.newText : '').toBe('{$1}');
    const keywords = game.properties?.keywordsFor('md').map((keyword) => keyword.name) ?? [];
    expect(keywords.slice(0, 6)).toEqual(['player', 'true', 'this', 'class', 'ware', 'skilltype']);
    // The keywords, then the cues of the script (`A`).
    expect(labels(actions('<set_value name="$x" exact="|"/>'))).toEqual([...keywords, 'A']);
    expect(labels(actions('<set_value name="$x" exact="pl|"/>'))).toEqual(['player']);
    expect(labels(actions('<set_value name="$x" exact="1 + pl|"/>'))).toEqual(['player']);
    expect(labels(actions('<set_value name="$x" exact="\'pla|\'"/>'))).toEqual([]);
    expect(labels(actions('<set_value name="$x" comment="pla|"/>'))).toEqual([]);
    expect(labels(actions('<set_value name="$x" exact="player.ship |"/>'))).toEqual([]);
    expect(labels(actions('<find_ship name="$s" class="|"/>'))).toEqual(['ship', 'station', ...keywords, 'A']);
  });

  it('inserts a placeholder as braces and maps ranges back through entities', () => {
    const { analysis, offset } = at(actions('<set_value name="$x" exact="player.ship.cargo.|"/>'));
    const items = completionAt(analysis, offset, game, { snippetSupport: true });
    const placeholder = items.find((item) => item.label === '{$ware}');
    expect(placeholder?.textEdit).toMatchObject({ newText: '{$1}' });
    const entity = at(actions('<do_if value="1 &lt; 2 and player.sh|">'));
    const edit = completionAt(entity.analysis, entity.offset, game).find((item) => item.label === 'ship')?.textEdit;
    expect(edit && 'range' in edit ? edit.range.start.character : undefined).toBe('        <do_if value="1 &lt; 2 and player.'.length);
  });

  it('offers nothing without game data, and outside scripts nothing but text references', () => {
    const { analysis, offset } = at(actions('<set_value name="$x" exact="player.|"/>'));
    expect(completionAt(analysis, offset, undefined)).toEqual([]);
    const other = at('<wares><ware id="x" name="|"/></wares>');
    expect(completionAt(other.analysis, other.offset, game)).toEqual([]);
    const reference = at('<wares><ware id="x" name="{|"/></wares>');
    expect(completionAt(reference.analysis, reference.offset, undefined)).toEqual([]);
  });
});

describe('hover', () => {
  it('describes elements, attributes and enumeration values', () => {
    expect(hoverText(actions('<set_|value name="$x"/>'))).toContain('Sets a variable.');
    expect(hoverText(actions('<set_value name="$x"/>|'))).toBeUndefined();
    expect(hoverText(cue('<actions></act|ions>'))).toContain('actions');
    const attribute = hoverText(actions('<set_value na|me="$x"/>'));
    expect(attribute).toContain('**name** of');
    expect(attribute).toContain('`lvalueexpression`');
    expect(attribute).toContain('Required');
    expect(hoverText(actions('<set_value name="$x" operation="a|dd"/>'))).toContain('**add**');
    expect(hoverText(actions('<find_ship name="$s" class="sh|ip"/>'))).toContain('Any ship');
  });

  it('describes keywords, properties and candidates in expressions', () => {
    expect(hoverText(actions('<set_value name="$x" exact="pla|yer.ship"/>'))).toContain('**player** *(keyword)*');
    const property = hoverText(actions('<set_value name="$x" exact="player.sh|ip"/>'));
    expect(property).toContain('**player.ship**');
    expect(property).toContain('The player ship');
    expect(hoverText(actions('<set_value name="$x" exact="player.ship.cargo.{ware.o|re}.count"/>'))).toContain('**ware.ore**');
    expect(hoverText(actions('<set_value name="$y" exact="$x.na|me"/>'))).toContain('matches a property of 2 datatypes');
    // The steps after the hovered one count, and every property that fits as well is shown.
    for (const owner of ['$x', 'player.ship']) {
      const both = hoverText(actions(`<set_value name="$y" exact="${owner}.iscla|ss.{$z}"/>`));
      expect(both).toContain('2 properties match here');
      expect(both).toContain('**component.isclass.\\{$class\\}**');
      expect(both).toContain('**component.isclass.\\{$list\\}**');
    }
    expect(hoverText(actions('<set_value name="$x" exact="player.ship.iscla|ss.ship"/>'))).toContain('**component.isclass.&lt;classname&gt;**');
    expect(hoverText(actions('<set_value name="$x" exact="player.ship.frob|nicate"/>'))).toBeUndefined();
    expect(hoverText(actions('<set_value name="$x" exact="\'pla|yer\'"/>'))).toBeUndefined();
  });
});

describe('definition', () => {
  it('points into the schema and property files', () => {
    expect(definitionFiles(actions('<set_|value name="$x"/>'))).toEqual(['common.xsd']);
    expect(definitionFiles(cue('<cues><c|ue name="B"/></cues>'))).toEqual(['md.xsd']);
    expect(definitionFiles(actions('<set_value na|me="$x"/>'))).toEqual(['common.xsd']);
    expect(definitionFiles(actions('<set_value name="$x" operation="a|dd"/>'))).toEqual(['common.xsd']);
    expect(definitionFiles(actions('<set_value name="$x" exact="pla|yer.ship"/>'))).toEqual(['scriptproperties.xml']);
    expect(definitionFiles(actions('<set_value name="$x" exact="player.sh|ip"/>'))).toEqual(['scriptproperties.xml']);
    expect(definitionFiles(actions('<set_value name="$x" exact="player.ship.cargo.{ware.o|re}.count"/>'))).toEqual(['wares.xml']);
    expect(definitionFiles(actions('<set_value name="$y" exact="$x.na|me"/>'))).toEqual(['scriptproperties.xml', 'scriptproperties.xml']);
    expect(definitionFiles(actions('<set_value name="$x" exact="player.ship.frob|nicate"/>'))).toEqual([]);
    const { analysis, offset } = at(actions('<set_value name="$x" exact="pla|yer"/>'));
    expect(definitionAt(analysis, offset, undefined)).toEqual([]);
  });
});

describe('after a class test', () => {
  // `player.entity` is an entity; a ship test makes it a ship where the test holds.
  const inShipTest = (body: string): string => actions(`<do_if value="player.entity.isclass.ship">\n          ${body}\n        </do_if>`);

  it("completes the class's properties", () => {
    expect(labels(actions('<set_value name="$x" exact="player.entity.|"/>'))).toContain('skill');
    const narrowed = labels(inShipTest('<set_value name="$x" exact="player.entity.|"/>'));
    expect(narrowed).toEqual(expect.arrayContaining(['pilot', 'speed', 'cargo', 'owner', 'sector']));
    expect(narrowed).not.toContain('skill');
  });

  it('describes the property of the class, and the narrowed step with the test that tells it', () => {
    expect(hoverText(inShipTest('<set_value name="$x" exact="player.entity.sp|eed"/>'))).toContain('Current speed');
    expect(hoverText(actions('<set_value name="$x" exact="player.entity.isclass.ship and player.ent|ity.speed"/>'))).toContain(
      'Here a `ship`, by `isclass.ship` at line 5'
    );
    expect(hoverText(actions('<set_value name="$x" exact="player.ent|ity"/>'))).not.toContain('Here a');
  });

  it('completes and describes where a negated test is false: in do_else, and after a guard that returns', () => {
    const negated = '<do_if value="not player.entity.isclass.ship">\n          <return/>\n        </do_if>';
    expect(labels(actions(`${negated}\n        <set_value name="$x" exact="player.entity.|"/>`))).toContain('speed');
    expect(
      labels(
        actions(
          `<do_if value="not player.entity.isclass.ship"/>\n        <do_else>\n          <set_value name="$x" exact="player.entity.|"/>\n        </do_else>`
        )
      )
    ).toContain('speed');
    expect(hoverText(actions(`${negated}\n        <set_value name="$x" exact="player.ent|ity.speed"/>`))).toContain(
      'Here a `ship`, by `not isclass.ship` at line 5'
    );
    // While typing: the do_else not closed yet, nor the value.
    expect(
      labels(actions('<do_if value="not player.entity.isclass.ship"/>\n        <do_else>\n          <set_value name="$x" exact="player.entity.|\n'))
    ).toContain('speed');
  });

  it("goes to the class's property", () => {
    expect(definitionFiles(actions('<set_value name="$x" exact="player.entity.sp|eed"/>'))).toEqual([]);
    expect(definitionFiles(inShipTest('<set_value name="$x" exact="player.entity.sp|eed"/>'))).toEqual(['scriptproperties.xml']);
  });

  it('works while typing: completes after a test in a value whose closing quote is missing', () => {
    expect(labels(actions('<set_value name="$x" exact="player.entity.isclass.ship and player.entity.|\n'))).toContain('speed');
  });
});

describe('while typing', () => {
  it('completes inside a start tag that is not closed yet', () => {
    expect(labels(actions('<set_value |\n'))).toEqual(['name', 'exact', 'operation', 'comment']);
    expect(labels(actions('<set_value na|\n'))).toEqual(['name']);
    expect(labels(actions('<set_value name="$x" ex|\n'))).toEqual(['exact']);
    expect(labels(cue('<actions>\n        <set_val|\n      </actions>'))).toEqual(['set_value']);
  });

  it('completes inside a value whose closing quote is missing', () => {
    expect(labels(actions('<set_value name="$x" exact="player.ship.|\n'))).toEqual([
      'pilot',
      'speed',
      'dock',
      'cargo',
      'owner',
      'exists',
      'name',
      'isclass',
      'distanceto',
      'sector',
    ]);
    expect(labels(actions('<set_value name="$x" operation="|\n'))).toEqual(['set', 'add', 'subtract']);
    expect(labels(actions('<set_value name="$x exact="player.|"/>'))).toContain('ship');
    expect(labels(actions('<set_value name="$x" exact="player.ship.|/>'))).toContain('pilot');
    expect(labels(actions('<set_value name="$x" exact="player.ship |\n'))).toEqual([]);
    expect(labels(actions('<set_value name="$x" exact="player.ship + |\n'))).toContain('player');
  });

  it('keeps working when the parent start tag or an end tag is missing', () => {
    expect(labels(cue('<actions\n        <set_value name="$x" exact="player.|"/>\n      </actions>'))).toContain('ship');
    expect(labels(cue('<actions\n        <set_value |/>\n      </actions>'))).toEqual(['name', 'exact', 'operation', 'comment']);
    expect(labels(cue('<actions>\n        <do_if value="1">\n          <|\n      </actions>'))).toContain('set_value');
    expect(hoverText(cue('<set_|value name="$x"/>'))).toContain('Sets a variable.');
    expect(definitionFiles(cue('<set_value na|me="$x"/>'))).toEqual(['common.xsd']);
  });

  it('falls back to any declaration of the element name', () => {
    const schema = game.schemas.schemas.md;
    expect(schema?.anyDeclaration('set_value')?.attributes.has('exact')).toBe(true);
    expect(schema?.anyDeclaration('position')?.attributes.has('x')).toBe(true);
    expect(schema?.anyDeclaration('frobnicate')).toBeUndefined();
    const { analysis, offset } = at(cue('<set_value name="$x" exact="pla|yer"/>'));
    expect(positionContext(analysis, offset, schema)).toMatchObject({ kind: 'attribute-value', declared: { name: 'exact' } });
    const withoutSchema = positionContext(analysis, offset);
    expect(withoutSchema.kind).toBe('attribute-value');
    expect((withoutSchema as { declared?: unknown }).declared).toBeUndefined();
  });
});

describe('variables', () => {
  /** Two variables set in cue A before the body: `$foo` (a ship) on line 5 and `$fob` on line 6; the body is line 7. */
  const script = (body: string): string => actions(`<set_value name="$foo" exact="player.ship"/>\n        <set_value name="$fob" exact="1"/>\n        ${body}`);
  const positions = (locations: { range: { start: { line: number; character: number } } }[]): string[] =>
    locations.map((location) => `${location.range.start.line + 1}:${location.range.start.character + 1}`);

  it('completes the variables of the table at the caret', () => {
    expect(labels(script('<set_value name="$bar" exact="$|"/>'))).toEqual(['$bar', '$fob', '$foo']);
    expect(labels(script('<set_value name="$bar" exact="$fo|"/>'))).toEqual(['$fob', '$foo']);
    expect(labels(script('<set_value name="$bar" exact="1 + $fo|"/>'))).toEqual(['$fob', '$foo']);
    expect(labels(script('<set_value name="$bar" exact="this.$|"/>'))).toEqual(['$bar', '$fob', '$foo']);
    expect(labels(script('<set_value name="$bar" exact="global.$|"/>'))).toEqual([]);
    expect(labels(script('<set_value name="$bar" exact="$foo.$|"/>'))).toEqual([]);
    expect(labels(script('<set_value name="$bar" exact="$nowhere + $|"/>'))).toEqual(['$bar', '$fob', '$foo']);
    expect(labels(script('<set_value name="$bar" exact="$fo|\n'))).toEqual(['$fob', '$foo']);
    const { analysis, offset } = at(script('<set_value name="$bar" exact="$fo|"/>'));
    const foo = completionAt(analysis, offset, game).find((item) => item.label === '$foo');
    expect(foo?.detail).toBe('ship');
    expect(foo?.textEdit).toMatchObject({ newText: '$foo', range: { start: { line: 6, character: 38 }, end: { line: 6, character: 41 } } });
  });

  it('describes the variable under the caret', () => {
    const text = hoverText(script('<set_value name="$bar" exact="$fo|o"/>'));
    expect(text).toContain('**$foo** *(variable of cue `A`)*');
    expect(text).toContain('Type: `ship`');
    expect(text).toContain('Set 1 time · Read 1 time');
    expect(text).toContain('First set in \\<set\\_value\\> at line 5');
    expect(hoverText(script('<set_value name="$bar" exact="$nowh|ere"/>'))).toContain('Never set here');
    expect(hoverText(script('<set_value name="$bar" exact="$foo.$ke|y"/>')) ?? '').not.toContain('(variable of');
    expect(hoverText(script('<set_value name="$bar" exact="$foo.sp|eed"/>'))).toContain('**ship.speed**');
  });

  it('resolves chains on a variable of known type, and tells where the type comes from', () => {
    expect(labels(script('<set_value name="$bar" exact="$foo.|"/>')).sort()).toEqual([
      'cargo',
      'distanceto',
      'dock',
      'exists',
      'isclass',
      'name',
      'owner',
      'pilot',
      'sector',
      'speed',
    ]);
    expect(labels(script('<set_value name="$bar" exact="$nowhere.|"/>'))).toContain('len');
    // One property, not every datatype's `name`.
    expect(hoverText(script('<set_value name="$bar" exact="$foo.na|me"/>'))).toContain('**component.name**');
    expect(definitionFiles(script('<set_value name="$bar" exact="$foo.na|me"/>'))).toEqual(['scriptproperties.xml']);
    expect(hoverText(script('<set_value name="$bar" exact="$fo|o"/>'))).toContain('Type from \\<set\\_value\\> at line 5: the value it sets');
    const made = hoverText(actions('<create_ship name="$made" macro="m"/>\n        <set_value name="$x" exact="$ma|de.speed"/>'));
    expect(made).toContain('Type: `ship` (guessed)');
    expect(made).toContain("Type from \\<create\\_ship\\> at line 5: guessed from the action's name");
    // Two types: both shown, none used.
    const both = hoverText(script('<set_value name="$foo" exact="player.money"/>\n        <set_value name="$bar" exact="$fo|o.speed"/>'));
    expect(both).toContain('Set to: `ship`, `integer`');
    expect(both).not.toContain('Type from');
  });

  it('goes to the definitions of the variable under the caret', () => {
    const { analysis, offset } = at(script('<set_value name="$bar" exact="$fo|o"/>'));
    const locations = definitionAt(analysis, offset, game);
    expect(positions(locations)).toEqual(['5:26']);
    expect(locations[0].uri).toBe(analysis.document.uri);
    expect(definitionAt(analysis, offset, undefined)).toEqual(locations);
    expect(definitionFiles(script('<set_value name="$bar" exact="$nowh|ere"/>'))).toEqual([]);
  });

  it('lists references and renames every occurrence', () => {
    const { analysis, offset } = at(script('<set_value name="$bar" exact="$fo|o + this.$foo"/>\n        <remove_value name="$foo"/>'));
    expect(positions(referencesAt(analysis, offset))).toEqual(['5:26', '7:39', '7:51', '8:29']);
    expect(prepareRenameAt(analysis, offset)).toMatchObject({ placeholder: '$foo', range: { start: { line: 6, character: 38 } } });
    expect(editsOf(renameAt(analysis, offset, '$baz')).map((edit) => edit.newText)).toEqual(['$baz', '$baz', '$baz', '$baz']);
    expect(editsOf(renameAt(analysis, offset, 'qux'))[0].newText).toBe('$qux');
    expect(referencesAt(analysis, 0)).toEqual([]);
    expect(prepareRenameAt(analysis, 0)).toBeUndefined();
    expect(renameAt(analysis, 0, '$z')).toBeUndefined();
  });

  it('renames a parameter without the dollar sign', () => {
    const ai = at(
      '<aiscript name="a">\n  <params>\n    <param name="foo"/>\n  </params>\n  <attention min="1">\n    <actions>\n      <set_value name="$n" exact="$f|oo"/>\n    </actions>\n  </attention>\n</aiscript>\n'
    );
    expect(positions(referencesAt(ai.analysis, ai.offset))).toEqual(['3:18', '7:35']);
    expect(editsOf(renameAt(ai.analysis, ai.offset, '$baz')).map((edit) => edit.newText)).toEqual(['baz', '$baz']);
  });
});

describe('labels, cues and interrupt library items', () => {
  /**
   * An AI script with an interrupt library (lines 4 and 5), a handler whose actions are line 9, and two
   * attention blocks that both define `start` (lines 15 and 21); line 16 is the first block's body.
   */
  const ai = (attention: string, handler = ''): string =>
    [
      '<aiscript name="a">',
      '  <interrupts>',
      '    <library>',
      '      <actions name="LibActions"/>',
      '      <handler name="LibHandler"/>',
      '    </library>',
      '    <handler>',
      '      <actions>',
      `        ${handler}`,
      '      </actions>',
      '    </handler>',
      '  </interrupts>',
      '  <attention min="unknown">',
      '    <actions>',
      '      <label name="start"/>',
      `      ${attention}`,
      '    </actions>',
      '  </attention>',
      '  <attention min="visible">',
      '    <actions>',
      '      <label name="start"/>',
      '      <label name="other"/>',
      '    </actions>',
      '  </attention>',
      '</aiscript>',
      '',
    ].join('\n');
  const lines = (locations: { range: { start: { line: number } } }[]): number[] => locations.map((location) => location.range.start.line + 1);

  it('completes the labels and library items a reference may name', () => {
    expect(labels(ai('<resume label="|"/>'))).toEqual(['start']);
    expect(labels(ai('<resume label="o|"/>'))).toEqual([]);
    expect(labels(ai('', '<abort_called_scripts resume="|"/>'))).toEqual(['other', 'start']);
    expect(labels(ai('', '<include_interrupt_actions ref="|"/>'))).toEqual(['LibActions']);
    expect(labels(ai('<resume label="st|\n'))).toEqual(['start']);
    const { analysis, offset } = at(ai('<resume label="s|t"/>'));
    const item = completionAt(analysis, offset, game).find((candidate) => candidate.label === 'start');
    expect(item?.textEdit).toMatchObject({ newText: 'start', range: { start: { line: 15, character: 21 }, end: { line: 15, character: 23 } } });
    expect(item?.detail).toBe('label');
  });

  it('completes cue names in Mission Director expressions', () => {
    expect(labels(actions('<cancel_cue cue="A|"/>'))).toEqual(['A']);
    expect(labels(actions('<set_value name="$x" exact="1 + A|"/>'))).toEqual(['A']);
    expect(labels(actions('<set_value name="$x" exact="player.A|"/>'))).toEqual([]);
  });

  it('describes labels, library items and cues', () => {
    const label = hoverText(ai('<resume label="st|art"/>'));
    expect(label).toContain('**start** *(label)*');
    expect(label).toContain('In the attention block for `unknown`');
    expect(label).toContain('Defined at line 15 · Referenced 1 time');
    expect(hoverText(ai('', '<abort_called_scripts resume="st|art"/>'))).toContain('Defined at lines 15, 21 in 2 attention blocks');
    expect(hoverText(ai('<label name="ot|her"/>'))).toContain('**other** *(label)*');
    expect(hoverText(ai('', '<include_interrupt_actions ref="LibAc|tions"/>'))).toContain('**LibActions** *(interrupt actions)*');
    expect(hoverText(ai('', '<include_interrupt_actions ref="Elsew|here"/>'))).toContain('Defined in another script');
    const cueHover = hoverText(actions('<cancel_cue cue="|A"/>'));
    expect(cueHover).toContain('**A** *(cue)*');
    expect(cueHover).toContain('Defined at line 3 · Referenced 1 time');
    expect(hoverText(actions('<cancel_cue cue="Nowh|ere"/>'))).toContain('Not defined in this script');
  });

  it('goes to the definitions of a label, a library item and a cue', () => {
    const inBlock = at(ai('<resume label="st|art"/>'));
    expect(lines(definitionAt(inBlock.analysis, inBlock.offset, game))).toEqual([15]);
    const fromHandler = at(ai('', '<abort_called_scripts resume="st|art"/>'));
    expect(lines(definitionAt(fromHandler.analysis, fromHandler.offset, game))).toEqual([15, 21]);
    const library = at(ai('', '<include_interrupt_actions ref="LibActi|ons"/>'));
    expect(lines(definitionAt(library.analysis, library.offset, game))).toEqual([4]);
    const cueReference = at(actions('<set_value name="$x" exact="A|.$y"/>'));
    expect(lines(definitionAt(cueReference.analysis, cueReference.offset, game))).toEqual([3]);
  });

  it('finds references and renames everything a handler ties together', () => {
    const { analysis, offset } = at(ai('<resume label="start"/>', '<abort_called_scripts resume="st|art"/>'));
    expect(lines(referencesAt(analysis, offset))).toEqual([9, 15, 16, 21]);
    expect(prepareRenameAt(analysis, offset)).toMatchObject({ placeholder: 'start', range: { start: { line: 8, character: 38 } } });
    expect(editsOf(renameAt(analysis, offset, ' begin ')).map((edit) => edit.newText)).toEqual(['begin', 'begin', 'begin', 'begin']);
    expect(renameAt(analysis, offset, '  ')).toBeUndefined();
    const other = at(ai('<label name="ot|her"/>'));
    expect(lines(referencesAt(other.analysis, other.offset))).toEqual([16]);
    const cueRename = at(actions('<cancel_cue cue="A"/>\n        <set_value name="$x" exact="md.S.A|.$y"/>'));
    expect(lines(referencesAt(cueRename.analysis, cueRename.offset))).toEqual([3, 5, 6]);
    expect(editsOf(renameAt(cueRename.analysis, cueRename.offset, 'Begin')).map((edit) => edit.range.start.character)).toEqual([15, 25, 41]);
  });
});

describe('texts', () => {
  const hoverWith = (marked: string, options: { language?: string; limitLanguage?: boolean }): string | undefined => {
    const { analysis, offset } = at(marked);
    const found = hoverAt(analysis, offset, game, options);
    return found && typeof found.contents === 'object' && 'value' in found.contents ? found.contents.value : undefined;
  };

  it('shows a text as the game does, and how it is written', () => {
    const text = hoverText(actions('<debug_text text="{1001, |4}"/>'));
    expect(text).toContain('**{1001, 4}** · page *Interface*');
    expect(text).toContain('Hull and Shield');
    expect(text).toContain('Written as: \\{1001,1\\} and \\{1001, 2\\}');
    expect(hoverText(actions('<debug_text text="{1001,99|}"/>'))).toContain('Text 99 does not exist on page 1001');
    expect(hoverText(actions('<speak page="1001" li|ne="2"/>'))).toContain('Shield');
  });

  it('shows every language, or only the preferred one', () => {
    const all = hoverWith(actions('<debug_text text="{1001,|1}"/>'), { language: '49' });
    expect(all).toContain('*Deutsch:* Hülle');
    expect(all).toContain('*English:* Hull');
    expect(all?.indexOf('Deutsch')).toBeLessThan(all?.indexOf('English') ?? 0);
    const german = hoverWith(actions('<debug_text text="{1001,|1}"/>'), { language: '49', limitLanguage: true });
    expect(german).toContain('Hülle');
    expect(german).not.toContain('Hull');
    expect(hoverWith(actions('<debug_text text="{1001,|3}"/>'), { language: '49', limitLanguage: true })).toContain('None');
  });

  it('works in any XML, and while it does not parse', () => {
    expect(hoverText('<wares>\n  <ware id="x" name="{1001,|2}"/>\n</wares>\n')).toContain('Shield');
    expect(hoverText('<wares>\n  <ware id="x|" name="{1001,2}"/>\n</wares>\n')).toBeUndefined();
    expect(hoverText(actions('<debug_text text="{1001,|2}\n'))).toContain('Shield');
  });

  it('goes to the text in the preferred language', () => {
    expect(definitionFiles(actions('<debug_text text="{1001,|1}"/>'))).toEqual(['0001-l044.xml']);
    const { analysis, offset } = at(actions('<debug_text text="{1001,|1}"/>'));
    const german = definitionAt(analysis, offset, game, { language: '49' });
    expect(german.map((location) => path.basename(location.uri))).toEqual(['0001-l049.xml']);
    expect(german[0].range.start).toEqual({ line: 4, character: 4 });
    expect(definitionFiles(actions('<debug_text text="{1001,|99}"/>'))).toEqual([]);
  });

  it('completes pages and text ids', () => {
    const afterBrace = labels(actions('<debug_text text="{|"/>'));
    expect(afterBrace.slice(0, 2)).toEqual(['1001', '1002']);
    expect(afterBrace).toContain('player');
    expect(labels(actions('<debug_text text="{10|"/>'))).toEqual(['1001', '1002']);
    expect(labels(actions('<debug_text text="{1001,|"/>'))).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(labels(actions('<debug_text text="{1001, 1|"/>'))).toEqual(['1']);
    expect(labels(actions('<debug_text text="{1001,|\n'))).toHaveLength(7);
    expect(labels(actions('<set_value name="$x" exact="$x.{|"/>'))).not.toContain('1001');
    expect(labels(actions('<set_value name="$x" exact="1" comment="{|"/>'))).toEqual([]);
    const { analysis, offset } = at(actions('<debug_text text="{1001,|4}"/>'));
    const item = completionAt(analysis, offset, game).find((candidate) => candidate.label === '4');
    expect(item?.detail).toBe('Hull and Shield');
    expect(item?.textEdit).toMatchObject({ range: { start: { character: 32 }, end: { character: 33 } } });
  });

  it('completes pages and text ids in XML that is no script, also while it does not parse', () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7'];
    const pages = labels('<wares>\n  <ware id="x" name="{|"/>\n</wares>\n');
    expect(pages.slice(0, 2)).toEqual(['1001', '1002']);
    // Pages only: no keywords outside scripts.
    expect(pages).not.toContain('player');
    expect(labels('<wares>\n  <ware id="x" name="{10|"/>\n</wares>\n')).toEqual(['1001', '1002']);
    expect(labels('<wares>\n  <ware id="x" name="{1001, |"/>\n</wares>\n')).toEqual(ids);
    // In the text of a text file, and in a value whose quote is not closed yet.
    expect(labels('<language>\n  <page id="2">\n    <t id="1">See {1001,|</t>\n')).toEqual(ids);
    expect(labels('<wares>\n  <ware id="x" name="{1001,|\n</wares>\n')).toEqual(ids);
    // `page="…" line="…"`: the line of the page, and the page beside a line.
    expect(labels('<macros>\n  <macro name="m" page="1001" line="|"/>\n</macros>\n')).toEqual(ids);
    expect(labels('<macros>\n  <macro name="m" page="|" line="1"/>\n</macros>\n').slice(0, 2)).toEqual(['1001', '1002']);
    expect(labels('<macros>\n  <macro name="m" page="|"/>\n</macros>\n')).toEqual([]);
    expect(labels('<wares>\n  <ware id="x" name="$x.{|"/>\n</wares>\n')).toEqual([]);
    // A patch of a text file: what it adds is text too.
    const patch = '<diff>\n  <add sel="/language/page[@id=\'1001\']">\n    <t id="90">{1001,|</t>\n  </add>\n</diff>\n';
    const textPatch = analyzeText(patch.replace('|', ''), { schemas: game.schemas }, pathToFileURL(path.join(unpacked, 't', '0001-l044.xml')).toString());
    expect(completionAt(textPatch, patch.indexOf('|'), game).map((candidate) => candidate.label)).toEqual(ids);
    // The digits after the caret are replaced too.
    const { analysis, offset } = at('<wares>\n  <ware id="x" name="{1001,|4}"/>\n</wares>\n');
    const item = completionAt(analysis, offset, game).find((candidate) => candidate.label === '4');
    expect(item?.detail).toBe('Hull and Shield');
    expect(item?.textEdit).toMatchObject({ range: { start: { line: 1, character: 27 }, end: { line: 1, character: 28 } } });
  });
});
