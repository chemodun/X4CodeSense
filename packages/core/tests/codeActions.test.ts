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

describe('quick fixes for tags and children', () => {
  const script = (cues: string): string => `<mdscript name="S">\n  <cues>\n${cues}\n  </cues>\n</mdscript>\n`;
  const problems = (text: string): string[] => analyze(text).diagnostics.map((diagnostic) => String(diagnostic.code));

  it('closes a value where the scanner took it to end, preferred', () => {
    const analysis = analyze(md('<set_value name="$x exact="1"/>'));
    expect(fixes(analysis, 'unclosed-attribute')).toEqual(["Close the value of 'name' *"]);
    const after = fixed(analysis, 'unclosed-attribute', "Close the value of 'name'");
    expect(lineWith(after, '$x')).toBe('<set_value name="$x" exact="1"/>');
    expect(problems(after)).toEqual([]);
  });

  it('closes a start tag cut off as the empty element it is taken for, its value too', () => {
    const text = script('    <cue name="A"\n    <cue name="B"/>');
    expect(fixes(analyze(text), 'unclosed-start-tag')).toEqual(["Close the start tag with '/>'"]);
    expect(lineWith(fixed(analyze(text), 'unclosed-start-tag', "Close the start tag with '/>'"), '"A"')).toBe('<cue name="A"/>');
    const cut = script('    <cue name="A\n    <cue name="B"/>');
    const after = fixed(analyze(cut), 'unclosed-start-tag', "Close the start tag with '/>'");
    expect(lineWith(after, '"A')).toBe('<cue name="A"/>');
    expect(problems(after)).toEqual([]);
  });

  it('adds an end tag where the element was taken to end, after its content', () => {
    const text = script('    <cue name="A">\n      <actions/>');
    expect(fixes(analyze(text), 'missing-end-tag')).toEqual(['Add the end tag </cue>']);
    const after = fixed(analyze(text), 'missing-end-tag', 'Add the end tag </cue>');
    expect(after).toBe(script('    <cue name="A">\n      <actions/>\n    </cue>'));
    expect(problems(after)).toEqual([]);
  });

  it('changes an end tag to the element left open when the names are close, else removes it', () => {
    const typo = analyze(script('    <cue name="A">\n      <actions/>\n    </cuee>'));
    expect(fixes(typo, 'unexpected-end-tag')).toEqual(['Change the end tag to </cue> *', 'Remove the end tag </cuee>']);
    expect(problems(fixed(typo, 'unexpected-end-tag', 'Change the end tag to </cue>'))).toEqual([]);
    const stray = analyze(script('    <cue name="A"/>\n    </stray>'));
    expect(fixes(stray, 'unexpected-end-tag')).toEqual(['Remove the end tag </stray>']);
    expect(fixed(stray, 'unexpected-end-tag', 'Remove the end tag </stray>')).toBe(script('    <cue name="A"/>'));
  });

  it('adds a required child, to be filled in, when few may stand there', () => {
    const analysis = analyze('<mdscript name="S"/>\n');
    expect(fixes(analysis, 'missing-child-element')).toEqual(['Add the required child <cues> *']);
    const after = fixed(analysis, 'missing-child-element', 'Add the required child <cues>');
    expect(after).toBe('<mdscript name="S">\n  <cues/>\n</mdscript>\n');
    expect(problems(after)).toEqual([]);
    // It only moves the problem into what it adds: fix all leaves it to the author.
    expect(fixAll(analysis, game)).toBeUndefined();
  });

  it('moves a child before the sibling it must precede', () => {
    const text = script(
      '    <cue name="A">\n      <actions>\n        <debug_text text="1"/>\n      </actions>\n      <conditions>\n        <check_value value="true"/>\n      </conditions>\n    </cue>'
    );
    expect(fixes(analyze(text), 'invalid-child-element')).toEqual(['Move <conditions> before <actions>']);
    const after = fixed(analyze(text), 'invalid-child-element', 'Move <conditions> before <actions>');
    expect(after).toBe(
      script(
        '    <cue name="A">\n      <conditions>\n        <check_value value="true"/>\n      </conditions>\n      <actions>\n        <debug_text text="1"/>\n      </actions>\n    </cue>'
      )
    );
    expect(problems(after)).toEqual([]);
    // Not on a line of its own: left where it is.
    expect(fixes(analyze(script('    <cue name="A"><actions/><conditions/></cue>')), 'invalid-child-element')).toEqual([]);
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

  it('changes a property a variable of known type lacks, on its own only where the type is not guessed', () => {
    const analysis = analyze(
      md('<set_value name="$s" exact="player.ship" />\n        <create_ship name="$c" macro="m" />\n        <debug_text text="$s.pilto + $c.pilto" />')
    );
    expect(fixes(analysis, 'expression-unknown-property')).toEqual(["Change to 'pilot' *"]);
    expect(fixes(analysis, 'expression-unknown-property-guessed')).toEqual(["Change to 'pilot'"]);
    expect(fixAll(analysis, game)?.title).toBe('Apply all preferred fixes in this file (1)');
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

  it('offers equally close names without preferring one, and to create the name since none is clearly meant', () => {
    const analysis = analyze(md('<signal_cue_instantly cue="Ch_Force" />', '\n    <cue name="Ch1_Force" />\n    <cue name="Ch2_Force" />'));
    expect(fixes(analysis, 'cue-undefined')).toEqual(["Change to 'Ch1_Force'", "Change to 'Ch2_Force'", "Create cue 'Ch_Force'"]);
  });
});

describe('quick fixes that create what is missing', () => {
  const setupFile = path.join(project, 'game', 'md', 'setup.xml');
  const setupUri = pathToFileURL(setupFile).toString();
  const setupText = readFileSync(setupFile, 'utf8');

  /** The text of Setup after the fix with the title, which changes only that file. */
  function setupAfter(analysis: DocumentAnalysis, title: string, data: GameData = game): string {
    const action = quickFixes(analysis, analysis.diagnostics, data).find((candidate) => candidate.title === title);
    expect(Object.keys(action?.edit?.changes ?? {})).toEqual([setupUri]);
    return TextDocument.applyEdits(TextDocument.create(setupUri, 'xml', 0, setupText), action?.edit?.changes?.[setupUri] ?? []);
  }

  it('creates a cue after the cue that names it, waiting for the signal where it is signalled', () => {
    const text = md('<signal_cue_instantly cue="Later" />\n        <cancel_cue cue="Other" />');
    const analysis = analyze(text);
    expect(fixes(analysis, 'cue-undefined')).toEqual(["Create cue 'Later'", "Create cue 'Other'"]);
    const later = fixed(analysis, 'cue-undefined', "Create cue 'Later'");
    expect(later).toBe(
      text.replace(
        '    </cue>\n',
        '    </cue>\n    <cue name="Later">\n      <conditions>\n        <event_cue_signalled/>\n      </conditions>\n      <actions>\n      </actions>\n    </cue>\n'
      )
    );
    expect(analyze(later).diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["'Other' is no keyword and no cue of this script"]);
    const other = fixed(analysis, 'cue-undefined', "Create cue 'Other'");
    expect(other).toContain('    </cue>\n    <cue name="Other">\n      <actions>\n      </actions>\n    </cue>\n');
  });

  it('creates a library where actions are included from it or run, with the parameters the call passes', () => {
    const analysis = analyze(
      md('<include_actions ref="Shared" />\n        <run_actions ref="Payout">\n          <param name="Amount" value="1" />\n        </run_actions>')
    );
    expect(fixes(analysis, 'cue-undefined')).toEqual(["Create library 'Shared'", "Create library 'Payout'"]);
    expect(fixed(analysis, 'cue-undefined', "Create library 'Shared'")).toContain(
      '    </cue>\n    <library name="Shared">\n      <actions>\n      </actions>\n    </library>\n'
    );
    const payout = fixed(analysis, 'cue-undefined', "Create library 'Payout'");
    expect(payout).toContain(
      '    </cue>\n    <library name="Payout">\n      <params>\n        <param name="Amount"/>\n      </params>\n      <actions>\n      </actions>\n    </library>\n'
    );
    expect(analyze(payout).diagnostics.filter((diagnostic) => diagnostic.message.includes('Payout'))).toEqual([]);
  });

  it('creates a cue of another script last in its cues, and never in a file of the game', () => {
    const analysis = analyze(md('<signal_cue_instantly cue="md.Setup.Later" />\n        <cancel_cue cue="md.Setup.Gone" />'));
    expect(fixes(analysis, 'cue-undefined')).toEqual(["Create cue 'Later' in script 'Setup'", "Create cue 'Gone' in script 'Setup'"]);
    expect(setupAfter(analysis, "Create cue 'Later' in script 'Setup'")).toBe(
      setupText.replace(
        '    </library>\n',
        '    </library>\n    <cue name="Later">\n      <conditions>\n        <event_cue_signalled/>\n      </conditions>\n      <actions>\n      </actions>\n    </cue>\n'
      )
    );
    // The edit does not change this document, so the checker leaves it out.
    expect(fixed(analysis, 'cue-undefined', "Create cue 'Gone' in script 'Setup'")).toBe(analysis.document.getText());
    expect(fixes(analysis, 'cue-undefined', { ...game, folder: path.join(project, 'game') })).toEqual([]);
  });

  it('creates a label first in the actions of the attention block that resumes at it', () => {
    const analysis = analyze(ai('', '<resume label="later" />'));
    expect(fixes(analysis, 'label-undefined')).toEqual(["Create label 'later' at the start of the actions"]);
    const created = fixed(analysis, 'label-undefined', "Create label 'later' at the start of the actions");
    expect(created).toContain('    <actions>\n      <label name="later"/>\n      <label name="start" />\n');
    expect(analyze(created).diagnostics).toEqual([]);
  });

  it('writes with the line breaks and indentation of the file', () => {
    const text = md('<signal_cue_instantly cue="Later" />').replace(/\n/g, '\r\n').replace(/ {2}/g, '\t');
    const created = fixed(analyze(text), 'cue-undefined', "Create cue 'Later'");
    expect(created).toContain('\t\t</cue>\r\n\t\t<cue name="Later">\r\n\t\t\t<conditions>\r\n\t\t\t\t<event_cue_signalled/>\r\n');
    expect(created.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('creates nothing in a patch, and nothing next to an element that is not whole yet', () => {
    const patch = analyze(
      '<diff>\n  <add sel="/mdscript/cues">\n    <cue name="X">\n      <actions>\n        <signal_cue_instantly cue="Later" />\n      </actions>\n    </cue>\n  </add>\n</diff>\n'
    );
    expect(quickFixes(patch, patch.diagnostics, game).filter((action) => action.title.startsWith('Create'))).toEqual([]);
    // While typing: whatever is created is whole, so the text has no new problem, and the cue being typed gets nothing.
    const text = md('<signal_cue_instantly cue="Later" />\n        <include_actions ref="Shared" />', '\n    <cue name="Third">\n      <actions/>\n    </cue>');
    let created = 0;
    for (let cut = 0; cut <= text.length; cut += 5) {
      const analysis = analyze(text.slice(0, cut));
      for (const action of quickFixes(analysis, analysis.diagnostics, game).filter((candidate) => candidate.title.startsWith('Create'))) {
        created++;
        const after = apply(analysis, action);
        expect(analyze(after).structure?.problems.length).toBeLessThanOrEqual(analysis.structure?.problems.length ?? 0);
      }
    }
    expect(created).toBeGreaterThan(0);
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

  it('changes a step of a path that selects nothing to a name the file has there', () => {
    const value = analyze(text.replace(`<add sel="//cue[@name='Later']"`, `<add sel="//cue[@name='Ltaer']"`), uri, patchContext);
    expect(fixes(value, 'patch-no-match', data)).toEqual(["Change to 'Later' *"]);
    const after = fixed(value, 'patch-no-match', "Change to 'Later'", data);
    expect(lineWith(after, 'instantiate')).toBe(`<add sel="//cue[@name='Later']" type="@instantiate">true</add>`);
    expect(analyze(after, uri, patchContext).diagnostics.filter((diagnostic) => diagnostic.message.includes("'Later'"))).toEqual([]);
    // A misspelt element name: the names of the file close to it, a letter too many closer than one changed.
    const name = analyze(text.replace(`<add sel="//cue[@name='Later']"`, `<add sel="//cuee[@name='Later']"`), uri, patchContext);
    expect(fixes(name, 'patch-no-match', data)).toEqual(["Change to 'cue' *", "Change to 'cues'"]);
    // An element name the schema knows is meant: `//cue[@name='Missing']` gets nothing.
    expect(fixes(analyze(text, uri, patchContext), 'patch-no-match', data)).toEqual([]);
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
    // Setup is a script of the game here: nothing is created in it.
    expect(quickFixes(analysis, analysis.diagnostics, { ...game, folder: path.join(project, 'game') })).toEqual([]);
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
    let closing = 0;
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
          // What closes a value or a tag, or adds or changes an end tag, leaves the text with fewer problems.
          if (/^(Close the|Add the end tag|Change the end tag)/.test(action.title)) {
            closing++;
            expect(analyze(apply(analysis, action)).structure?.problems.length ?? 0).toBeLessThan(analysis.structure?.problems.length ?? 0);
          }
          // A changed name replaces exactly what a diagnostic of the action covers.
          if (action.title.startsWith('Change to')) {
            const covered = action.diagnostics?.map((diagnostic) => analysis.document.getText(diagnostic.range)) ?? [];
            expect(covered).toContain(analysis.document.getText(edits[0].range));
          }
        }
      }
    }
    expect(offered).toBeGreaterThan(100);
    expect(closing).toBeGreaterThan(20);
  });
});
