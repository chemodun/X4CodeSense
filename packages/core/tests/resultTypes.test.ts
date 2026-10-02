import { describe, expect, it } from 'vitest';
import { multipleOf, parseXml, ScriptProperties, writtenTypeOf, XsdSchema, type XsdElement } from '../src';

const properties = ScriptProperties.parse({
  main: {
    path: 'scriptproperties.xml',
    text: [
      '<scriptproperties>',
      '  <datatype name="component"/>',
      '  <datatype name="object" type="component"/>',
      '  <datatype name="ship" type="object"/>',
      '  <datatype name="sector" type="component"/>',
      '  <datatype name="componentslot"/>',
      '  <datatype name="faction"/>',
      '  <datatype name="group"/>',
      '  <datatype name="list"/>',
      '  <datatype name="loadout"/>',
      '  <datatype name="operation"/>',
      '  <datatype name="boardingoperation" type="operation"/>',
      '  <datatype name="rotation"/>',
      '  <datatype name="entity" type="component"/>',
      '  <datatype name="npctemplateentry" pseudo="true"/>',
      '</scriptproperties>',
    ].join('\n'),
  },
  readImport: () => undefined,
});

const element = (name: string, documentation: string, attributes: string[]): string =>
  `<xs:element name="${name}"><xs:annotation><xs:documentation>${documentation}</xs:documentation></xs:annotation><xs:complexType>${attributes.join('')}</xs:complexType></xs:element>`;
const attribute = (name: string, type: string, documentation = ''): string =>
  `<xs:attribute name="${name}" type="${type}">${documentation ? `<xs:annotation><xs:documentation>${documentation}</xs:documentation></xs:annotation>` : ''}</xs:attribute>`;
const multiple = attribute('multiple', 'findmultiple');

const schema = new XsdSchema('text', [
  {
    path: 'text.xsd',
    text: [
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">',
      '  <xs:simpleType name="expression"><xs:restriction base="xs:string"/></xs:simpleType>',
      '  <xs:simpleType name="lvalueexpression"><xs:restriction base="expression"/></xs:simpleType>',
      '  <xs:simpleType name="lvaluename"><xs:restriction base="lvalueexpression"/></xs:simpleType>',
      '  <xs:simpleType name="groupname"><xs:restriction base="lvalueexpression"/></xs:simpleType>',
      '  <xs:simpleType name="countresult"><xs:restriction base="lvaluename"/></xs:simpleType>',
      '  <xs:simpleType name="findmultiple"><xs:restriction base="xs:string"/></xs:simpleType>',
      '  <xs:element name="actions"><xs:complexType><xs:choice maxOccurs="unbounded">',
      element('create_ship', 'Create a ship', [attribute('name', 'lvaluename'), attribute('groupname', 'lvalueexpression')]),
      element('add_to_group', 'Add an object to a group', [attribute('target', 'groupname')]),
      element('find_object_component', 'Find matching component(s) contained in an object', [attribute('name', 'lvaluename'), multiple]),
      element('find_ship_by_true_owner', 'Find matching ship(s) by true owner faction', [attribute('name', 'lvaluename'), multiple]),
      element('count_ships', 'Count matching ships', [attribute('result', 'countresult'), multiple]),
      element('get_control_entities', 'Get all control entities of the specified object', [
        attribute('name', 'lvaluename'),
        attribute('multiple', 'xs:boolean', 'If true then the result is a list of control entities, otherwise a random one (default is true)'),
      ]),
      element('get_definition', 'Get a macro by filtering via category parameters', [
        attribute('macro', 'expression', "Result macro (list if 'multiple' is true)"),
        attribute('multiple', 'xs:boolean', 'If true, the result values return a list. If false (default), a single value.'),
      ]),
      element('get_factions_by_tag', 'Get factions by matching tag', [attribute('result', 'lvaluename')]),
      element('create_orientation', 'Create an orientation(rotation) value. refobject takes priority', [attribute('name', 'lvaluename')]),
      element('create_cue_actor', 'Create an actor object and associate it with this cue', [attribute('name', 'lvaluename')]),
      element('create_boarding_operation', 'Create a boarding operation', [attribute('result', 'lvaluename', 'Result operation')]),
      element('generate_loadout', 'Generate a loadout for a given object', [attribute('result', 'lvaluename', 'A list of loadouts that have been generated')]),
      element('drop_cargo', 'Drop ware from cargo bay', [
        attribute('wares', 'expression', 'Name of the value that will receive a list of all spawned ware types (optional)'),
      ]),
      element('find_closest_resource', 'Find closest resource', [
        attribute('sector', 'lvalueexpression'),
        attribute('wares', 'expression', '(optional, resultvalue) list of all the resources'),
      ]),
      element('find_npc_slot', 'Find npc slot in a controllable object', [attribute('name', 'lvaluename'), multiple]),
      element('do_for_each', 'Traverse a list, group or table.', [attribute('name', 'lvaluename', 'Name of the element/key variable')]),
      element('launch_masstraffic_drone', 'Launch a ship of the specified ship group from masstraffic docks', [attribute('name', 'lvaluename')]),
      element('create_npc_template', 'Create a NPC template entry', [attribute('name', 'lvaluename')]),
      '  </xs:choice></xs:complexType></xs:element>',
      '</xs:schema>',
    ].join('\n'),
  },
]);

const actions = schema.root('actions') as XsdElement;

/** What the attribute of the element written in `xml` gives: `type source`, `(guessed)` when guessed; `-` for nothing. */
function written(xml: string, attributeName: string, guess = true): string {
  const instance = parseXml(xml).roots[0];
  const declaration = actions.child(instance.name) as XsdElement;
  const type = writtenTypeOf(instance, attributeName, declaration, properties, guess);
  return type ? `${type.name} ${type.source}${type.guessed ? ' (guessed)' : ''}` : '-';
}

describe('result types of actions', () => {
  it('reads what the schema states: groups, and counts that are lists when multiple holds', () => {
    expect(schema.problems).toEqual([]);
    expect(written('<create_ship name="$s" groupname="$g"/>', 'groupname')).toBe('group schema');
    expect(written('<add_to_group target="$g"/>', 'target')).toBe('group schema');
    expect(written('<count_ships result="$s"/>', 'result')).toBe('list multiple');
    expect(written('<count_ships result="$s"/>', 'result', false)).toBe('list multiple');
    expect(written('<count_ships result="$s" multiple="false"/>', 'result')).toBe('ship element name (guessed)');
    expect(written('<count_ships result="$s" multiple="false"/>', 'result', false)).toBe('-');
  });

  it("guesses from the element's name: its head noun, before a preposition", () => {
    expect(written('<create_ship name="$s"/>', 'name')).toBe('ship element name (guessed)');
    expect(written('<create_ship name="$s"/>', 'name', false)).toBe('-');
    expect(written('<find_object_component name="$c"/>', 'name')).toBe('component element name (guessed)');
    expect(written('<find_ship_by_true_owner name="$s"/>', 'name')).toBe('ship element name (guessed)');
    expect(written('<find_closest_resource sector="$s"/>', 'sector')).toBe('sector attribute name (guessed)');
    // A plural is a list, unless `multiple` decides.
    expect(written('<get_factions_by_tag result="$f"/>', 'result')).toBe('list element name (guessed)');
    // Not a datatype: no guess.
    expect(written('<find_npc_slot name="$n" multiple="false"/>', 'name')).toBe('-');
    expect(written('<create_cue_actor name="$a"/>', 'name')).toBe('-');
    expect(written('<create_npc_template name="$t"/>', 'name')).toBe('-');
  });

  it('makes a list of what an element with multiple finds when it holds, by its documented default', () => {
    expect(written('<find_object_component name="$c" multiple="true"/>', 'name')).toBe('list multiple (guessed)');
    expect(written('<find_object_component name="$c" multiple="1"/>', 'name')).toBe('list multiple (guessed)');
    expect(written('<find_object_component name="$c" multiple="0"/>', 'name')).toBe('component element name (guessed)');
    expect(written('<find_object_component name="$c" multiple="$many"/>', 'name')).toBe('-');
    expect(written('<find_object_component name="$c" multiple="true"/>', 'name', false)).toBe('-');
    expect(written('<get_control_entities name="$e"/>', 'name')).toBe('list multiple (guessed)');
    expect(written('<get_control_entities name="$e" multiple="false"/>', 'name')).toBe('entity element name (guessed)');
    expect(written('<get_definition macro="$m"/>', 'macro')).toBe('-');
    expect(written('<get_definition macro="$m" multiple="true"/>', 'macro')).toBe('list multiple (guessed)');
    const declaration = actions.child('get_control_entities') as XsdElement;
    expect(multipleOf(parseXml('<get_control_entities multiple="tr').roots[0], declaration)).toBeUndefined();
  });

  it("guesses from the documentation: the attribute's, then the element's after a verb that makes something", () => {
    expect(written('<generate_loadout result="$l"/>', 'result')).toBe('list attribute documentation (guessed)');
    expect(written('<drop_cargo wares="$w"/>', 'wares')).toBe('list attribute documentation (guessed)');
    expect(written('<find_closest_resource wares="$w"/>', 'wares')).toBe('list attribute documentation (guessed)');
    // The name's type where it is narrower than the documentation's.
    expect(written('<create_boarding_operation result="$o"/>', 'result')).toBe('boardingoperation element name (guessed)');
    expect(written('<create_orientation name="$r"/>', 'name')).toBe('rotation element documentation (guessed)');
    expect(written('<launch_masstraffic_drone name="$d"/>', 'name')).toBe('ship element documentation (guessed)');
    // "Traverse a list": the element's object is not what it gives.
    expect(written('<do_for_each name="$x"/>', 'name')).toBe('-');
  });
});
