import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  attributeNamed,
  chainAtCaret,
  chainAtToken,
  completeChain,
  loadScriptProperties,
  parseExpression,
  parseSegments,
  parseXml,
  resolveChain,
  resolvedChainOf,
  ScriptProperties,
  selectElements,
  selectValue,
  type PropertySource,
  type ResolvedChain,
  type ScriptSchema,
} from '../src';

const libraries = fileURLToPath(new URL('./fixtures/unpacked/libraries', import.meta.url));

function readImport(source: string): PropertySource | undefined {
  const file = path.join(libraries, source);
  return existsSync(file) ? { path: file, text: readFileSync(file, 'utf8') } : undefined;
}

const mainPath = path.join(libraries, 'scriptproperties.xml');
const properties = ScriptProperties.parse({ main: { path: mainPath, text: readFileSync(mainPath, 'utf8') }, readImport });

describe('miniXPath', () => {
  const waresText = readFileSync(path.join(libraries, 'wares.xml'), 'utf8');
  const wares = parseXml(waresText);
  const ids = (expression: string): string[] => selectElements(wares, expression).map((element) => attributeNamed(element, 'id')?.value ?? '');

  it('selects children, wildcards, descendants and predicates', () => {
    expect(ids('/wares/ware')).toEqual(['energycells', 'ore', 'secret']);
    expect(selectElements(wares, '/wares/*').length).toBe(3);
    expect(selectElements(wares, '//price').length).toBe(1);
    expect(ids("/wares/ware[@transport='solid']")).toEqual(['ore']);
    expect(ids('/wares/ware[@transport=\'solid\' or @id="energycells"]')).toEqual(['energycells', 'ore']);
    expect(ids("/wares/ware[@transport='solid' and @volume='10']")).toEqual(['ore']);
    expect(ids('/wares/ware[not(@hidden)]')).toEqual(['energycells', 'ore']);
    expect(ids('/wares/ware[@hidden]')).toEqual(['secret']);
    expect(ids("/wares/ware[substring(@id, string-length(@id) - string-length('cells') + 1) = 'cells']")).toEqual(['energycells']);
    expect(ids('/nothing/ware')).toEqual([]);
    expect(() => selectElements(wares, '/wares/ware[@id]]')).toThrow();
    expect(() => selectElements(wares, '/wares/ware[frobnicate(@id)]')).toThrow();
  });

  it('reads attribute and text results', () => {
    const schemaText = readFileSync(path.join(libraries, 'common.xsd'), 'utf8');
    const schema = parseXml(schemaText);
    const enumerations = selectElements(schema, "/xs:schema/xs:simpleType[@name='classlookup']//xs:enumeration");
    expect(enumerations.map((element) => selectValue(element, '@value', schemaText))).toEqual(['ship', 'station']);
    expect(selectValue(enumerations[0], 'xs:annotation/xs:documentation/text()', schemaText)).toBe('Any ship');
    expect(selectValue(enumerations[1], 'xs:annotation/xs:documentation/text()', schemaText)).toBe('');
    expect(selectValue(enumerations[0], '', schemaText)).toBe('');
    expect(selectValue(enumerations[0], '@missing', schemaText)).toBe('');
  });
});

describe('ScriptProperties', () => {
  it('reads datatypes with supertypes, suffixes and pseudo flags', () => {
    expect(properties.problems).toEqual([]);
    const ship = properties.datatype('ship');
    expect(ship?.supertype?.name).toBe('container');
    expect(ship?.isA('component')).toBe(true);
    expect(ship?.isA('sector')).toBe(false);
    expect(properties.datatype('time')?.suffix).toBe('s');
    expect(properties.datatype('npctemplateentry')?.pseudo).toBe(true);
    expect(ship?.pseudo).toBe(false);
    expect([...(ship?.allProperties() ?? [])].map((property) => property.name)).toEqual([
      'pilot',
      'speed',
      'dock',
      'dock.{$docksize}',
      'cargo.{$ware}.count',
      'cargo.list',
      'owner',
      'exists',
      'name',
      'isclass.{$class}',
      'isclass.{$list}',
      'isclass.<classname>',
      'distanceto.[$component, $position]',
      'sector',
    ]);
    expect(ship?.property('owner')?.owner.name).toBe('object');
    expect(ship?.property('nope')).toBeUndefined();
    expect(path.basename(ship?.location?.file ?? '')).toBe('scriptproperties.xml');
  });

  it('splits property names into segments', () => {
    expect(parseSegments('cargo.{$ware}.count')).toEqual([
      { kind: 'literal', text: 'cargo' },
      { kind: 'expression', type: 'ware' },
      { kind: 'literal', text: 'count' },
    ]);
    expect(parseSegments('$<variable>')).toEqual([{ kind: 'variable', name: 'variable' }]);
    expect(parseSegments('{$numeric}')).toEqual([{ kind: 'expression', type: 'numeric' }]);
    expect(parseSegments('<mdscriptname>.<cuename>')).toEqual([
      { kind: 'any', name: 'mdscriptname' },
      { kind: 'any', name: 'cuename' },
    ]);
    expect(parseSegments('distanceto.[$component, $position]')).toEqual([
      { kind: 'literal', text: 'distanceto' },
      { kind: 'args', text: '[$component, $position]' },
    ]);
    expect(parseSegments('[$arg1, $arg2, ...]')).toEqual([{ kind: 'args', text: '[$arg1, $arg2, ...]' }]);
  });

  it('reads keywords per script kind', () => {
    expect(properties.keyword('this', 'md')?.typeName).toBe('cue');
    expect(properties.keyword('this', 'aiscripts')?.typeName).toBe('entity');
    expect(properties.keyword('this')).toBeUndefined();
    expect(properties.keyword('player', 'md')?.properties.size).toBe(3);
    expect(properties.keywordsFor('md').map((keyword) => keyword.name)).toEqual(['player', 'true', 'this', 'class', 'ware', 'skilltype', 'tag', 'md']);
    expect(properties.keywordsFor('aiscripts').map((keyword) => keyword.name)).toEqual(['player', 'true', 'this', 'class', 'ware', 'skilltype', 'tag']);
    expect(properties.keyword('true', 'md')?.type?.name).toBe('boolean');
  });

  it('imports keyword values from other files', () => {
    const classes = properties.keyword('class', 'md');
    expect([...(classes?.properties.keys() ?? [])]).toEqual(['ship', 'station']);
    expect(classes?.properties.get('ship')?.result).toBe('Any ship');
    expect(classes?.properties.get('ship')?.type).toBe('class');
    expect(path.basename(classes?.properties.get('ship')?.location?.file ?? '')).toBe('common.xsd');
    const wares = properties.keyword('ware', 'md');
    expect([...(wares?.properties.keys() ?? [])]).toEqual(['energycells', 'ore']);
    expect(wares?.properties.get('ore')?.result).toBe('{20201,3701}');
    expect(properties.sources.has(path.join(libraries, 'wares.xml'))).toBe(true);
  });

  it('loads the additions and reports their missing sources', () => {
    const loaded = loadScriptProperties(libraries);
    expect(loaded?.keyword('relationrange', 'md')).toBeDefined();
    expect(loaded?.problems.some((problem) => problem.includes("'factions.xsd'") && problem.includes('missing'))).toBe(true);
    expect(loaded?.problems.some((problem) => problem.includes("'licencetype'") && problem.includes('selected nothing'))).toBe(true);
    expect(loadScriptProperties(path.join(libraries, 'nowhere'))).toBeUndefined();
  });
});

describe('property chains', () => {
  function texts(expression: string, offset: number): string[] | undefined {
    return chainAtCaret(expression, offset)?.steps.map((step) => step.text);
  }

  it('cuts the chain at a caret', () => {
    const afterDot = chainAtCaret('player.ship.', 12);
    expect(afterDot?.steps.map((step) => step.text)).toEqual(['player', 'ship']);
    expect(afterDot?.partial).toEqual({ text: '', start: 12, end: 12 });
    expect(chainAtCaret('player.ship.pil', 15)?.partial).toEqual({ text: 'pil', start: 12, end: 15 });
    expect(chainAtCaret('player.ship.pilot', 14)?.partial).toEqual({ text: 'pi', start: 12, end: 17 });
    expect(chainAtCaret('player', 6)).toBeUndefined();
    expect(chainAtCaret('a.b', 1)).toBeUndefined();
    expect(texts('$a + player.ship.cargo.{$ware}.', 31)).toEqual(['player', 'ship', 'cargo', '{$ware}']);
    const format = chainAtCaret("'%s'.[$x].", 10);
    expect(format?.steps.map((step) => step.kind)).toEqual(['string', 'brackets']);
    expect(texts('(1 + 2).', 8)).toEqual(['(1 + 2)']);
  });

  it('finds the chain around a token for hover, the steps after it included', () => {
    const found = chainAtToken('$a + player.ship.pilot.name', 20);
    expect(found?.chain.steps.map((step) => step.text)).toEqual(['player', 'ship', 'pilot', 'name']);
    expect(found?.stepIndex).toBe(2);
    expect(chainAtToken('$x.isclass.{$y}', 5)?.chain.steps.map((step) => step.text)).toEqual(['$x', 'isclass', '{$y}']);
    expect(chainAtToken('$x.isclass.{$y}', 13)?.chain.steps.map((step) => step.text)).toEqual(['$y']);
    expect(chainAtToken('player.ship', 6)).toBeUndefined();
    expect(chainAtToken('$x', 1)?.chain.steps.map((step) => step.text)).toEqual(['$x']);
  });

  /** Resolves the whole expression as a chain, whatever its last step is. */
  function resolve(expression: string, schema: ScriptSchema = 'md'): ResolvedChain {
    const chain = chainAtCaret(`${expression}.`, expression.length + 1);
    if (!chain) {
      throw new Error(`no chain in ${expression}`);
    }
    return resolveChain(chain, properties, schema);
  }

  function summary(resolved: ResolvedChain): string[] {
    return resolved.steps.map((step) => {
      if (step.keyword) {
        return `keyword ${step.keyword.name}`;
      }
      if (step.property) {
        return `${step.property.owner.name}.${step.property.name}`;
      }
      if (step.candidates) {
        return `candidates ${step.candidates.length}`;
      }
      return '?';
    });
  }

  it('resolves keywords, properties, placeholders and literals', () => {
    const cargo = resolve('player.ship.cargo.{$ware}.count');
    expect(summary(cargo)).toEqual([
      'keyword player',
      'player.ship',
      'container.cargo.{$ware}.count',
      'container.cargo.{$ware}.count',
      'container.cargo.{$ware}.count',
    ]);
    expect(cargo.steps[4].datatype?.name).toBe('integer');
    expect(cargo.owners.map((owner) => owner.kind)).toEqual(['unknown', 'keyword', 'datatype', 'datatype', 'datatype', 'datatype']);

    // A bare value goes to the shortcut the script properties declare for it.
    expect(summary(resolve('player.ship.isclass.ship'))).toEqual([
      'keyword player',
      'player.ship',
      'component.isclass.<classname>',
      'component.isclass.<classname>',
    ]);
    expect(summary(resolve('player.ship.isclass.{class.ship}'))).toEqual([
      'keyword player',
      'player.ship',
      'component.isclass.{$class}',
      'component.isclass.{$class}',
    ]);
    expect(summary(resolve('player.ship.isclass.[class.ship, class.station]'))).toEqual([
      'keyword player',
      'player.ship',
      'component.isclass.{$class}',
      'component.isclass.{$class}',
    ]);
    expect(summary(resolve("'%s'.[$a]"))).toEqual(['?', 'string.[$arg1, $arg2, ...]']);
    expect(summary(resolve('player.ship.distanceto.[$other]'))).toEqual([
      'keyword player',
      'player.ship',
      'component.distanceto.[$component, $position]',
      'component.distanceto.[$component, $position]',
    ]);
    expect(summary(resolve('tag.anything'))).toEqual(['keyword tag', 'tag.<tagname>']);
    expect(summary(resolve('md.Script.Cue.$var'))).toEqual(['keyword md', 'md.<mdscriptname>.<cuename>', 'md.<mdscriptname>.<cuename>', 'cue.$<variable>']);
    expect(summary(resolve('this.$var'))).toEqual(['keyword this', 'cue.$<variable>']);
    expect(resolve('player.ship.isclass.ship').steps[3].datatype?.name).toBe('boolean');

    const literal = resolve("'abc'.len");
    expect(literal.steps[0].datatype?.name).toBe('string');
    expect(summary(literal)).toEqual(['?', 'string.len']);
    const time = resolve('10s.ms');
    expect(time.steps[0].datatype?.name).toBe('time');
    expect(time.steps[1].datatype?.name).toBe('integer');
    expect(resolve('[1, 2].count').steps[1].datatype?.name).toBe('integer');

    expect(summary(resolve('player.entity.skill.piloting'))).toEqual([
      'keyword player',
      'player.entity',
      'entity.skill.<skillname>',
      'entity.skill.<skillname>',
    ]);
    expect(summary(resolve('player.ship.frobnicate.name'))).toEqual(['keyword player', 'player.ship', '?', 'candidates 2']);
  });

  it('looks on subtypes and follows a common type of several candidates', () => {
    expect(summary(resolve('this.controlled.cargo.list', 'aiscripts'))).toEqual([
      'keyword this',
      'entity.controlled',
      'container.cargo.list',
      'container.cargo.list',
    ]);
    expect(summary(resolve('this.name', 'md'))).toEqual(['keyword this', 'cue.name']);
    expect(summary(resolve('this.name', 'aiscripts'))).toEqual(['keyword this', 'component.name']);
    const variable = resolve('$ship.pilot');
    expect(summary(variable)).toEqual(['?', 'ship.pilot']);
    expect(variable.steps[1].datatype?.name).toBe('entity');
    const ambiguous = resolve('$x.name.len');
    expect(summary(ambiguous)).toEqual(['?', 'candidates 2', 'string.len']);
    expect(ambiguous.steps[1].datatype?.name).toBe('string');
    // `.$key` on an unknown owner: the fixture has one variable-holding datatype, so it is the sole candidate.
    expect(resolve('$t.$key.count').steps.map((step) => step.property?.name)).toEqual([undefined, '$<variable>', 'count']);
  });

  function complete(expression: string): string[] {
    const chain = chainAtCaret(expression, expression.length);
    if (!chain) {
      throw new Error(`no chain in ${expression}`);
    }
    return completeChain(chain, properties, 'md').map((completion) => completion.label);
  }

  it('completes the next segment of matching properties', () => {
    expect(complete('player.')).toEqual(['ship', 'entity', 'money']);
    expect(complete('player.ship.')).toEqual(['pilot', 'speed', 'dock', 'cargo', 'owner', 'exists', 'name', 'isclass', 'distanceto', 'sector']);
    expect(complete('tag.')).toEqual(['{$enum}']);
    expect(complete('md.')).toEqual([]);
    expect(complete('player.ship.distanceto.')).toEqual([]);
    // No bare wares: `cargo.{$ware}.count` has no shortcut that takes them.
    expect(complete('player.ship.cargo.')).toEqual(['{$ware}', 'list']);
    expect(complete('player.ship.cargo.{$ware}.')).toEqual(['count']);
    expect(complete('player.ship.isclass.')).toEqual(['{$class}', '{$list}', 'ship', 'station']);
    expect(complete('player.ship.ca')).toEqual(['cargo']);
    expect(complete('player.entity.controlled.')).toContain('cargo');
    expect(complete('$x.')).toContain('pilot');
    expect(complete('$x.')).toContain('count');
    expect(complete('$x.name.')).toEqual(['len']);
    const chain = chainAtCaret('player.ship.', 12);
    const cargo = chain && completeChain(chain, properties, 'md').find((completion) => completion.label === 'cargo');
    expect(cargo?.continues).toBe(true);
    expect(cargo?.property.name).toBe('cargo.{$ware}.count');
  });

  it('names every property that fits as well, and takes bare values only through a declared shortcut', () => {
    // An unknown owner: the steps after `isclass` decide; without them `isclass` would take a `{$numeric}` of a list.
    expect(summary(resolve('$x.isclass.{$y}'))).toEqual(['?', 'candidates 2', 'candidates 2']);
    // A known owner: the first property decides the type, the other one that fits as well is named beside it.
    const known = resolve('player.ship.isclass.{$y}');
    expect(known.steps[2].property?.name).toBe('isclass.{$class}');
    expect(known.steps[2].candidates?.map((candidate) => candidate.name)).toEqual(['isclass.{$class}', 'isclass.{$list}']);
    expect(known.steps[3].datatype?.name).toBe('boolean');
    expect(resolve('player.ship.isclass.ship').steps[2].candidates).toBeUndefined();
    // A bare ware where no shortcut takes one.
    expect(resolve('player.ship.cargo.energycells.count').steps[2].property).toBeUndefined();
  });

  it('completes a property that starts with a name written on an unknown owner', () => {
    expect(complete('$x.isclass.')).toEqual(['{$class}', '{$list}', 'ship', 'station']);
    // After it the value is a boolean, which has no properties here.
    expect(complete('$x.isclass.{$c}.')).toEqual([]);
    expect(complete('$x.frobnicate.')).toContain('pilot');
    expect(complete('$x.frobnicate.')).not.toContain('{$class}');
  });

  it('prefers a literal property over a placeholder taking a bare name, and accepts a prefix of a pattern', () => {
    expect(summary(resolve('player.ship.dock.container.name'))).toEqual([
      'keyword player',
      'player.ship',
      'ship.dock',
      'dockingbay.container',
      'component.name',
    ]);
    expect(summary(resolve('player.ship.dock.{$size}.container'))).toEqual([
      'keyword player',
      'player.ship',
      'ship.dock.{$docksize}',
      'ship.dock.{$docksize}',
      'dockingbay.container',
    ]);
    const prefix = resolve('player.ship.owner.haslicence.{$licence}');
    expect(summary(prefix)).toEqual([
      'keyword player',
      'player.ship',
      'object.owner',
      'faction.haslicence.<licencetype>.{$faction}',
      'faction.haslicence.<licencetype>.{$faction}',
    ]);
    expect(prefix.steps[4].datatype).toBeUndefined();
    expect(summary(resolve('player.ship.frobnicate'))).toEqual(['keyword player', 'player.ship', '?']);
  });

  it('resolves a chain of a parsed value once for all who ask, and again for another script kind', () => {
    const text = '$a + player.ship.pilot';
    const tree = parseExpression(text).expression;
    if (tree.kind !== 'binary') {
      throw new Error('a sum expected');
    }
    const first = resolvedChainOf(tree.right, text, properties, 'md');
    expect(first.steps.map((step) => step.text)).toEqual(['player', 'ship', 'pilot']);
    expect(summary(first.resolved)).toEqual(summary(resolve('player.ship.pilot')));
    expect(resolvedChainOf(tree.right, text, properties, 'md')).toBe(first);
    const aiscript = resolvedChainOf(tree.right, text, properties, 'aiscript');
    expect(aiscript).not.toBe(first);
    expect(summary(aiscript.resolved)).toEqual(summary(resolve('player.ship.pilot', 'aiscript')));
    // A lone head is a chain of one step.
    expect(summary(resolvedChainOf(tree.left, text, properties, 'md').resolved)).toEqual(['?']);
  });
});
