import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Location } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  loadGameData,
  loadScriptIndex,
  referenceLensRanges,
  referenceLenses,
  referenceLensTitle,
  referencesAt,
  referencesAtEach,
  type DocumentAnalysis,
  type GameData,
} from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const base = loadGameData(unpacked);
const game: GameData = { ...base, index: loadScriptIndex(path.join(project, 'game'), [path.join(project, 'mods')], base.schemas) };

function analyzeFile(file: string, text = readFileSync(file, 'utf8')): DocumentAnalysis {
  return analyzeText(text, { schemas: game.schemas, properties: game.properties, index: game.index }, pathToFileURL(file).toString());
}

function analyzeLoose(text: string): DocumentAnalysis {
  return analyzeText(text, { schemas: game.schemas, properties: game.properties });
}

const place = (location: Location): string =>
  `${path.relative(project, fileURLToPath(location.uri)).replaceAll('\\', '/')}:${location.range.start.line + 1}:${location.range.start.character + 1}`;

/** Each lens as `name line: references`, the references as `file:line:column` or, in a loose text, `line:column`. */
function lenses(analysis: DocumentAnalysis, data?: GameData): string[] | undefined {
  const text = analysis.document.getText();
  return referenceLenses(analysis, data)?.map((lens) => {
    const name = text.slice(analysis.document.offsetAt(lens.range.start), analysis.document.offsetAt(lens.range.end));
    const references = lens.references.map((location) =>
      location.uri.startsWith('file:') ? place(location) : `${location.range.start.line + 1}:${location.range.start.character + 1}`
    );
    return `${name} ${lens.range.start.line + 1}: ${references.join(', ')}`.trimEnd();
  });
}

describe('code lens with reference counts', () => {
  it('counts the references of a cue and a library in the script, its definition left out', () => {
    const text = `<mdscript name="Lens">
  <cues>
    <cue name="Start">
      <actions>
        <signal_cue_instantly cue="Later"/>
        <include_actions ref="Reward"/>
        <cancel_cue cue="Later"/>
      </actions>
    </cue>
    <cue name="Later"/>
    <library name="Reward"/>
    <cue name="Alone"/>
  </cues>
</mdscript>
`;
    expect(lenses(analyzeLoose(text))).toEqual(['Start 3:', 'Later 10: 5:36, 7:26', 'Reward 11: 6:31', 'Alone 12:']);
  });

  it('counts the references in other files and in the paths of patches', () => {
    const setup = path.join(project, 'game', 'md', 'setup.xml');
    expect(lenses(analyzeFile(setup), game)).toEqual([
      'Start 5: mods/my_mod/md/mine.xml:7:45, mods/my_mod/md/setup.xml:4:39, mods/my_mod/md/setup.xml:7:42',
      'Inner 10: mods/my_mod/md/setup.xml:7:66',
      'Reward 13:',
    ]);
  });

  it('counts the references of interrupt library items in other AI scripts, and of labels', () => {
    const library = path.join(project, 'game', 'aiscripts', 'lib.target.xml');
    expect(lenses(analyzeFile(library), game)).toEqual([
      'CheckTarget 6: mods/my_mod/aiscripts/order.mine.xml:12:39',
      'TargetInvalidHandler 9: mods/my_mod/aiscripts/order.mine.xml:8:19',
      'TargetConditions 14:',
    ]);
    const labels = `<aiscript name="labels">
  <attention min="unknown">
    <actions>
      <label name="start"/>
      <wait exact="1s"/>
      <resume label="start"/>
      <label name="unused"/>
    </actions>
  </attention>
</aiscript>
`;
    expect(lenses(analyzeLoose(labels))).toEqual(['start 4: 6:22', 'unused 7:']);
  });

  it('puts the lenses of a patch over what it brings in, at their names in the patch', () => {
    const patch = path.join(project, 'mods', 'my_mod', 'md', 'setup.xml');
    expect(lenses(analyzeFile(patch), game)).toEqual(['Added 5: mods/my_mod/md/mine.xml:8:45']);
  });

  it('gives no lenses to other XML', () => {
    expect(referenceLensRanges(analyzeLoose('<language id="44"><page id="1"/></language>'))).toBeUndefined();
  });

  it('keeps the lenses while typing: a cue left open, a value not closed', () => {
    const open = `<mdscript name="Typing">
  <cues>
    <cue name="Start">
      <actions>
        <signal_cue_instantly cue="Half"/>
      </actions>
    </cue>
    <cue name="Half">
      <actions>
        <cancel_cue cue="Start
`;
    // The value being typed already names Start.
    expect(lenses(analyzeLoose(open))).toEqual(['Start 3: 10:26', 'Half 8: 5:36']);
    const cutInName = `<mdscript name="Typing">
  <cues>
    <cue name="Start"/>
    <cue name="Sta`;
    expect(lenses(analyzeLoose(cutInName))).toEqual(['Start 3:', 'Sta 4:']);
  });

  it('finds the same references for many names at once as for each alone', () => {
    const setup = analyzeFile(path.join(project, 'game', 'md', 'setup.xml'));
    const offsets = (referenceLensRanges(setup) ?? []).map((range) => setup.document.offsetAt(range.start));
    expect(offsets).toHaveLength(3);
    expect(referencesAtEach(setup, offsets, game)).toEqual(offsets.map((offset) => referencesAt(setup, offset, game)));
  });

  it('titles a lens by its count', () => {
    expect([0, 1, 2].map(referenceLensTitle)).toEqual(['0 references', '1 reference', '2 references']);
  });
});
