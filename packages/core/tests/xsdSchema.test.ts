import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  acceptsFreeText,
  acceptsValue,
  analyzeText,
  enumerationsOf,
  loadSchemas,
  typeNamesOf,
  type XsdElement,
  type XsdSchema,
  type XsdSimpleType,
} from '../src';

const libraries = fileURLToPath(new URL('./fixtures/unpacked/libraries', import.meta.url));
const schemas = loadSchemas(libraries);
const md = schemas.schemas.md as XsdSchema;
const aiscripts = schemas.schemas.aiscripts as XsdSchema;

function declaration(schema: XsdSchema, ...names: string[]): XsdElement {
  let current = schema.root(names[0]);
  for (const name of names.slice(1)) {
    current = current?.child(name);
  }
  if (!current) {
    throw new Error(`no declaration for ${names.join('/')}`);
  }
  return current;
}

const cue = declaration(md, 'mdscript', 'cues', 'cue');
const actions = cue.child('actions') as XsdElement;

describe('loadSchemas', () => {
  it('loads both schemas with their includes and no problems', () => {
    expect(schemas.problems).toEqual([]);
    expect(md.rootNames).toEqual(['mdscript']);
    expect(aiscripts.rootNames).toEqual(['aiscript']);
    expect(md.simpleTypeNames).toContain('expression');
    expect(md.simpleTypeNames).toContain('cuename');
    expect(aiscripts.simpleTypeNames).not.toContain('cuename');
  });

  it('reports missing files instead of throwing', () => {
    const missing = loadSchemas(path.join(libraries, 'nowhere'));
    expect(missing.schemas).toEqual({});
    expect(missing.problems.map((problem) => path.basename(problem.file)).sort()).toEqual(['aiscripts.xsd', 'diff.xsd', 'md.xsd']);
  });

  it("loads the game's diff.xsd: entities of its DOCTYPE, XML name escapes, any content", () => {
    const diff = schemas.diff as XsdSchema;
    expect(diff.rootNames).toEqual(['diff']);
    const add = declaration(diff, 'diff', 'add');
    expect(add.documentation).toBe('Add content');
    const type = add.attributes.get('type');
    expect(type && ['@version', '@xsi:type', 'namespace::x'].map((value) => acceptsValue(type.type, value))).toEqual([true, true, true]);
    expect(type && ['version', '@1a', '@a b'].map((value) => acceptsValue(type.type, value))).toEqual([false, false, false]);
    expect(add.contentModel.wildcard).toBe(true);
    expect(add.contentModel.validate(['cue', 'actions', 'cue'])).toEqual([]);
    expect(add.contentModel.expectedAfter([])).toEqual([]);
    expect(declaration(diff, 'diff', 'replace').contentModel.validate(['cue', 'cue'])).toEqual([{ index: 1, expected: [] }]);
    expect(declaration(diff, 'diff', 'remove').contentModel.wildcard).toBe(false);
    expect([...typeNamesOf((add.attributes.get('sel') as { type: XsdSimpleType }).type)]).toEqual(['xpath-add']);
  });
});

describe('element declarations', () => {
  it('resolves attributes and children through named types, groups and extensions', () => {
    expect([...cue.attributes.keys()]).toEqual(['name', 'ref', 'instantiate', 'namespace']);
    expect(cue.attributes.get('name')).toMatchObject({ required: true, typeName: 'scriptname' });
    expect(cue.documentation).toBe('A cue.');
    expect([...cue.contentModel.declarations.keys()]).toEqual(['param', 'conditions', 'delay', 'actions', 'patch', 'cues']);

    const conditions = cue.child('conditions') as XsdElement;
    expect([...conditions.attributes.keys()]).toEqual(['ref']);
    expect([...conditions.contentModel.declarations.keys()]).toEqual(['check_value', 'event_object_destroyed']);

    const setValue = actions.child('set_value') as XsdElement;
    expect([...setValue.attributes.keys()]).toEqual(['name', 'exact', 'operation', 'comment']);
    expect(setValue.attributes.get('operation')?.default).toBe('set');
    expect(setValue.attributes.get('comment')?.documentation).toBe('Free text comment.');
    expect(setValue.documentation).toBe('Sets a variable.\nThe value is evaluated once.');
    expect(setValue.contentModel.declarations.size).toBe(0);
    expect(path.basename(setValue.location.file)).toBe('common.xsd');
    expect(setValue.location.start).toBeGreaterThan(0);

    const doIf = actions.child('do_if') as XsdElement;
    expect(doIf.child('do_if')).toBe(doIf);
    expect(doIf.child('set_value')).toBe(setValue);
    expect(md.root('mdscript')?.documentation).toBe('Root of a Mission Director script.');
  });

  it('keeps the occurrence of a group model that a reference wraps', () => {
    // `mdactions` is a choice with minOccurs="0" maxOccurs="unbounded", referenced once: any number of actions in any order.
    const model = actions.contentModel;
    expect([...model.declarations.keys()]).toContain('include_actions');
    expect(model.validate([])).toEqual([]);
    expect(model.validate(['set_value', 'include_actions', 'set_value', 'remove_value'])).toEqual([]);
  });

  it('resolves the aiscript root and an extended type', () => {
    const root = aiscripts.root('aiscript') as XsdElement;
    expect([...root.contentModel.declarations.keys()]).toEqual(['params', 'interrupts', 'init', 'attention']);
    const handlerActions = declaration(aiscripts, 'aiscript', 'interrupts', 'handler', 'actions');
    expect([...handlerActions.attributes.keys()]).toEqual(['ref']);
    expect(handlerActions.attributes.get('ref')?.typeName).toBe('interrupt_actionsref');
    expect(handlerActions.child('debug_text')).toBeDefined();
    expect(handlerActions.child('resume')).toBeDefined();
    expect(handlerActions.child('label')).toBeUndefined();
    const attentionActions = declaration(aiscripts, 'aiscript', 'attention', 'actions');
    expect(attentionActions.child('label')).toBeDefined();
    expect(declaration(aiscripts, 'aiscript', 'interrupts', 'library', 'actions').attributes.get('name')?.typeName).toBe('namestring');
    expect(declaration(aiscripts, 'aiscript', 'init').child('set_value')).toBeDefined();
  });
});

describe('simple types', () => {
  const setValue = actions.child('set_value') as XsdElement;
  const debugText = actions.child('debug_text') as XsdElement;
  const findShip = actions.child('find_ship') as XsdElement;

  it('validates enumerations', () => {
    const operation = setValue.attributes.get('operation')?.type;
    expect(operation).toBeDefined();
    if (!operation) {
      return;
    }
    expect(acceptsValue(operation, 'add')).toBe(true);
    expect(acceptsValue(operation, ' add\n')).toBe(true);
    expect(acceptsValue(operation, 'multiply')).toBe(false);
    expect(enumerationsOf(operation).map((enumeration) => enumeration.value)).toEqual(['set', 'add', 'subtract']);
    expect(acceptsFreeText(operation)).toBe(false);
  });

  it('validates unions of enumerations and expressions', () => {
    const classType = findShip.attributes.get('class')?.type;
    const filter = debugText.attributes.get('filter')?.type;
    expect(classType && filter).toBeDefined();
    if (!classType || !filter) {
      return;
    }
    expect(acceptsValue(classType, 'ship')).toBe(true);
    expect(acceptsValue(classType, '$class')).toBe(true);
    expect(acceptsValue(classType, '')).toBe(false);
    expect(acceptsValue(classType, '"quoted"')).toBe(false);
    expect(enumerationsOf(classType).map((enumeration) => enumeration.value)).toEqual(['ship', 'station']);
    expect(enumerationsOf(classType)[0].documentation).toBe('Any ship');
    expect(typeNamesOf(classType)).toEqual(new Set(['classexprlookup', 'classlookup', 'expression']));
    expect(acceptsFreeText(classType)).toBe(true);
    expect(acceptsValue(filter, 'error')).toBe(true);
    expect(acceptsValue(filter, '$f')).toBe(true);
    expect(enumerationsOf(filter).map((enumeration) => enumeration.value)).toEqual(['error', 'general']);
  });

  it('validates lists, ranges, patterns and built-ins', () => {
    const flags = findShip.attributes.get('flags')?.type;
    const chance = debugText.attributes.get('chance')?.type;
    const name = cue.attributes.get('name')?.type;
    const version = aiscripts.root('aiscript')?.attributes.get('version')?.type;
    expect(flags && chance && name && version).toBeDefined();
    if (!flags || !chance || !name || !version) {
      return;
    }
    expect(acceptsValue(flags, 'a b')).toBe(true);
    expect(acceptsValue(flags, 'a c')).toBe(false);
    expect(acceptsValue(flags, '')).toBe(true);
    expect(acceptsValue(chance, '50')).toBe(true);
    expect(acceptsValue(chance, '101')).toBe(false);
    expect(acceptsValue(chance, 'x')).toBe(false);
    expect(acceptsValue(name, 'Start')).toBe(true);
    expect(acceptsValue(name, '1x')).toBe(false);
    expect(acceptsValue(name, 'start')).toBe(false);
    expect(typeNamesOf(name)).toEqual(new Set(['scriptname']));
    const cueReference = actions.child('cancel_cue')?.attributes.get('cue')?.type;
    expect(cueReference && typeNamesOf(cueReference)).toEqual(new Set(['cuename', 'expression']));
    expect(version.builtin).toBe('integer');
    expect(acceptsValue(version, '3')).toBe(true);
    expect(acceptsValue(version, '3.5')).toBe(false);
    expect(md.simpleType('classlookup')?.enumerations.length).toBe(2);
    expect(md.simpleType('nope')).toBeUndefined();
  });

  it('treats several patterns of one restriction as alternatives', () => {
    const lvalue = findShip.attributes.get('name')?.type;
    expect(lvalue).toBeDefined();
    if (!lvalue) {
      return;
    }
    expect(lvalue.patterns.length).toBe(2);
    expect(acceptsValue(lvalue, '$ship')).toBe(true);
    expect(acceptsValue(lvalue, 'stat.kills')).toBe(true);
    expect(acceptsValue(lvalue, 'ship')).toBe(false);
    expect(lvalue.documentation).toBe('A variable or a stat: several patterns in one step are alternatives.');
  });
});

describe('structure validation', () => {
  const valid = [
    '<mdscript name="Sample">',
    '  <cues>',
    '    <cue name="Start" instantiate="true">',
    '      <conditions ref="lib.cond"><check_value value="player.money gt 0"/></conditions>',
    '      <delay exact="5s"/>',
    '      <actions>',
    '        <set_value name="$x" exact="1" operation="add" comment="c"/>',
    '        <do_if value="$x == 1"><debug_text text="\'hi\'" filter="error" chance="50"/></do_if>',
    '        <find_ship name="$ship" class="ship" flags="a b" multiple="false"/>',
    '        <create_ship macro="macro.ship_arg_s_fighter_01_a_macro"><owner exact="faction.argon"/><position x="1" y="2" z="3"/></create_ship>',
    '        <deliver><reward money="100"/><people target="$ship"/></deliver>',
    '      </actions>',
    '      <cues><cue name="Child"/></cues>',
    '    </cue>',
    '    <library name="Lib"/>',
    '  </cues>',
    '</mdscript>',
  ].join('\n');

  function report(text: string, validateStructure = true): string[] {
    return analyzeText(text, { schemas, validateStructure }).diagnostics.map(
      (diagnostic) => `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.code}: ${diagnostic.message}`
    );
  }

  it('accepts a valid script and resolves every declaration', () => {
    const analysis = analyzeText(valid, { schemas });
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.declarations.size).toBe(analysis.structure?.elements.length);
    const root = analysis.structure?.roots[0];
    expect(root && analysis.declarations.get(root)).toBe(md.root('mdscript'));
  });

  it('does nothing without schemas and nothing for a patch', () => {
    expect(analyzeText(valid).diagnostics).toEqual([]);
    expect(analyzeText(valid).declarations.size).toBe(0);
    expect(analyzeText('<diff><add sel="/x"><bogus/></add></diff>', { schemas }).diagnostics).toEqual([]);
  });

  it('reports unknown and misplaced elements and attributes in document order', () => {
    const text = [
      '<mdscript name="S">',
      '  <cues>',
      '    <library name="L"/>',
      '    <cue name="A" bogus="1">',
      '      <actions><set_value exact="1"/><frobnicate/></actions>',
      '      <conditions/>',
      '    </cue>',
      '  </cues>',
      '  <extra/>',
      '</mdscript>',
    ].join('\n');
    expect(report(text)).toEqual([
      "4:6 invalid-child-element: Element 'cue' is not allowed after 'library' in 'cues'. Expected 'library'",
      "4:19 unknown-attribute: Unknown attribute 'bogus' in 'cue'",
      "5:17 missing-required-attribute: Missing required attribute 'name' in 'set_value'",
      "5:39 unknown-element: Unknown element 'frobnicate' in 'actions'",
      "6:8 invalid-child-element: Element 'conditions' is not allowed after 'actions' in 'cue'. Expected 'cues', 'patch'",
      "9:4 unknown-element: Unknown element 'extra' in 'mdscript'",
    ]);
  });

  it('keeps unknown elements and attribute problems when content checking is off', () => {
    const text = '<mdscript name="S"><cues><library name="L"/><cue name="A" bogus="1"><actions/><conditions/><frobnicate/></cue></cues></mdscript>';
    expect(report(text, false).map((line) => line.split(' ')[1])).toEqual(['unknown-attribute:', 'unknown-element:']);
    expect(report(text).map((line) => line.split(' ')[1])).toEqual([
      'invalid-child-element:',
      'unknown-attribute:',
      'invalid-child-element:',
      'unknown-element:',
    ]);
  });

  it('reports invalid attribute values with what was expected', () => {
    const text = [
      '<mdscript name="S">',
      '  <cues>',
      '    <cue name="1bad" instantiate="maybe" namespace="global">',
      '      <actions>',
      '        <set_value name="$x" operation="multiply"/>',
      '        <debug_text text="\'x\'" chance="150" filter="$f"/>',
      '        <find_ship name="ship" class="" flags="a c"/>',
      '      </actions>',
      '    </cue>',
      '  </cues>',
      '</mdscript>',
    ].join('\n');
    expect(report(text)).toEqual([
      "3:16 invalid-attribute-value: Invalid value '1bad' for attribute 'name' in 'cue'. Expected a value of type 'scriptname'",
      "3:35 invalid-attribute-value: Invalid value 'maybe' for attribute 'instantiate' in 'cue'. Expected one of 'true', 'false'",
      "3:53 invalid-attribute-value: Invalid value 'global' for attribute 'namespace' in 'cue'. Expected one of 'this', 'static'",
      "5:41 invalid-attribute-value: Invalid value 'multiply' for attribute 'operation' in 'set_value'. Expected one of 'set', 'add', 'subtract'",
      "6:40 invalid-attribute-value: Invalid value '150' for attribute 'chance' in 'debug_text'. Expected a value of type 'percentage'",
      "7:26 invalid-attribute-value: Invalid value 'ship' for attribute 'name' in 'find_ship'. Expected a value of type 'lvaluename'",
      "7:39 invalid-attribute-value: Invalid value '' for attribute 'class' in 'find_ship'. Expected one of 'ship', 'station' or an expression",
      "7:48 invalid-attribute-value: Invalid value 'a c' for attribute 'flags' in 'find_ship'. Expected a list of 'a', 'b'",
    ]);
  });

  it('reports missing required children', () => {
    expect(report('<aiscript name="x">\n  <params/>\n</aiscript>')).toEqual([
      "1:2 missing-child-element: Element 'aiscript' is missing a required child. Expected 'attention', 'init', 'interrupts'",
    ]);
    expect(report('<aiscript name="x">\n  <attention min="1"/>\n</aiscript>')).toEqual([
      "2:4 missing-child-element: Element 'attention' is missing a required child. Expected 'actions'",
    ]);
  });

  it('checks all groups', () => {
    const wrap = (deliver: string): string =>
      `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <actions>\n        ${deliver}\n      </actions>\n    </cue>\n  </cues>\n</mdscript>`;
    expect(report(wrap('<deliver><reward money="1"/><reward money="2"/></deliver>'))).toEqual([
      "5:38 invalid-child-element: Element 'reward' is not allowed after 'reward' in 'deliver'. Expected 'people', 'wares'",
    ]);
    expect(report(wrap('<deliver/>'))).toEqual(["5:10 missing-child-element: Element 'deliver' is missing a required child. Expected 'reward'"]);
    expect(report(wrap('<deliver><wares/><reward money="1"/></deliver>'))).toEqual([]);
  });

  it('accepts an optional group at the start of a sequence', () => {
    const text = '<mdscript name="S"><cues><cue name="A"><actions><create_ship macro="m"><position x="1"/></create_ship></actions></cue></cues></mdscript>';
    expect(report(text)).toEqual([]);
  });

  it('skips the descendants of an unknown element and reports extra roots', () => {
    expect(report('<mdscript name="S"><cues><cue name="A"><actions><bogus><set_value/></bogus></actions></cue></cues></mdscript>')).toEqual([
      "1:50 unknown-element: Unknown element 'bogus' in 'actions'",
    ]);
    expect(report('<mdscript name="a"><cues/></mdscript>\n<mdscript name="b"><cues/></mdscript>')).toEqual([
      "2:2 unknown-root-element: Unexpected root element 'mdscript': the document already has a root",
    ]);
  });

  it('ignores namespace and schema instance attributes', () => {
    const text = '<mdscript name="S" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="md.xsd"><cues/></mdscript>';
    expect(report(text)).toEqual([]);
  });
});
