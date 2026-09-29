import { describe, expect, it } from 'vitest';
import { conditionHolds, documentTree, evaluateXPath, parseXml, parseXPath, parseXPathCondition, type PatchNode, type XPathSelection } from '../src';

const text = [
  '<mdscript name="Setup">',
  '  <cues>',
  '    <cue name="Start">',
  '      <actions>',
  '        <set_value name="$a" exact="1"/>',
  '        <!-- marker -->',
  '        <set_value name="$b" exact="2"/>',
  '        <loadout ref="small"/>',
  '      </actions>',
  '    </cue>',
  '    <cue name="Later" comment="a &quot;quoted&quot; one">',
  '      <cues>',
  '        <cue name="Inner"><text>hello  world</text></cue>',
  '      </cues>',
  '    </cue>',
  '  </cues>',
  '</mdscript>',
].join('\n');
const document = documentTree({ file: 'setup.xml', text, structure: parseXml(text) });

function describeSelection(selection: XPathSelection<PatchNode>): string {
  switch (selection.kind) {
    case 'node':
      return selection.node.kind === 'comment'
        ? `comment '${selection.node.stringValue()}'`
        : `${selection.node.name}${selection.node.attribute('name') ? ` ${selection.node.attribute('name')}` : ''}`;
    case 'attribute':
      return `@${selection.name} of ${selection.owner.name} ${selection.owner.attribute('name') ?? ''}`.trim();
    case 'text':
      return `text of ${selection.owner.name}`;
  }
}

function select(path: string): string[] {
  const parsed = parseXPath(path);
  expect(parsed.problem).toBeUndefined();
  return evaluateXPath(parsed, document).map(describeSelection);
}

describe('parseXPath', () => {
  it('reads steps and predicates with their offsets', () => {
    const path = "/mdscript/cues//cue[@name='Start']/actions/set_value[2]/@exact";
    const parsed = parseXPath(path);
    expect(parsed.problem).toBeUndefined();
    expect(parsed.absolute).toBe(true);
    expect(parsed.steps.map((step) => `${step.descendants ? '//' : '/'}${path.slice(step.test.start, step.test.end)}`)).toEqual([
      '/mdscript',
      '/cues',
      '//cue',
      '/actions',
      '/set_value',
      '/@exact',
    ]);
    const cue = parsed.steps[2];
    expect(path.slice(cue.start, cue.end)).toBe("//cue[@name='Start']");
    const predicate = cue.predicates[0];
    expect(predicate.kind).toBe('compare');
    if (predicate.kind === 'compare') {
      expect(predicate.subject).toMatchObject({ kind: 'attribute', name: 'name' });
      expect(path.slice(predicate.value.start, predicate.value.end)).toBe("'Start'");
      expect(predicate.value.value).toBe('Start');
    }
    expect(parsed.steps[4].predicates[0]).toMatchObject({ kind: 'position', position: 2 });
  });

  it('reads what patches write: quotes, or without a space, comments, values of attributes', () => {
    expect(parseXPath(`//set_value[@name="$a"][@exact='1']`).problem).toBeUndefined();
    expect(parseXPath("//loadout/@ref[.='a' or.='b']").steps[1].predicates[0].kind).toBe('or');
    expect(parseXPath("//comment()[. = ' marker ']").steps[0].test.kind).toBe('comment');
    expect(parseXPath("//cue[not(@comment) and contains(@name, 'art')][last()]").problem).toBeUndefined();
    expect(parseXPath('cues/cue[position() = 1]').absolute).toBe(false);
  });

  it('tells syntax problems from XPath it does not understand', () => {
    const cases: [string, boolean, string][] = [
      ["//cue[@name='Start'", false, "Predicate '[' is not closed"],
      ["//cue[@name='Start]", false, "String 'Start] is not closed"],
      ['/mdscript/', false, 'Expected a name at the end of the path'],
      ['//cue[]', false, 'Empty predicate'],
      ['//cue[@name=]', false, "Expected a string after '='"],
      ['/mdscript/@name/cues', false, 'Nothing can follow an attribute'],
      ['//cue[count(cues) > 1]', true, 'The function count() is not understood by X4CodeSense; the game may accept it'],
      ['//cue/following-sibling::cue', true, "The axis 'following-sibling::' is not understood by X4CodeSense; the game may accept it"],
      ['//cue | //library', true, "A union with '|' is not understood by X4CodeSense; the game may accept it"],
      ["//cue[@name='a'][. > 1]", true, 'This operator is not understood by X4CodeSense; the game may accept it'],
    ];
    for (const [path, unsupported, message] of cases) {
      expect(parseXPath(path).problem, path).toMatchObject({ unsupported, message });
    }
  });

  it('reads a condition with not()', () => {
    const condition = parseXPathCondition("not(//cue[@name='Nowhere'])");
    expect(condition.negated).toBe(true);
    expect(condition.path.text).toBe("not(//cue[@name='Nowhere'])");
    expect(condition.path.steps[0].start).toBe(4);
    expect(conditionHolds(condition, document)).toBe(true);
    expect(conditionHolds(parseXPathCondition("//cue[@name='Start']"), document)).toBe(true);
  });
});

describe('evaluateXPath', () => {
  it('selects elements by absolute paths, descendants and predicates', () => {
    expect(select('/mdscript/cues/cue')).toEqual(['cue Start', 'cue Later']);
    expect(select('//cue')).toEqual(['cue Start', 'cue Later', 'cue Inner']);
    expect(select("//cue[@name='Later']//cue")).toEqual(['cue Inner']);
    expect(select('mdscript/cues/cue[2]')).toEqual(['cue Later']);
    expect(select('//set_value[last()]')).toEqual(['set_value $b']);
    expect(select("//cue[not(@name='Start')][cues]")).toEqual(['cue Later']);
    expect(select("//cue[starts-with(@name, 'In') or @name='Start']")).toEqual(['cue Start', 'cue Inner']);
    expect(select('//cue[@comment=\'a "quoted" one\']')).toEqual(['cue Later']);
    expect(select('//*[@exact]')).toEqual(['set_value $a', 'set_value $b']);
    expect(select("//cue[text='hello world']")).toEqual(['cue Inner']);
  });

  it('counts positions per parent after `//`, as XPath does', () => {
    expect(select('//cue[1]')).toEqual(['cue Start', 'cue Inner']);
  });

  it('selects attributes, with predicates on their value, comments and text', () => {
    expect(select('//set_value/@exact')).toEqual(['@exact of set_value $a', '@exact of set_value $b']);
    expect(select("//set_value/@exact[.='2' or .='3']")).toEqual(['@exact of set_value $b']);
    expect(select("//comment()[. = ' marker ']")).toEqual(["comment ' marker '"]);
    expect(select('//text/text()')).toEqual(['text of text']);
    expect(select("//cue[@name='Nowhere']")).toEqual([]);
  });

  it('evaluates the first steps of a path on request', () => {
    const parsed = parseXPath("/mdscript/cues/cue[@name='Start']/actions/nothing");
    expect(evaluateXPath(parsed, document)).toEqual([]);
    expect(evaluateXPath(parsed, document, 4).map(describeSelection)).toEqual(['actions']);
  });
});

describe('XPath while typing', () => {
  it('keeps the steps read before a problem and selects nothing', () => {
    for (const path of ['/mdscript/cues/cue[@name=', "/mdscript/cues/cue[@name='St", '/mdscript/cues/', '/mdscript/cues/cue[', '/mdscript/cu es', '']) {
      const parsed = parseXPath(path);
      expect(parsed.problem, path).toBeDefined();
      expect(evaluateXPath(parsed, document), path).toEqual([]);
    }
    expect(parseXPath('/mdscript/cues/cue[@name=').steps.map((step) => step.test.kind)).toEqual(['element', 'element', 'element']);
    expect(parseXPath('/mdscript/cues/cue[@name=').problem?.unsupported).toBe(false);
  });
});
