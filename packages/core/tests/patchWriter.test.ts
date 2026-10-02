import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, comparePatch, documentTree, loadGameData, loadScriptIndex, parseXml, type AnalysisContext, type PatchNode } from '../src';
import { lineEdits, pathOf, writePatch, type PatchTextEdit, type PatchWrite } from '../src/patches/patchWriter';

const fixtures = fileURLToPath(new URL('./fixtures/patches', import.meta.url));
const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const gameFolder = path.join(fixtures, 'game');
const modsFolder = path.join(fixtures, 'mods');
const game = loadGameData(unpacked);
const index = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
const context: AnalysisContext = { schemas: game.schemas, properties: game.properties, index };
const latePatch = path.join(modsFolder, 'late_mod', 'md', 'setup.xml');

// The operations of late_mod's patch that apply, after early_mod's patch added the cue Early.
const patchText = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<diff>',
  `  <add sel="//cue[@name='Early']" pos="after">`,
  '    <cue name="Late" />',
  '  </add>',
  `  <replace sel="//cue[@name='Start']/actions/set_value[@name='$count']/@exact">2</replace>`,
  `  <replace sel="//comment()[. = ' patchmarker ']">`,
  '    <set_value name="$a" exact="1" />',
  '    <set_value name="$b" exact="2" />',
  '  </replace>',
  `  <add sel="//cue[@name='Later']" type="@instantiate">true</add>`,
  '</diff>',
  '',
].join('\n');

function applyEdits(text: string, edits: readonly PatchTextEdit[]): string {
  return [...edits]
    .sort((a, b) => b.offset - a.offset)
    .reduce((result, edit) => result.slice(0, edit.offset) + edit.text + result.slice(edit.offset + edit.length), text);
}

/** The patch written for the side after a change of it; the edits must give the same text. */
function write(change: (after: string) => string, text = patchText): PatchWrite & { after: string } {
  const patch = analyzeText(text, context, pathToFileURL(latePatch).toString()).patch!;
  const after = comparePatch(patch, index)!.after;
  const written = writePatch(patch, change(after), index);
  if (written.text !== undefined) {
    expect(applyEdits(text, written.edits)).toBe(written.text);
  }
  return { ...written, after };
}

const labels = (written: PatchWrite): string[] => written.changes.map((change) => `${change.line + 1} ${change.kind}: ${change.label}`);

describe('the patch for an edited side: what the patch brings in', () => {
  it('writes nothing for the side as the patch gives it, whatever its line breaks', () => {
    expect(write((after) => after)).toMatchObject({ text: patchText, edits: [], changes: [], refused: [] });
    expect(write((after) => after.replace(/\n/g, '\r\n')).text).toBe(patchText);
  });

  it('edits an element the patch brings in where the patch has it', () => {
    const written = write((after) => after.replace('<cue name="Late" />', '<cue name="Late" checkinterval="1s" />'));
    expect(written.text).toBe(patchText.replace('<cue name="Late" />', '<cue name="Late" checkinterval="1s" />'));
    expect(labels(written)).toEqual(['15 content: <cue> the patch brings in changed']);
  });

  it('changes and removes the values the patch sets in the operations that set them', () => {
    expect(write((after) => after.replace('name="$count" exact="2"', 'name="$count" exact="3"')).text).toBe(patchText.replace('/@exact">2<', '/@exact">3<'));
    // The game's cue has no such attribute: the operation goes.
    expect(write((after) => after.replace(' instantiate="true"', '')).text).toBe(
      patchText.replace(`  <add sel="//cue[@name='Later']" type="@instantiate">true</add>\n`, '')
    );
    // The game's element has it: the patch removes it instead.
    expect(write((after) => after.replace('name="$count" exact="2"', 'name="$count"')).text).toBe(
      patchText.replace(
        `<replace sel="//cue[@name='Start']/actions/set_value[@name='$count']/@exact">2</replace>`,
        `<remove sel="//cue[@name='Start']/actions/set_value[@name='$count']/@exact"/>`
      )
    );
  });

  it('adds and removes elements where the patch brings in their neighbours', () => {
    expect(write((after) => after.replace('<cue name="Late" />', '<cue name="Late" />\n    <cue name="Latest" />')).text).toBe(
      patchText.replace('    <cue name="Late" />\n', '    <cue name="Late" />\n    <cue name="Latest" />\n')
    );
    expect(write((after) => after.replace('        <set_value name="$b" exact="2" />\n', '')).text).toBe(
      patchText.replace('    <set_value name="$b" exact="2" />\n', '')
    );
    // A line typed in what the side shows at the replaced element's column goes in at the patch's.
    expect(
      write((after) => after.replace('<set_value name="$b" exact="2" />', '<set_value name="$b" exact="2" />\n        <set_value name="$c" exact="3" />')).text
    ).toBe(patchText.replace('    <set_value name="$b" exact="2" />\n', '    <set_value name="$b" exact="2" />\n    <set_value name="$c" exact="3" />\n'));
  });

  it('drops an add left with nothing, and makes a replace left with nothing a remove', () => {
    expect(write((after) => after.replace('    <cue name="Late" />\n', '')).text).toBe(
      patchText.replace(`  <add sel="//cue[@name='Early']" pos="after">\n    <cue name="Late" />\n  </add>\n`, '')
    );
    expect(write((after) => after.replace('        <set_value name="$a" exact="1" />\n        <set_value name="$b" exact="2" />\n', '')).text).toBe(
      patchText.replace(
        `<replace sel="//comment()[. = ' patchmarker ']">\n    <set_value name="$a" exact="1" />\n    <set_value name="$b" exact="2" />\n  </replace>`,
        `<remove sel="//comment()[. = ' patchmarker ']"/>`
      )
    );
  });
});

describe("the patch for an edited side: the game's file", () => {
  const replaceMode = `  <replace sel="/mdscript/cues/cue[@name='Start']/actions/set_value[@name='$mode']/@exact">'hard'</replace>\n`;
  const beforeLater = `  <add sel="//cue[@name='Later']"`;

  it('sets a value with a new operation, after the one that changes the nearest place before it', () => {
    const written = write((after) => after.replace(`exact="'easy'"`, `exact="'hard'"`));
    expect(written.text).toBe(patchText.replace(beforeLater, `${replaceMode}${beforeLater}`));
    expect(labels(written)).toEqual([`10 operation: @exact of <set_value> set to "'hard'"`]);
  });

  it('adds and removes attributes and elements with new operations, in the order of the places they change', () => {
    const written = write((after) =>
      after
        .replace('<cue name="Start">', '<cue name="Start" instantiate="true">')
        .replace(`        <set_value name="$mode" exact="'easy'" />\n`, '')
        .replace('<cue name="Later" instantiate="true"/>', '<cue name="Later" instantiate="true"/>\n    <cue name="Mine">\n      <actions />\n    </cue>')
    );
    expect(written.refused).toEqual([]);
    expect(written.text?.split('\n')).toEqual([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<diff>',
      `  <add sel="/mdscript/cues/cue[@name='Start']" type="@instantiate">true</add>`,
      `  <add sel="//cue[@name='Early']" pos="after">`,
      '    <cue name="Late" />',
      '  </add>',
      `  <replace sel="//cue[@name='Start']/actions/set_value[@name='$count']/@exact">2</replace>`,
      `  <replace sel="//comment()[. = ' patchmarker ']">`,
      '    <set_value name="$a" exact="1" />',
      '    <set_value name="$b" exact="2" />',
      '  </replace>',
      `  <remove sel="/mdscript/cues/cue[@name='Start']/actions/set_value[@name='$mode']"/>`,
      `  <add sel="//cue[@name='Later']" type="@instantiate">true</add>`,
      `  <add sel="/mdscript/cues/cue[@name='Later']" pos="after">`,
      '    <cue name="Mine">',
      '      <actions />',
      '    </cue>',
      '  </add>',
      '</diff>',
      '',
    ]);
  });

  it("adds an element next to what the patch brings in to that operation's content", () => {
    const written = write((after) => after.replace('<cue name="Early" />', '<cue name="Early" />\n    <cue name="Mine" />'));
    expect(written.text).toBe(patchText.replace('    <cue name="Late" />\n', '    <cue name="Mine" />\n    <cue name="Late" />\n'));
    expect(labels(written)).toEqual(['15 content: <cue> added']);
  });

  it('escapes values for the operation text and for the path', () => {
    const written = write((after) => after.replace(`exact="'easy'"`, `exact="'a' &amp; &quot;b&quot; &lt; c"`));
    expect(written.text).toContain(`set_value[@name='$mode']/@exact">'a' &amp; "b" &lt; c</replace>`);
  });

  it('replaces an element whole when a new value spans lines, which the text of an operation cannot keep', () => {
    const written = write((after) => after.replace(`exact="'easy'"`, `exact="[\n          1,\n          2]"`));
    expect(written.refused).toEqual([]);
    expect(written.text).toContain(`<replace sel="/mdscript/cues/cue[@name='Start']/actions/set_value[@name='$mode']">`);
  });
});

describe('the patch for an edited side: what cannot be written', () => {
  it('tells a side that is not well-formed, at its first problem', () => {
    const written = write((after) => after.replace('</actions>', ''));
    expect(written.text).toBeUndefined();
    expect(written.refused).toHaveLength(1);
    expect(written.refused[0].reason).toMatch(/^Not well-formed/);
  });

  it('tells what a patch cannot do outside the root element', () => {
    const written = write((after) => after.replace('<mdscript', '<!-- mine -->\n<mdscript'));
    expect(written.refused.map((refusal) => refusal.reason)).toEqual(['A patch cannot add anything outside the root element']);
  });

  it('tells a change of an element the patch brings in and changes again', () => {
    const text = patchText.replace('</diff>', `  <add sel="//cue[@name='Late']" type="@checkinterval">1s</add>\n</diff>`);
    const written = write((after) => after.replace('<cue name="Late" checkinterval="1s"', '<cue name="Late" checkinterval="2s" version="2"'), text);
    // The value a later operation sets is changed there; the new attribute has no place.
    expect(written.refused.map((refusal) => refusal.reason)).toEqual(['The patch brings in <cue> and changes it again: change it where the patch does']);
  });

  it("tells text typed inside an element, the game's, the patch's or a new one, and writes nothing", () => {
    const reason = (name: string): string => `Text inside <${name}> changed: only elements, attributes and comments are written into the patch`;
    for (const [from, to, name] of [
      ['<cue name="Later" instantiate="true"/>', '<cue name="Later" instantiate="true">hello</cue>', 'cue'],
      ['<actions>', '<actions>hello', 'actions'],
      ['<cue name="Late" />', '<cue name="Late">hello</cue>', 'cue'],
      ['<cue name="Later" instantiate="true"/>', '<cue name="Later" instantiate="true"/>\n    <cue name="Mine">hello</cue>', 'cue'],
      ['    <cue name="Later"', '    hello\n    <cue name="Later"', 'cues'],
    ]) {
      const written = write((after) => after.replace(from, to));
      const edited = written.after.replace(from, to);
      expect(written.text, to).toBeUndefined();
      expect(written.refused, to).toEqual([{ line: edited.slice(0, edited.indexOf('hello')).split('\n').length - 1, reason: reason(name) }]);
    }
    // Whitespace is no text.
    expect(write((after) => after.replace('<cue name="Later" instantiate="true"/>', '<cue name="Later" instantiate="true">\n    </cue>'))).toMatchObject({
      text: patchText,
      refused: [],
    });
  });

  it("keeps the text a game's file holds, and tells a removal of it and a patch that would lose it", () => {
    const gameIcons = path.join(gameFolder, 'libraries', 'icons.xml');
    const lateIcons = path.join(modsFolder, 'late_mod', 'libraries', 'icons.xml');
    const edited = loadScriptIndex(gameFolder, [modsFolder], game.schemas);
    const target = readFileSync(gameIcons, 'utf8').replace(
      '<icon name="game_icon" texture="a.tga" />',
      '<icon name="game_icon" texture="a.tga">big</icon>\n  loose'
    );
    edited.setStructure(gameIcons, target, parseXml(target), 'game', true);
    const writeIcons = (text: string, change: (after: string) => string): PatchWrite & { side: string } => {
      const patch = analyzeText(text, { ...context, index: edited }, pathToFileURL(lateIcons).toString()).patch!;
      const side = change(comparePatch(patch, edited)!.after);
      return { ...writePatch(patch, side, edited), side };
    };
    const late = readFileSync(lateIcons, 'utf8');
    // The side shows the icon's text; what follows it in the game's <icons> is not shown before the patch's icon.
    const changed = writeIcons(late, (after) => after.replace('texture="c.tga"', 'texture="d.tga"'));
    expect(changed.refused).toEqual([]);
    expect(changed.text).toBe(late.replace('texture="c.tga"', 'texture="d.tga"'));
    expect(writeIcons(late, (after) => after.replace('>big<', '><')).refused.map((refusal) => refusal.reason)).toEqual([
      'Text inside <icon> changed: only elements, attributes and comments are written into the patch',
    ]);
    // With the icon's value set, the side shows all of <icons>; an icon added after it would leave its text out.
    const sizes = `<?xml version="1.0" encoding="utf-8"?>\n<diff>\n  <add sel="/icons/icon[@name='game_icon']" type="@size">2</add>\n</diff>\n`;
    const losing = writeIcons(sizes, (after) => after.replace('big</icon>', 'big</icon>\n  <icon name="mine" />'));
    expect(losing.refused).toEqual([
      { line: losing.side.slice(0, losing.side.indexOf('loose')).split('\n').length - 1, reason: 'The patch written would not give this text' },
    ]);
  });

  it('never throws on a side cut anywhere, as while typing', () => {
    const patch = analyzeText(patchText, context, pathToFileURL(latePatch).toString()).patch!;
    const after = comparePatch(patch, index)!.after;
    for (let cut = 0; cut <= after.length; cut += 11) {
      const written = writePatch(patch, after.slice(0, cut) + after.slice(cut + 3), index);
      expect(written.text !== undefined || written.refused.length > 0, `cut at ${cut}`).toBe(true);
    }
  });
});

describe('paths of new operations', () => {
  const text = [
    '<mdscript name="S">',
    '  <cues>',
    '    <cue name="A">',
    '      <actions>',
    `        <do_if value="$x == 'a'"><set_value name="$y" /></do_if>`,
    '        <do_if value="$z" />',
    '        <do_if value="$z" />',
    '        <do_else />',
    '        <do_else />',
    '        <!-- marker -->',
    '        <debug_text text="1" />',
    '        <debug_text text="1" chance="2" />',
    '      </actions>',
    '    </cue>',
    '  </cues>',
    '</mdscript>',
  ].join('\n');
  const tree = documentTree({ file: 'test.xml', text, structure: parseXml(text) });
  const all: PatchNode[] = [];
  const walk = (node: PatchNode): void => {
    all.push(node);
    node.children.forEach(walk);
  };
  walk(tree);
  const paths = all.filter((node) => node.kind !== 'document').map((node) => pathOf(node)?.text);

  it('names each step by its identifying attribute, with more attributes or a position where siblings share it', () => {
    expect(paths).toEqual([
      '/mdscript',
      '/mdscript/cues',
      `/mdscript/cues/cue[@name='A']`,
      `/mdscript/cues/cue[@name='A']/actions`,
      `/mdscript/cues/cue[@name='A']/actions/do_if[@value="$x == 'a'"]`,
      `/mdscript/cues/cue[@name='A']/actions/do_if[@value="$x == 'a'"]/set_value[@name='$y']`,
      `/mdscript/cues/cue[@name='A']/actions/do_if[@value='$z'][1]`,
      `/mdscript/cues/cue[@name='A']/actions/do_if[@value='$z'][2]`,
      `/mdscript/cues/cue[@name='A']/actions/do_else[1]`,
      `/mdscript/cues/cue[@name='A']/actions/do_else[2]`,
      `/mdscript/cues/cue[@name='A']/actions/comment()[.=' marker ']`,
      `/mdscript/cues/cue[@name='A']/actions/debug_text[@text='1'][1]`,
      `/mdscript/cues/cue[@name='A']/actions/debug_text[@text='1'][@chance='2']`,
    ]);
  });
});

describe('edits line by line', () => {
  it('gives the fewest line edits that make one text the other', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nd\ne\n';
    const edits = lineEdits(before, after);
    expect(edits).toEqual([
      { offset: 2, length: 2, text: 'B\n' },
      { offset: 8, length: 0, text: 'e\n' },
    ]);
    expect(applyEdits(before, edits)).toBe(after);
  });
});

it('reads the fixture patch as the tests expect', () => {
  expect(readFileSync(latePatch, 'utf8')).toContain(`<add sel="//cue[@name='Early']" pos="after">`);
});
