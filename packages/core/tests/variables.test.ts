import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeText, loadGameData, type DocumentAnalysis, type ScriptVariable, type VariableTable } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);

function analyze(text: string, validateVariables = true): DocumentAnalysis {
  return analyzeText(text, { schemas: game.schemas, properties: game.properties, validateVariables });
}

/** One line per table that has variables: `kind name: $x=definitions/references/removals ...`. */
function tables(analysis: DocumentAnalysis): string[] {
  return (analysis.variables?.tables ?? [])
    .filter((table) => table.variables.size > 0)
    .map(
      (table) =>
        `${table.kind} ${table.name}: ${[...table.variables.values()]
          .map((variable) => `$${variable.name}=${variable.definitions.length}/${variable.references.length}/${variable.removals.length}`)
          .join(' ')}`
    );
}

function undefinedReport(analysis: DocumentAnalysis): string[] {
  return analysis.diagnostics
    .filter((diagnostic) => diagnostic.code === 'variable-undefined')
    .map((diagnostic) => `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`);
}

function table(analysis: DocumentAnalysis, kind: string, name: string): VariableTable {
  const found = analysis.variables?.tables.find((candidate) => candidate.kind === kind && candidate.name === name);
  if (!found) {
    throw new Error(`no ${kind} table '${name}'`);
  }
  return found;
}

function variable(analysis: DocumentAnalysis, kind: string, tableName: string, name: string): ScriptVariable {
  const found = table(analysis, kind, tableName).variables.get(name);
  if (!found) {
    throw new Error(`no variable '${name}' in ${kind} '${tableName}'`);
  }
  return found;
}

const md = (cues: string[]): string => `<mdscript name="S">\n  <cues>\n${cues.join('\n')}\n  </cues>\n</mdscript>\n`;

describe('variable tables of a Mission Director script', () => {
  it('follows the namespace rules of the guide', () => {
    const analysis = analyze(
      md([
        '    <cue name="Root">',
        '      <actions>',
        '        <set_value name="$a" exact="1"/>',
        '      </actions>',
        '      <cues>',
        '        <cue name="Child">',
        '          <actions>',
        '            <set_value name="$b" exact="$a + parent.$a + namespace.$a"/>',
        '          </actions>',
        '          <cues>',
        '            <cue name="Scoped" namespace="this">',
        '              <actions>',
        '                <set_value name="$c" exact="$a + Root.$a + Root.$b"/>',
        '                <set_value name="this.$d" exact="static.$c + namespace.$c"/>',
        '              </actions>',
        '              <cues>',
        '                <cue name="Inner">',
        '                  <actions>',
        '                    <set_value name="$e" exact="$c + parent.$d + Root.$a + global.$g + md.Other.Cue.$h + player.entity.$i"/>',
        '                  </actions>',
        '                </cue>',
        '              </cues>',
        '            </cue>',
        '          </cues>',
        '        </cue>',
        '      </cues>',
        '    </cue>',
      ])
    );
    expect(tables(analysis)).toEqual([
      'cue Root: $a=1/5/0 $b=1/1/0',
      'cue Scoped: $c=1/3/0 $a=0/1/0 $d=1/1/0 $e=1/0/0',
      'global global: $g=0/1/0',
      'remote md.Other.Cue: $h=0/1/0',
      'remote player.entity: $i=0/1/0',
    ]);
    expect(undefinedReport(analysis)).toEqual(["15:45 Variable '$a' is never set in cue 'Scoped'"]);
    expect(analysis.variables?.occurrences.map((occurrence) => occurrence.name).join(' ')).toBe('a b a a a c a a b d c c e c d a g h i');
  });

  it('shares variables between a library and the cues that include or instantiate it', () => {
    const analysis = analyze(
      md([
        '    <cue name="User">',
        '      <actions>',
        '        <set_value name="$q" exact="1"/>',
        '        <include_actions ref="Lib"/>',
        '        <set_value name="$r" exact="$l + $p"/>',
        '      </actions>',
        '    </cue>',
        '    <cue name="Inst" ref="Lib">',
        '      <param name="p" value="player.money"/>',
        '    </cue>',
        '    <cue name="Ext" ref="md.Other.Lib">',
        '      <param name="p" value="$missing"/>',
        '    </cue>',
        '    <cue name="Dyn">',
        '      <actions>',
        '        <include_actions ref="$lib"/>',
        '      </actions>',
        '    </cue>',
        '    <library name="Lib">',
        '      <params>',
        '        <param name="p" default="player.money"/>',
        '      </params>',
        '      <actions>',
        '        <set_value name="$l" exact="$p + $q"/>',
        '      </actions>',
        '    </library>',
        '    <library name="Unused">',
        '      <actions>',
        '        <set_value name="$u" exact="$nothing"/>',
        '      </actions>',
        '    </library>',
      ])
    );
    expect(analysis.diagnostics.filter((diagnostic) => diagnostic.code !== 'variable-undefined')).toEqual([]);
    expect(tables(analysis)).toEqual([
      'cue User: $q=1/0/0 $r=1/0/0 $l=0/1/0 $p=0/1/0',
      'library Lib: $p=2/1/0 $l=1/0/0 $q=0/1/0',
      'cue Ext: $missing=0/1/0',
      'cue Dyn: $lib=0/1/0',
      'library Unused: $u=1/0/0 $nothing=0/1/0',
    ]);
    const user = table(analysis, 'cue', 'User');
    const lib = table(analysis, 'library', 'Lib');
    expect([...user.links].map((linked) => linked.name)).toEqual(['Lib']);
    expect([...lib.links].map((linked) => linked.name).sort()).toEqual(['Inst', 'User']);
    expect(table(analysis, 'cue', 'Ext').opaque).toBe(true);
    expect(table(analysis, 'cue', 'Dyn').opaque).toBeUndefined();
    expect(table(analysis, 'library', 'Unused').opaque).toBe(true);
    expect([...variable(analysis, 'library', 'Lib', 'p').types]).toEqual(['integer']);
    // `$l` and `$p` read in User come from Lib; `$q` read in Lib comes from User; nothing includes Unused; another script fills Ext.
    expect(undefinedReport(analysis)).toEqual(["18:31 Variable '$lib' is never set in cue 'Dyn'"]);
  });

  it('tells guarded reads, table keys, value keys and removals apart', () => {
    const analysis = analyze(
      md([
        '    <cue name="A">',
        '      <actions>',
        '        <set_value name="$t" exact="table[$key = 1, $other = $missing]"/>',
        '        <do_if value="@$maybe.count and $maybe2? and $maybe3.x? and $t.$key and $t.{$dyn}">',
        '          <remove_value name="$t"/>',
        '        </do_if>',
        '        <set_value name="$t.$key" exact="2"/>',
        '      </actions>',
        '    </cue>',
      ])
    );
    expect(tables(analysis)).toEqual(['cue A: $t=1/3/1 $missing=0/1/0 $maybe=0/1/0 $maybe2=0/1/0 $maybe3=0/1/0 $dyn=0/1/0']);
    expect(variable(analysis, 'cue', 'A', 'maybe').references[0].guarded).toBe(true);
    expect(variable(analysis, 'cue', 'A', 'maybe2').references[0].guarded).toBe(true);
    expect(variable(analysis, 'cue', 'A', 'maybe3').references[0].guarded).toBe(false);
    expect(undefinedReport(analysis)).toEqual([
      "5:62 Variable '$missing' is never set in cue 'A'",
      "6:54 Variable '$maybe3' is never set in cue 'A'",
      "6:85 Variable '$dyn' is never set in cue 'A'",
    ]);
  });

  it('counts attributes that store a result as writes, as the schema documents them', () => {
    const analysis = analyze(
      md([
        '    <cue name="A">',
        '      <actions>',
        '        <append_to_list name="$list" exact="1" create="true"/>',
        '        <append_to_list name="$other" exact="$list"/>',
        '        <find_closest_resource ware="$list" zone="$zone" wares="$wares"/>',
        '        <set_value name="$r" exact="$zone + $wares + $other"/>',
        '      </actions>',
        '    </cue>',
      ])
    );
    expect(tables(analysis)).toEqual(['cue A: $list=1/2/0 $other=0/2/0 $zone=1/1/0 $wares=1/1/0 $r=1/0/0']);
    // Without `create="true"` the list must exist already.
    expect(undefinedReport(analysis)).toEqual(["6:31 Variable '$other' is never set in cue 'A'", "8:54 Variable '$other' is never set in cue 'A'"]);
  });

  it('takes reads under a test of the same variable, or under one in the cue conditions, as safe', () => {
    const analysis = analyze(
      md([
        '    <cue name="A">',
        '      <conditions>',
        '        <check_value value="$fromConditions?"/>',
        '      </conditions>',
        '      <actions>',
        '        <set_value name="$x" exact="$fromConditions.count"/>',
        '        <do_if value="$tested?">',
        '          <set_value name="$y" exact="$tested + 1"/>',
        '        </do_if>',
        '        <set_value name="$z" exact="$tested"/>',
        '      </actions>',
        '    </cue>',
      ])
    );
    expect(undefinedReport(analysis)).toEqual(["12:37 Variable '$tested' is never set in cue 'A'"]);
  });

  it('checks the libraries the script uses by name and leaves the others to their users', () => {
    const analysis = analyze(
      md([
        '    <cue name="A">',
        '      <actions>',
        '        <run_actions ref="Run" result="$r">',
        '          <param name="given" value="1"/>',
        '        </run_actions>',
        '        <include_actions ref="md.S.Inc"/>',
        '        <set_value name="$s" exact="$r + this.$fromInc + $inc"/>',
        '      </actions>',
        '    </cue>',
        '    <library name="Run">',
        '      <actions>',
        '        <set_value name="$v" exact="$given + $undeclared"/>',
        '      </actions>',
        '    </library>',
        '    <library name="Inc">',
        '      <actions>',
        '        <set_value name="this.$fromInc" exact="1"/>',
        '        <set_value name="$inc" exact="1"/>',
        '      </actions>',
        '    </library>',
        '    <library name="ByValue">',
        '      <actions>',
        '        <include_actions ref="Nested"/>',
        '        <set_value name="$b" exact="$fromUser"/>',
        '      </actions>',
        '    </library>',
        '    <library name="Nested">',
        '      <actions>',
        '        <set_value name="$n" exact="$fromUserToo"/>',
        '      </actions>',
        '    </library>',
      ])
    );
    // `run_actions` params fill the library; `md.S.Inc` is the script's own library, which runs in the including cue.
    expect(undefinedReport(analysis)).toEqual(["14:46 Variable '$undeclared' is never set in library 'Run'"]);
    expect([table(analysis, 'library', 'Run').opaque, table(analysis, 'library', 'Inc').opaque]).toEqual([undefined, undefined]);
    // ByValue is used through a value or by other scripts; Nested only by ByValue.
    expect([table(analysis, 'library', 'ByValue').opaque, table(analysis, 'library', 'Nested').opaque]).toEqual([true, true]);
  });

  it('lets any cue have what a script writes into cues it gets as values', () => {
    const analysis = analyze(
      md([
        '    <cue name="Sender">',
        '      <actions>',
        '        <set_value name="$target" exact="Receiver"/>',
        '        <set_value name="$target.$reply" exact="1"/>',
        '        <set_value name="event.param.{1}.$answer" exact="2"/>',
        '        <set_value name="md.S.Receiver.$direct" exact="3"/>',
        '      </actions>',
        '    </cue>',
        '    <cue name="Receiver">',
        '      <actions>',
        '        <set_value name="$x" exact="this.$reply + $answer + $nothing + $direct"/>',
        '      </actions>',
        '    </cue>',
      ])
    );
    expect(tables(analysis)).toEqual(['cue Sender: $target=1/1/0', 'cue Receiver: $direct=1/1/0 $x=1/0/0 $reply=0/1/0 $answer=0/1/0 $nothing=0/1/0']);
    const reply = variable(analysis, 'cue', 'Receiver', 'reply');
    expect(analysis.variables?.mayBeWrittenThroughValues(reply)).toBe(true);
    expect(undefinedReport(analysis)).toEqual(["13:61 Variable '$nothing' is never set in cue 'Receiver'"]);
  });

  it('skips patch blocks, and without the script index reports only when asked', () => {
    const text = md([
      '    <cue name="A">',
      '      <actions>',
      '        <set_value name="$new" exact="$old"/>',
      '      </actions>',
      '      <patch sinceversion="2">',
      '        <set_value name="$new" exact="$older"/>',
      '      </patch>',
      '    </cue>',
    ]);
    expect(undefinedReport(analyze(text))).toEqual(["5:39 Variable '$old' is never set in cue 'A'"]);
    expect(undefinedReport(analyze(text, false))).toEqual([]);
    expect(undefinedReport(analyzeText(text, { schemas: game.schemas, properties: game.properties }))).toEqual([]);
    expect(analyze(text, false).variables?.tables.length).toBeGreaterThan(0);
  });

  it('keeps collecting while the text is half typed', () => {
    const analysis = analyze(
      md([
        '    <cue name="A">',
        '      <actions>',
        '        <set_value name="$a" exact="1"/>',
        '        <set_value name="$b" exact="$a + $c',
        '        <set_value name="$d" exact="$b"/>',
        '        <do_if value="$a',
        '      </actions>',
        '    </cue>',
      ])
    );
    expect(tables(analysis)).toEqual(['cue A: $a=1/2/0 $b=1/1/0 $c=0/1/0 $d=1/0/0']);
    expect(undefinedReport(analysis)).toEqual(["6:42 Variable '$c' is never set in cue 'A'"]);
  });
});

describe('variable table of an AI script', () => {
  const ai = (body: string[]): string => `<aiscript name="a">\n${body.join('\n')}\n</aiscript>\n`;

  it('has one table with parameters, typed from their declaration or default', () => {
    const analysis = analyze(
      ai([
        '  <params>',
        '    <param name="target" type="ship"/>',
        '    <param name="count" default="player.money"/>',
        '    <param name="untyped"/>',
        '  </params>',
        '  <init>',
        '    <set_value name="$s" exact="player.ship"/>',
        '    <set_value name="$t" exact="table[$a = 1]"/>',
        '  </init>',
        '  <attention min="1">',
        '    <actions>',
        '      <set_value name="$n" exact="$s.speed + $count + $target.speed + $untyped + $nope + this.$x + $t.$a"/>',
        '      <set_value name="$s" exact="[1, 2]"/>',
        '    </actions>',
        '  </attention>',
      ])
    );
    expect(tables(analysis)).toEqual([
      'script script: $target=1/1/0 $count=1/1/0 $untyped=1/1/0 $s=2/1/0 $t=1/1/0 $n=1/0/0 $nope=0/1/0',
      'remote this: $x=0/1/0',
    ]);
    expect([...variable(analysis, 'script', 'script', 'target').types]).toEqual(['ship']);
    expect([...variable(analysis, 'script', 'script', 'count').types]).toEqual(['integer']);
    expect([...variable(analysis, 'script', 'script', 'untyped').types]).toEqual([]);
    expect([...variable(analysis, 'script', 'script', 's').types]).toEqual(['ship', 'list']);
    expect([...variable(analysis, 'script', 'script', 't').types]).toEqual(['table']);
    expect(undefinedReport(analysis)).toEqual(["13:82 Variable '$nope' is never set in this script"]);
  });

  it('finds the occurrence and the table at an offset', () => {
    const text = ai([
      '  <params>',
      '    <param name="target"/>',
      '  </params>',
      '  <attention min="1">',
      '    <actions>',
      '      <set_value name="$n" exact="$target.speed"/>',
      '    </actions>',
      '  </attention>',
    ]);
    const analysis = analyze(text);
    const variables = analysis.variables;
    const reference = text.indexOf('$target.speed');
    const found = variables?.occurrenceAt(reference + 3);
    expect(found).toMatchObject({ name: 'target', kind: 'reference', start: reference, end: reference + '$target'.length });
    expect(found && variables?.variableOf(found).definitions[0]).toMatchObject({
      kind: 'definition',
      start: text.indexOf('target"'),
      element: { name: 'param' },
    });
    expect(variables?.occurrenceAt(reference + 8)).toBeUndefined();
    expect(variables?.occurrenceAt(text.indexOf('speed'))).toBeUndefined();
    const element = analysis.structure?.elements.find((candidate) => candidate.name === 'set_value');
    expect(element && variables?.tableOf(element).kind).toBe('script');
    expect(element && variables?.tableForObjectText('this', element)?.kind).toBe('remote');
    expect(element && variables?.tableForObjectText('global', element)?.kind).toBe('global');
    expect(element && variables?.tableForObjectText('$obj', element)).toBeUndefined();
  });
});
