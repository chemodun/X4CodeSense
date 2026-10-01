import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CodeAction } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  fixAll,
  loadGameData,
  loadScriptIndex,
  quickFixes,
  spellingSuggestions,
  type AnalysisContext,
  type DocumentAnalysis,
  type GameData,
} from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const patchFixtures = fileURLToPath(new URL('./fixtures/patches', import.meta.url));
const base = loadGameData(unpacked);
const game: GameData = { ...base, index: loadScriptIndex(path.join(project, 'game'), [path.join(project, 'mods')], base.schemas) };
const context: AnalysisContext = { schemas: game.schemas, properties: game.properties, index: game.index };

const md = (body: string, cues = ''): string =>
  `<mdscript name="S">\n  <cues>\n    <cue name="Start">\n      <actions>\n        ${body}\n      </actions>\n    </cue>${cues}\n  </cues>\n</mdscript>\n`;
const ai = (interrupts: string, actions: string): string =>
  `<aiscript name="a">\n  <interrupts>\n    ${interrupts}\n  </interrupts>\n  <attention min="1">\n    <actions>\n      <label name="start" />\n      ${actions}\n    </actions>\n  </attention>\n</aiscript>\n`;

const analyze = (text: string, uri?: string, withContext: AnalysisContext = context): DocumentAnalysis => analyzeText(text, withContext, uri);

/** The fixes for the diagnostics of the code, as `title` with ` *` when preferred. */
function fixes(analysis: DocumentAnalysis, code: string, data: GameData = game): string[] {
  const diagnostics = analysis.diagnostics.filter((diagnostic) => diagnostic.code === code);
  return quickFixes(analysis, diagnostics, data).map((action) => `${action.title}${action.isPreferred ? ' *' : ''}`);
}

function apply(analysis: DocumentAnalysis, action: CodeAction): string {
  return TextDocument.applyEdits(analysis.document, action.edit?.changes?.[analysis.document.uri] ?? []);
}

/** The text after the fix with the title for the diagnostics of the code. */
function fixed(analysis: DocumentAnalysis, code: string, title: string, data: GameData = game): string {
  const diagnostics = analysis.diagnostics.filter((diagnostic) => diagnostic.code === code);
  const action = quickFixes(analysis, diagnostics, data).find((candidate) => candidate.title === title);
  expect(action, `no fix '${title}' for ${code}`).toBeDefined();
  return apply(analysis, action as CodeAction);
}

/** The line of the text that holds the needle. */
const lineWith = (text: string, needle: string): string | undefined =>
  text
    .split('\n')
    .find((line) => line.includes(needle))
    ?.trim();

describe('spelling suggestions', () => {
  const names = (written: string, known: string[]): string[] => spellingSuggestions(written, known).map((suggestion) => suggestion.name);

  it('finds a name back from one slip of the fingers', () => {
    expect(names('set_valeu', ['set_value', 'remove_value', 'debug_text'])).toEqual(['set_value']);
    expect(names('nmae', ['name', 'exact', 'operation'])).toEqual(['name']);
    expect(names('genral', ['error', 'general'])).toEqual(['general']);
    expect(names('$cuont', ['$count', '$amount'])).toEqual(['$count']);
    expect(names('shp', ['ship', 'entity', 'money'])).toEqual(['ship']);
  });

  it('puts a change of case first', () => {
    expect(spellingSuggestions('$ship', ['$Ship', '$shop', '$chip'])).toEqual([
      { name: '$Ship', distance: 0.1 },
      { name: '$chip', distance: 1.5 },
      { name: '$shop', distance: 1.5 },
    ]);
    expect(names('$feedbackvalue', ['$FeedbackValue', '$EndFeedbackValue'])).toEqual(['$FeedbackValue']);
  });

  it('offers nothing far off, and nothing for two letters but their case', () => {
    expect(names('$Actor', ['$Sector'])).toEqual([]);
    expect(names('entity', ['entry'])).toEqual([]);
    expect(names('ce', ['cue'])).toEqual([]);
    expect(names('Ce', ['ce'])).toEqual(['ce']);
  });

  it('offers at most three, closest first, and never the written name', () => {
    expect(names('$PatrolPosition', ['$PatrolPosition4', '$PatrolPosition1', '$PatrolPosition3', '$PatrolPosition2', '$PatrolPosition'])).toEqual([
      '$PatrolPosition1',
      '$PatrolPosition2',
      '$PatrolPosition3',
    ]);
  });
});

describe('quick fixes for well-formedness', () => {
  it('puts an unquoted value in quotes', () => {
    const analysis = analyze(md('<debug_text text="1" filter=general />'));
    expect(fixes(analysis, 'unquoted-attribute-value')).toEqual(['Put the value in quotes *']);
    expect(lineWith(fixed(analysis, 'unquoted-attribute-value', 'Put the value in quotes'), 'debug_text')).toBe('<debug_text text="1" filter="general" />');
  });

  it('gives an attribute without a value an empty one', () => {
    const bare = analyze(md('<debug_text text="1" chance />'));
    expect(fixes(bare, 'missing-attribute-value')).toEqual(["Give 'chance' an empty value *"]);
    expect(lineWith(fixed(bare, 'missing-attribute-value', "Give 'chance' an empty value"), 'debug_text')).toBe('<debug_text text="1" chance="" />');
    // After `=` with the next attribute behind it, the value goes right after the `=`.
    const equals = analyze(md('<debug_text chance= text="1" />'));
    expect(lineWith(fixed(equals, 'missing-attribute-value', "Give 'chance' an empty value"), 'debug_text')).toBe('<debug_text chance="" text="1" />');
  });

  it('removes a repeated attribute', () => {
    const analysis = analyze(md('<debug_text text="1" filter="error" filter="general" />'));
    expect(fixes(analysis, 'duplicate-attribute')).toEqual(["Remove the repeated attribute 'filter'"]);
    expect(lineWith(fixed(analysis, 'duplicate-attribute', "Remove the repeated attribute 'filter'"), 'debug_text')).toBe(
      '<debug_text text="1" filter="error" />'
    );
  });
});

describe('quick fixes for the schema', () => {
  it('adds the required attributes an element lacks, in one action for all', () => {
    const analysis = analyze(md('<run_actions ref="md.Setup.Reward">\n          <param />\n        </run_actions>'));
    const diagnostics = analysis.diagnostics.filter((diagnostic) => diagnostic.code === 'missing-required-attribute');
    expect(diagnostics).toHaveLength(2);
    const actions = quickFixes(analysis, diagnostics, game);
    expect(actions.map((action) => action.title)).toEqual(["Add the required attributes 'name' and 'value'"]);
    expect(actions[0].diagnostics).toHaveLength(2);
    expect(lineWith(apply(analysis, actions[0]), '<param')).toBe('<param name="" value="" />');
    // After the last attribute when there are some.
    const one = analyze(md('<debug_text filter="error" />'));
    expect(lineWith(fixed(one, 'missing-required-attribute', "Add the required attribute 'text'"), 'debug_text')).toBe('<debug_text filter="error" text="" />');
  });

  it('changes an unknown element to the closest allowed one, end tag and all', () => {
    const analysis = analyze(md('<set_valeu name="$x" exact="1"></set_valeu>'));
    expect(fixes(analysis, 'unknown-element')).toEqual(["Change to 'set_value' *"]);
    expect(lineWith(fixed(analysis, 'unknown-element', "Change to 'set_value'"), '$x')).toBe('<set_value name="$x" exact="1"></set_value>');
  });

  it('changes an unknown attribute and an invalid value of an enumeration', () => {
    const attribute = analyze(md('<set_value nmae="$x" exact="1" />'));
    expect(fixes(attribute, 'unknown-attribute')).toEqual(["Change to 'name' *"]);
    expect(lineWith(fixed(attribute, 'unknown-attribute', "Change to 'name'"), 'set_value')).toBe('<set_value name="$x" exact="1" />');
    const value = analyze(md('', '\n    <cue name="Other" namespace="statc" />'));
    expect(fixes(value, 'invalid-attribute-value')).toEqual(["Change to 'static' *"]);
    expect(lineWith(fixed(value, 'invalid-attribute-value', "Change to 'static'"), 'Other')).toBe('<cue name="Other" namespace="static" />');
  });
});

describe('quick fixes for names', () => {
  it('changes keywords, properties and variables in expressions', () => {
    const analysis = analyze(md('<set_value name="$count" exact="1" />\n        <debug_text text="plyer.ship.name + player.shp + $cuont" />'));
    expect(fixes(analysis, 'cue-undefined')).toEqual(["Change to 'player' *"]);
    expect(fixes(analysis, 'expression-unknown-property')).toEqual(["Change to 'ship' *"]);
    expect(fixes(analysis, 'variable-undefined')).toEqual(["Change to '$count' *"]);
    expect(lineWith(fixed(analysis, 'variable-undefined', "Change to '$count'"), 'debug_text')).toBe(
      '<debug_text text="plyer.ship.name + player.shp + $count" />'
    );
    const aiScript = analyze(ai('', '<debug_text text="thsi.name" />'));
    expect(fixes(aiScript, 'expression-unknown-keyword')).toEqual(["Change to 'this' *"]);
  });

  it('offers only variables that are set', () => {
    const read = analyze(md('<debug_text text="$count" />\n        <debug_text text="$count + $cuont" />'));
    expect(read.diagnostics.filter((diagnostic) => diagnostic.code === 'variable-undefined')).toHaveLength(3);
    expect(fixes(read, 'variable-undefined')).toEqual([]);
  });

  it('changes cue names, in the script and through md.Script.Cue', () => {
    const analysis = analyze(
      md('<signal_cue_instantly cue="Strat" />\n        <signal_cue_instantly cue="md.Setpu.Inner" />\n        <signal_cue_instantly cue="md.Setup.Iner" />')
    );
    expect(fixes(analysis, 'cue-undefined')).toEqual(["Change to 'Start' *", "Change to 'Setup' *", "Change to 'Inner' *"]);
    expect(lineWith(fixed(analysis, 'cue-undefined', "Change to 'Setup'"), 'Setup.Inner')).toBe('<signal_cue_instantly cue="md.Setup.Inner" />');
  });

  it('offers a script for md.Script, not the property check of md', () => {
    // `md.Setpu.$x`: the property check reports the step; a script name would not answer it.
    const analysis = analyze(md('<debug_text text="md.Setpu.$x" />'));
    expect(fixes(analysis, 'expression-unknown-property')).toEqual([]);
  });

  it('changes labels and interrupt library items', () => {
    const analysis = analyze(ai('<handler ref="TargetInvaldHandler" />', '<include_interrupt_actions ref="CheckTargte" />\n      <resume label="strat" />'));
    expect(fixes(analysis, 'label-undefined')).toEqual(["Change to 'start' *"]);
    expect(fixes(analysis, 'library-undefined')).toEqual(["Change to 'TargetInvalidHandler' *", "Change to 'CheckTarget' *"]);
  });

  it('offers equally close names without preferring one', () => {
    const analysis = analyze(md('<signal_cue_instantly cue="Ch_Force" />', '\n    <cue name="Ch1_Force" />\n    <cue name="Ch2_Force" />'));
    expect(fixes(analysis, 'cue-undefined')).toEqual(["Change to 'Ch1_Force'", "Change to 'Ch2_Force'"]);
  });
});

describe('quick fixes in patch documents', () => {
  const gameFolder = path.join(patchFixtures, 'game');
  const mods = path.join(patchFixtures, 'mods');
  const index = loadScriptIndex(gameFolder, [mods], base.schemas);
  const data: GameData = { ...base, index, folder: gameFolder };
  const patchContext: AnalysisContext = { schemas: base.schemas, properties: base.properties, index };
  const file = path.join(mods, 'late_mod', 'md', 'setup.xml');
  const uri = pathToFileURL(file).toString();
  const text = readFileSync(file, 'utf8')
    .replace('<set_value name="$b" exact="2" />', '<set_valeu name="$b" exact="2" />')
    .replace('<set_value name="$a" exact="1" />', '<set_value nmae="$a" exact="1" />');

  it('fixes what the patch brings in as it is where it lands', () => {
    const analysis = analyze(text, uri, patchContext);
    expect(fixes(analysis, 'unknown-element', data)).toEqual(["Change to 'set_value' *"]);
    expect(fixes(analysis, 'unknown-attribute', data)).toEqual(["Change to 'name' *"]);
    expect(fixes(analysis, 'missing-required-attribute', data)).toEqual(["Add the required attribute 'name' *"]);
    const after = fixed(analysis, 'unknown-element', "Change to 'set_value'", data);
    expect(lineWith(after, '$b')).toBe('<set_value name="$b" exact="2" />');
    const again = analyze(after, uri, patchContext);
    expect(again.diagnostics.filter((diagnostic) => diagnostic.code === 'unknown-element')).toEqual([]);
  });
});

describe('fix all', () => {
  it('applies every preferred fix of the document at once, without those that only insert an empty value', () => {
    const analysis = analyze(
      md(
        '<set_valeu name="$x" exact="1"></set_valeu>\n        <debug_text text="plyer.ship.name" filter=general chance />',
        '\n    <cue name="Other" namespace="statc" />'
      )
    );
    const all = fixAll(analysis, game);
    expect(all?.title).toBe('Apply all preferred fixes in this file (4)');
    expect(all?.kind).toBe('source.fixAll');
    expect(all?.diagnostics?.map((diagnostic) => diagnostic.code).sort()).toEqual([
      'cue-undefined',
      'invalid-attribute-value',
      'unknown-element',
      'unquoted-attribute-value',
    ]);
    const text = apply(analysis, all as CodeAction);
    expect(lineWith(text, '$x')).toBe('<set_value name="$x" exact="1"></set_value>');
    // `chance` keeps no value: an empty one is still to be written.
    expect(lineWith(text, 'debug_text')).toBe('<debug_text text="player.ship.name" filter="general" chance />');
    expect(lineWith(text, 'Other')).toBe('<cue name="Other" namespace="static" />');
  });

  it('leaves out fixes that are not preferred, and has nothing to do without preferred fixes', () => {
    const analysis = analyze(md('<debug_text text="1" filter="error" filter="general" chance />'));
    expect(fixes(analysis, 'duplicate-attribute')).toEqual(["Remove the repeated attribute 'filter'"]);
    expect(fixes(analysis, 'missing-attribute-value')).toEqual(["Give 'chance' an empty value *"]);
    expect(fixAll(analysis, game)).toBeUndefined();
  });

  it('gives edits that apply together on every cut of a document', () => {
    const text = md(
      '<set_value name="$count" exact="1" />\n        <set_valeu nmae="$x" exact="plyer.shp + $cuont" filter=general></set_valeu>\n        <debug_text text="1" filter=error filter="error" chance />',
      '\n    <cue name="Other" namespace="statc" />'
    );
    let fixesApplied = 0;
    for (let cut = 0; cut <= text.length; cut += 7) {
      const analysis = analyze(text.slice(0, cut));
      const all = fixAll(analysis, game);
      if (all) {
        fixesApplied++;
        expect(() => apply(analysis, all)).not.toThrow();
      }
    }
    expect(fixesApplied).toBeGreaterThan(20);
  });
});

describe('which diagnostics get fixes', () => {
  it('passes over diagnostics of other tools and those the analysis no longer has', () => {
    const analysis = analyze(md('<set_valeu name="$x" exact="1" />'));
    const [diagnostic] = analysis.diagnostics.filter((candidate) => candidate.code === 'unknown-element');
    expect(quickFixes(analysis, [diagnostic], game)).toHaveLength(1);
    expect(quickFixes(analysis, [{ ...diagnostic, source: 'xml' }], game)).toEqual([]);
    expect(quickFixes(analysis, [{ ...diagnostic, message: 'an older message' }], game)).toEqual([]);
    expect(quickFixes(analysis, [{ ...diagnostic, range: { start: diagnostic.range.start, end: { line: 0, character: 0 } } }], game)).toEqual([]);
  });

  it('offers none for a diagnostic without an obvious fix', () => {
    const analysis = analyze(md('<set_value name="$x" exact="1 +" />\n        <include_actions ref="md.Setup.Nothing_Close_To_It" />'));
    expect(analysis.diagnostics.length).toBeGreaterThan(1);
    expect(quickFixes(analysis, analysis.diagnostics, game)).toEqual([]);
  });

  it('works without game data', () => {
    const analysis = analyze(md('<debug_text text="1" filter=general />'), undefined, {});
    expect(fixes(analysis, 'unquoted-attribute-value', undefined as unknown as GameData)).toEqual(['Put the value in quotes *']);
  });
});

describe('while typing', () => {
  it('fixes a name in a start tag that is not closed yet', () => {
    const analysis = analyze(md('<set_valeu name="$x"\n        <debug_text text="1" />'));
    expect(fixes(analysis, 'unknown-element')).toEqual(["Change to 'set_value' *"]);
    expect(lineWith(fixed(analysis, 'unknown-element', "Change to 'set_value'"), '$x')).toBe('<set_value name="$x"');
  });

  it('fixes a name in a value whose quote is not closed yet', () => {
    const property = analyze(md('<debug_text text="player.shp\n        <debug_text text="1" />'));
    expect(fixes(property, 'expression-unknown-property')).toEqual(["Change to 'ship' *"]);
    const label = analyze(ai('', '<resume label="strat\n      <label name="other" />'));
    expect(fixes(label, 'label-undefined')).toEqual(["Change to 'start' *"]);
  });

  it('offers sound fixes for every diagnostic of every cut of the documents', () => {
    const documents = [
      md(
        '<set_value name="$count" exact="1" />\n        <set_valeu nmae="$x" exact="plyer.shp + $cuont" filter=general></set_valeu>\n        <debug_text text="1" filter="error" filter="error" chance />',
        '\n    <cue name="Other" namespace="statc" />'
      ),
      ai(
        '<handler ref="TargetInvaldHandler" />',
        '<include_interrupt_actions ref="CheckTargte" />\n      <resume label="strat" />\n      <debug_text text="thsi.name" />'
      ),
    ];
    let offered = 0;
    for (const text of documents) {
      for (let cut = 0; cut <= text.length; cut += 7) {
        const analysis = analyze(text.slice(0, cut));
        for (const action of quickFixes(analysis, analysis.diagnostics, game)) {
          offered++;
          const edits = action.edit?.changes?.[analysis.document.uri] ?? [];
          expect(edits.length).toBeGreaterThan(0);
          for (const edit of edits) {
            const start = analysis.document.offsetAt(edit.range.start);
            const end = analysis.document.offsetAt(edit.range.end);
            expect(start).toBeLessThanOrEqual(end);
            expect(end).toBeLessThanOrEqual(cut);
          }
          // The edits of one action never overlap.
          expect(() => apply(analysis, action)).not.toThrow();
          // A changed name replaces exactly what a diagnostic of the action covers.
          if (action.title.startsWith('Change to')) {
            const covered = action.diagnostics?.map((diagnostic) => analysis.document.getText(diagnostic.range)) ?? [];
            expect(covered).toContain(analysis.document.getText(edits[0].range));
          }
        }
      }
    }
    expect(offered).toBeGreaterThan(100);
  });
});
