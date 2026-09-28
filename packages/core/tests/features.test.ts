import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, completionAt, definitionAt, hoverAt, loadGameData, positionContext, type DocumentAnalysis } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);

/** Analyses a text with a `|` marker for the caret and returns the analysis and the caret offset. */
function at(marked: string): { analysis: DocumentAnalysis; offset: number } {
  const offset = marked.indexOf('|');
  if (offset < 0) {
    throw new Error('no caret marker');
  }
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  return { analysis: analyzeText(text, { schemas: game.schemas }), offset };
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
    expect(labels(cue('<|'))).toEqual(['actions', 'conditions', 'cues', 'delay']);
    expect(labels(cue('<actions/>\n      <|'))).toEqual(['cues']);
    expect(labels(cue('<ac|\n'))).toEqual(['actions']);
    expect(labels(cue('<actions>\n        <|\n      </actions>'))).toEqual(['create_ship', 'debug_text', 'deliver', 'do_if', 'find_ship', 'set_value']);
    expect(labels(actions('<do_if value="1"><|</do_if>'))).toContain('set_value');
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
      'cargo',
      'owner',
      'exists',
      'name',
      'isclass',
      'sector',
    ]);
    expect(labels(actions('<set_value name="$x" exact="player.ship.cargo.|"/>'))).toEqual(['{$ware}', 'energycells', 'ore', 'list']);
    const keywords = game.properties?.keywordsFor('md').map((keyword) => keyword.name) ?? [];
    expect(keywords.slice(0, 6)).toEqual(['player', 'true', 'this', 'class', 'ware', 'skilltype']);
    expect(labels(actions('<set_value name="$x" exact="|"/>'))).toEqual(keywords);
    expect(labels(actions('<set_value name="$x" exact="pl|"/>'))).toEqual(['player']);
    expect(labels(actions('<set_value name="$x" exact="1 + pl|"/>'))).toEqual(['player']);
    expect(labels(actions('<set_value name="$x" exact="\'pla|\'"/>'))).toEqual([]);
    expect(labels(actions('<set_value name="$x" comment="pla|"/>'))).toEqual([]);
    expect(labels(actions('<set_value name="$x" exact="player.ship |"/>'))).toEqual([]);
    expect(labels(actions('<find_ship name="$s" class="|"/>'))).toEqual(['ship', 'station', ...keywords]);
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

  it('offers nothing without game data or outside scripts', () => {
    const { analysis, offset } = at(actions('<set_value name="$x" exact="player.|"/>'));
    expect(completionAt(analysis, offset, undefined)).toEqual([]);
    const other = at('<wares><ware id="x" name="|"/></wares>');
    expect(completionAt(other.analysis, other.offset, game)).toEqual([]);
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
    expect(hoverText(actions('<set_value name="$x" exact="$x.na|me"/>'))).toContain('matches a property of 2 datatypes');
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
    expect(definitionFiles(actions('<set_value name="$x" exact="$x.na|me"/>'))).toEqual(['scriptproperties.xml', 'scriptproperties.xml']);
    expect(definitionFiles(actions('<set_value name="$x" exact="player.ship.frob|nicate"/>'))).toEqual([]);
    const { analysis, offset } = at(actions('<set_value name="$x" exact="pla|yer"/>'));
    expect(definitionAt(analysis, offset, undefined)).toEqual([]);
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
    expect(labels(actions('<set_value name="$x" exact="player.ship.|\n'))).toEqual(['pilot', 'speed', 'cargo', 'owner', 'exists', 'name', 'isclass', 'sector']);
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
