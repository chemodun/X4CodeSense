import { describe, expect, it } from 'vitest';
import { compileContentModel, type ElementParticle, type Particle } from '../src/xsd/contentModel';
import type { XsdElement } from '../src/xsd/schema';

function element(name: string, min = 1, max = 1): ElementParticle {
  return { kind: 'element', declaration: { name } as unknown as XsdElement, min, max };
}

function sequence(particles: Particle[], min = 1, max = 1): Particle {
  return { kind: 'sequence', particles, min, max };
}

function choice(particles: Particle[], min = 1, max = 1): Particle {
  return { kind: 'choice', particles, min, max };
}

function all(particles: Particle[], min = 1): Particle {
  return { kind: 'all', particles, min, max: 1 };
}

describe('content model', () => {
  it('allows no children when there is no particle', () => {
    const model = compileContentModel(undefined);
    expect(model.declarations.size).toBe(0);
    expect(model.validate([])).toEqual([]);
    expect(model.validate(['a'])).toEqual([{ index: 0, expected: [] }]);
    expect(model.expectedAfter([])).toEqual([]);
  });

  it('checks a sequence of optional elements', () => {
    const model = compileContentModel(sequence([element('conditions', 0), element('delay', 0), element('actions', 0), element('cues', 0)]));
    expect([...model.declarations.keys()]).toEqual(['conditions', 'delay', 'actions', 'cues']);
    expect(model.validate([])).toEqual([]);
    expect(model.validate(['actions'])).toEqual([]);
    expect(model.validate(['conditions', 'cues'])).toEqual([]);
    expect(model.validate(['actions', 'conditions'])).toEqual([{ index: 1, expected: ['cues'] }]);
    expect(model.validate(['cues', 'cues'])).toEqual([{ index: 1, expected: [] }]);
    expect(model.expectedAfter([])).toEqual(['actions', 'conditions', 'cues', 'delay']);
    expect(model.expectedAfter(['delay'])).toEqual(['actions', 'cues']);
  });

  it('requires mandatory elements', () => {
    const model = compileContentModel(sequence([element('params', 0), element('attention', 1, Infinity)]));
    expect(model.validate([])).toEqual([{ index: 0, expected: ['attention', 'params'] }]);
    expect(model.validate(['params'])).toEqual([{ index: 1, expected: ['attention'] }]);
    expect(model.validate(['attention', 'attention'])).toEqual([]);
    expect(model.validate(['params', 'attention'])).toEqual([]);
  });

  it('repeats an unbounded choice in any order and skips an unknown child', () => {
    const model = compileContentModel(choice([element('a'), element('b')], 0, Infinity));
    expect(model.validate(['b', 'a', 'a'])).toEqual([]);
    expect(model.validate(['c'])).toEqual([{ index: 0, expected: ['a', 'b'] }]);
    expect(model.validate(['a', 'c', 'b'])).toEqual([{ index: 1, expected: ['a', 'b'] }]);
    expect(model.expectedAfter(['a', 'c'])).toEqual(['a', 'b']);
  });

  it('handles an optional group at the start of a sequence', () => {
    const createShip = sequence([
      sequence([element('select', 0), choice([element('owner'), element('pilot')], 0, Infinity)]),
      element('position', 0),
      element('rotation', 0),
    ]);
    const model = compileContentModel(createShip);
    expect(model.validate(['position'])).toEqual([]);
    expect(model.validate(['owner', 'owner', 'rotation'])).toEqual([]);
    expect(model.validate(['select', 'pilot', 'position', 'rotation'])).toEqual([]);
    expect(model.validate(['rotation', 'position'])).toEqual([{ index: 1, expected: [] }]);
    expect(model.validate(['select', 'position', 'owner'])).toEqual([{ index: 2, expected: ['rotation'] }]);
    expect(model.expectedAfter(['position'])).toEqual(['rotation']);
  });

  it('nests a repeated sequence', () => {
    const model = compileContentModel(sequence([element('key'), element('value')], 1, Infinity));
    expect(model.validate(['key', 'value', 'key', 'value'])).toEqual([]);
    expect(model.validate(['key', 'value', 'key'])).toEqual([{ index: 3, expected: ['value'] }]);
    expect(model.validate([])).toEqual([{ index: 0, expected: ['key'] }]);
  });

  it('validates an all group', () => {
    const model = compileContentModel(all([element('people', 0), element('wares', 0), element('reward')]));
    expect(model.validate(['reward'])).toEqual([]);
    expect(model.validate(['wares', 'reward', 'people'])).toEqual([]);
    expect(model.validate([])).toEqual([{ index: 0, expected: ['reward'] }]);
    expect(model.validate(['reward', 'reward'])).toEqual([{ index: 1, expected: ['people', 'wares'] }]);
    expect(model.validate(['bogus', 'reward'])).toEqual([{ index: 0, expected: ['people', 'reward', 'wares'] }]);
    expect(model.expectedAfter(['reward'])).toEqual(['people', 'wares']);
    expect([...model.declarations.keys()]).toEqual(['people', 'wares', 'reward']);
  });

  it('lets an optional all group be empty', () => {
    const model = compileContentModel(all([element('reward')], 0));
    expect(model.validate([])).toEqual([]);
    expect(model.validate(['reward'])).toEqual([]);
  });
});
