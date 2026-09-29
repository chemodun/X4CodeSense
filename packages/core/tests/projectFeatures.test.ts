import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, completionAt, definitionAt, hoverAt, inlineCode, loadGameData, loadScriptIndex, type DocumentAnalysis, type GameData } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const base = loadGameData(unpacked);
const game: GameData = { ...base, index: loadScriptIndex(path.join(project, 'game'), [path.join(project, 'mods')], base.schemas) };

/** Analyses a text with a `|` marker for the caret. */
function at(marked: string): { analysis: DocumentAnalysis; offset: number } {
  const offset = marked.indexOf('|');
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  return { analysis: analyzeText(text, { schemas: game.schemas, properties: game.properties, index: game.index }), offset };
}

function hoverText(marked: string): string | undefined {
  const { analysis, offset } = at(marked);
  const found = hoverAt(analysis, offset, game);
  return found && typeof found.contents === 'object' && 'value' in found.contents ? found.contents.value : undefined;
}

function definitions(marked: string): string[] {
  const { analysis, offset } = at(marked);
  return definitionAt(analysis, offset, game).map((location) => `${path.basename(location.uri)}:${location.range.start.line + 1}`);
}

function labels(marked: string): string[] {
  const { analysis, offset } = at(marked);
  return completionAt(analysis, offset, game).map((item) => item.label);
}

const md = (body: string): string =>
  `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <actions>\n        ${body}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;
const ai = (interrupts: string, actions = ''): string =>
  `<aiscript name="a">\n  <interrupts>\n    ${interrupts}\n  </interrupts>\n  <attention min="1">\n    <actions>\n      ${actions}\n    </actions>\n  </attention>\n</aiscript>\n`;

describe('md.Script.Cue', () => {
  it('describes the script and the cue', () => {
    const script = hoverText(md('<cancel_cue cue="md.Set|up.Start"/>'));
    expect(script).toContain('**Setup** *(Mission Director script)*');
    expect(script).toContain('In setup.xml of `game`, line 3');
    expect(script).toContain('4 cues and libraries');
    const cue = hoverText(md('<cancel_cue cue="md.Setup.St|art"/>'));
    expect(cue).toContain('**Start** *(cue of Setup)*');
    expect(cue).toContain('Instantiated · Namespace `this`');
    expect(hoverText(md('<cancel_cue cue="md.Setup.Rew|ard"/>'))).toContain('Purpose `run_actions` · Parameters: `Amount`');
    expect(hoverText(md('<cancel_cue cue="md.Setup.Add|ed"/>'))).toContain('Added by the patch setup.xml of `my_mod`, line 5');
    expect(hoverText(md('<cancel_cue cue="md.Setup.Nowh|ere"/>'))).toContain('Script Setup has no cue Nowhere');
    expect(hoverText(md('<cancel_cue cue="md.Nob|ody.Start"/>'))).toContain('No Mission Director script of this name is known');
    // `md.$x` is a variable of the md table, not a script.
    expect(hoverText(md('<set_value name="$x" exact="md.$glo|bal"/>'))).toContain('variable of `md`');
  });

  it('goes to the script and the cue', () => {
    expect(definitions(md('<cancel_cue cue="md.Set|up.Start"/>'))).toEqual(['setup.xml:3']);
    expect(definitions(md('<cancel_cue cue="md.Setup.St|art"/>'))).toEqual(['setup.xml:5']);
    expect(definitions(md('<cancel_cue cue="md.Setup.Nowh|ere"/>'))).toEqual([]);
  });

  it('completes script names after md. and cue names after md.Script.', () => {
    expect(labels(md('<cancel_cue cue="md.|"/>'))).toEqual(['Mine', 'Setup']);
    expect(labels(md('<cancel_cue cue="md.Se|"/>'))).toEqual(['Setup']);
    expect(labels(md('<cancel_cue cue="md.Setup.|"/>'))).toEqual(['Added', 'Inner', 'Reward', 'Start']);
    expect(labels(md('<cancel_cue cue="md.Setup.|\n'))).toEqual(['Added', 'Inner', 'Reward', 'Start']);
    expect(labels(md('<cancel_cue cue="md.Nobody.|"/>'))).toEqual([]);
  });
});

describe('variables set in other scripts', () => {
  const uses = (read: string): string =>
    ai('<handler ref="TargetInvalidHandler"/>', `<include_interrupt_actions ref="CheckTarget"/>\n      <set_value name="$r" exact="${read}"/>`);

  it('shows, opens and completes what an interrupt library item sets', () => {
    const text = hoverText(uses('$check|ed'));
    expect(text).toContain('Set in another file');
    expect(text).toContain('Set by interrupt actions CheckTarget in lib.target.xml, line 7');
    expect(definitions(uses('$check|ed'))).toEqual(['lib.target.xml:7']);
    expect(labels(uses('$|'))).toEqual(['$checked', '$invalid', '$r']);
  });

  it('shows, opens and completes the variables of a cue in another script', () => {
    expect(labels(md('<set_value name="$x" exact="md.Setup.Start.$|"/>'))).toEqual(['$started']);
    expect(hoverText(md('<set_value name="$x" exact="md.Setup.Start.$star|ted"/>'))).toContain('Set by cue Start of Setup in setup.xml, line 7');
    expect(definitions(md('<set_value name="$x" exact="md.Setup.Start.$star|ted"/>'))).toEqual(['setup.xml:7']);
    expect(hoverText(md('<set_value name="$x" exact="md.Setup.Start.$miss|ing"/>'))).toContain('Never set here');
  });
});

describe('inline code in hovers', () => {
  it('keeps names as they are, underscores and backticks included', () => {
    expect(inlineCode('run_actions')).toBe('`run_actions`');
    expect(inlineCode('a`b')).toBe('``a`b``');
    expect(inlineCode('`x')).toBe('`` `x ``');
  });
});

describe('interrupt library items of other scripts', () => {
  it('describes and goes to them', () => {
    const handler = hoverText(ai('<handler ref="TargetInv|alidHandler"/>'));
    expect(handler).toContain('**TargetInvalidHandler** *(interrupt handler)*');
    expect(handler).toContain('Defined in another script');
    expect(handler).toContain('In lib.target.xml of `game`, line 9 (script `lib.target`)');
    expect(definitions(ai('<handler ref="TargetInv|alidHandler"/>'))).toEqual(['lib.target.xml:9']);
    expect(hoverText(ai('<handler ref="Miss|ing"/>'))).toContain('Not defined in any known script');
  });

  it('completes the names other scripts define', () => {
    expect(labels(ai('<handler ref="|"/>'))).toEqual(['TargetInvalidHandler']);
    expect(labels(ai('', '<include_interrupt_actions ref="|"/>'))).toEqual(['CheckTarget']);
    expect(labels(ai('<library><actions name="Local"/></library>', '<include_interrupt_actions ref="|"/>'))).toEqual(['CheckTarget', 'Local']);
  });
});
