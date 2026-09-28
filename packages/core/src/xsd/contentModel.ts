/**
 * Content models of XSD complex types, compiled to a small automaton over child element names.
 *
 * A model answers two questions for a parent element: is this list of children allowed, and which
 * names may come next after a given prefix of children. The second one drives element completion.
 */
import type { XsdElement } from './schema';

export interface ElementParticle {
  kind: 'element';
  declaration: XsdElement;
  min: number;
  max: number;
}

export interface GroupParticle {
  kind: 'sequence' | 'choice' | 'all';
  particles: Particle[];
  min: number;
  max: number;
}

export type Particle = ElementParticle | GroupParticle;

export interface ContentProblem {
  /** Index of the offending child, or the number of children when required children are missing at the end. */
  index: number;
  /** Element names that would have been valid at that place, sorted. */
  expected: string[];
}

export interface ContentModel {
  /** Child declarations by name. Empty when the element allows no children. */
  readonly declarations: ReadonlyMap<string, XsdElement>;
  /** Problems in a list of child names, in order. An offending child is skipped and checking goes on. */
  validate(children: readonly string[]): ContentProblem[];
  /** Names that may follow the given children, sorted. Unknown children are skipped. */
  expectedAfter(children: readonly string[]): string[];
}

function collectDeclarations(particle: Particle | undefined, into: Map<string, XsdElement>): void {
  if (!particle) {
    return;
  }
  if (particle.kind === 'element') {
    if (!into.has(particle.declaration.name)) {
      into.set(particle.declaration.name, particle.declaration);
    }
    return;
  }
  for (const child of particle.particles) {
    collectDeclarations(child, into);
  }
}

interface State {
  edges: Map<string, number[]>;
  epsilon: number[];
}

interface DfaState {
  set: number[];
  accepting: boolean;
  next: Map<string, DfaState | null>;
  expected?: string[];
}

/** Thompson construction over the particle tree, determinised lazily while matching. */
class Automaton implements ContentModel {
  readonly declarations: ReadonlyMap<string, XsdElement>;
  private readonly states: State[] = [];
  private readonly start: number;
  private readonly final: number;
  private readonly closures = new Map<number, number[]>();
  private readonly dfa = new Map<string, DfaState>();
  private initial: DfaState | undefined;

  constructor(particle: Particle | undefined) {
    const declarations = new Map<string, XsdElement>();
    collectDeclarations(particle, declarations);
    this.declarations = declarations;
    if (particle) {
      [this.start, this.final] = this.build(particle);
    } else {
      this.start = this.newState();
      this.final = this.newState();
      this.states[this.start].epsilon.push(this.final);
    }
  }

  private newState(): number {
    this.states.push({ edges: new Map(), epsilon: [] });
    return this.states.length - 1;
  }

  private build(particle: Particle): [number, number] {
    const start = this.newState();
    const end = this.newState();
    if (particle.kind === 'element') {
      this.states[start].edges.set(particle.declaration.name, [end]);
    } else if (particle.kind === 'sequence') {
      let current = start;
      for (const child of particle.particles) {
        const [childStart, childEnd] = this.build(child);
        this.states[current].epsilon.push(childStart);
        current = childEnd;
      }
      this.states[current].epsilon.push(end);
    } else {
      // A choice; a nested `all` is not valid XSD and is treated as a choice as well.
      if (particle.particles.length === 0) {
        this.states[start].epsilon.push(end);
      }
      for (const child of particle.particles) {
        const [childStart, childEnd] = this.build(child);
        this.states[start].epsilon.push(childStart);
        this.states[childEnd].epsilon.push(end);
      }
    }
    if (particle.min === 0) {
      this.states[start].epsilon.push(end);
    }
    if (particle.max > 1) {
      this.states[end].epsilon.push(start);
    }
    return [start, end];
  }

  private closure(state: number): number[] {
    let result = this.closures.get(state);
    if (result) {
      return result;
    }
    const seen = new Set<number>([state]);
    const pending = [state];
    while (pending.length > 0) {
      const current = pending.pop() as number;
      for (const target of this.states[current].epsilon) {
        if (!seen.has(target)) {
          seen.add(target);
          pending.push(target);
        }
      }
    }
    result = [...seen].sort((a, b) => a - b);
    this.closures.set(state, result);
    return result;
  }

  private dfaState(states: Iterable<number>): DfaState {
    const set = new Set<number>();
    for (const state of states) {
      for (const reached of this.closure(state)) {
        set.add(reached);
      }
    }
    const sorted = [...set].sort((a, b) => a - b);
    const key = sorted.join(',');
    let result = this.dfa.get(key);
    if (!result) {
      result = { set: sorted, accepting: set.has(this.final), next: new Map() };
      this.dfa.set(key, result);
    }
    return result;
  }

  private initialState(): DfaState {
    if (!this.initial) {
      this.initial = this.dfaState([this.start]);
    }
    return this.initial;
  }

  private step(from: DfaState, name: string): DfaState | null {
    let next = from.next.get(name);
    if (next !== undefined) {
      return next;
    }
    const targets: number[] = [];
    for (const state of from.set) {
      const edge = this.states[state].edges.get(name);
      if (edge) {
        targets.push(...edge);
      }
    }
    next = targets.length > 0 ? this.dfaState(targets) : null;
    from.next.set(name, next);
    return next;
  }

  private expected(from: DfaState): string[] {
    if (!from.expected) {
      const names = new Set<string>();
      for (const state of from.set) {
        for (const name of this.states[state].edges.keys()) {
          names.add(name);
        }
      }
      from.expected = [...names].sort();
    }
    return from.expected;
  }

  validate(children: readonly string[]): ContentProblem[] {
    const problems: ContentProblem[] = [];
    let state = this.initialState();
    for (let index = 0; index < children.length; index++) {
      const next = this.step(state, children[index]);
      if (next) {
        state = next;
      } else {
        problems.push({ index, expected: this.expected(state) });
      }
    }
    if (!state.accepting) {
      problems.push({ index: children.length, expected: this.expected(state) });
    }
    return problems;
  }

  expectedAfter(children: readonly string[]): string[] {
    let state = this.initialState();
    for (const child of children) {
      state = this.step(state, child) ?? state;
    }
    return this.expected(state);
  }
}

/** An `xs:all` group: every child at most once, in any order. */
class AllModel implements ContentModel {
  readonly declarations: ReadonlyMap<string, XsdElement>;
  private readonly required: string[];

  constructor(private readonly particle: GroupParticle) {
    const declarations = new Map<string, XsdElement>();
    collectDeclarations(particle, declarations);
    this.declarations = declarations;
    this.required = particle.particles
      .filter((child): child is ElementParticle => child.kind === 'element' && child.min > 0)
      .map((child) => child.declaration.name)
      .sort();
  }

  private remaining(seen: ReadonlySet<string>): string[] {
    return [...this.declarations.keys()].filter((name) => !seen.has(name)).sort();
  }

  validate(children: readonly string[]): ContentProblem[] {
    const problems: ContentProblem[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < children.length; index++) {
      const name = children[index];
      if (!this.declarations.has(name) || seen.has(name)) {
        problems.push({ index, expected: this.remaining(seen) });
      } else {
        seen.add(name);
      }
    }
    const missing = this.required.filter((name) => !seen.has(name));
    if (missing.length > 0 && !(this.particle.min === 0 && seen.size === 0)) {
      problems.push({ index: children.length, expected: missing });
    }
    return problems;
  }

  expectedAfter(children: readonly string[]): string[] {
    return this.remaining(new Set(children));
  }
}

/** Compiles a particle tree (or nothing, for an element without children) into a content model. */
export function compileContentModel(particle: Particle | undefined): ContentModel {
  if (particle && particle.kind === 'all') {
    return new AllModel(particle);
  }
  return new Automaton(particle);
}
