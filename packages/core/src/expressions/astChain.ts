/** Bridges the expression tree and the chain resolver: a chain of property, dynamic and args nodes as resolver steps. */
import type { ScriptDatatype, ScriptProperties } from '../properties/scriptProperties';
import type { ScriptSchema } from '../types';
import type { Expression } from './parser';
import { resolveChain, type ChainStep, type ResolvedChain, type StepTypes } from './propertyChain';

export type ChainNode = Extract<Expression, { kind: 'property' | 'dynamic' | 'args' }>;

export function isChainNode(node: Expression): node is ChainNode {
  return node.kind === 'property' || node.kind === 'dynamic' || node.kind === 'args';
}

/** The head of a chain: the node below all property, dynamic and args nodes. */
export function headOf(node: Expression): Expression {
  let current = node;
  while (isChainNode(current)) {
    current = current.object;
  }
  return current;
}

/** The chain steps of an outermost chain node, head first, in the form the resolver takes. */
export function stepsOf(outer: Expression, text: string): { head: Expression; steps: ChainStep[] } {
  const steps: ChainStep[] = [];
  let current: Expression = outer;
  while (isChainNode(current)) {
    const kind = current.kind === 'property' ? (current.name.startsWith('$') ? 'variable' : 'identifier') : current.kind === 'dynamic' ? 'braces' : 'brackets';
    const start = current.kind === 'property' ? current.nameStart : current.object.end + 1;
    steps.unshift({ kind, start, end: current.end, text: text.slice(start, current.end), suffix: '' });
    current = current.object;
  }
  const head = current;
  const headKind: ChainStep['kind'] =
    head.kind === 'name'
      ? 'identifier'
      : head.kind === 'variable'
        ? 'variable'
        : head.kind === 'string'
          ? 'string'
          : head.kind === 'number'
            ? 'number'
            : head.kind === 'list'
              ? 'brackets'
              : head.kind === 'textref'
                ? 'braces'
                : 'parens';
  steps.unshift({
    kind: headKind,
    start: head.start,
    end: head.end,
    text: text.slice(head.start, head.end),
    suffix: head.kind === 'number' ? head.suffix : '',
  });
  return { head, steps };
}

/** A chain of a parsed value: its head, its steps, and what they resolved to. */
export interface ResolvedChainNode {
  head: Expression;
  steps: ChainStep[];
  resolved: ResolvedChain;
}

interface Memo extends ResolvedChainNode {
  properties: ScriptProperties;
  schema: ScriptSchema;
  /** The types of the variable steps the resolution used, by step; empty when none had one. */
  types: (ScriptDatatype | undefined)[];
}

const resolvedByNode = new WeakMap<Expression, Memo>();
const noTypes: (ScriptDatatype | undefined)[] = [];

/**
 * `stepsOf` and `resolveChain` of an outermost chain node, or of a lone head, of a parsed value. The trees
 * of an analysis are shared (`parsedValue`), and so is this: the expression checks, the variables and the
 * semantic tokens resolve each chain once, unless the types of its variables differ from those it was
 * resolved with. `text` is the value the tree was parsed from. Callers must not change the result.
 */
export function resolvedChainOf(node: Expression, text: string, properties: ScriptProperties, schema: ScriptSchema, stepTypes?: StepTypes): ResolvedChainNode {
  const known = resolvedByNode.get(node);
  const { head, steps } = known ?? stepsOf(node, text);
  let types = noTypes;
  if (stepTypes) {
    for (let index = 0; index < steps.length; index++) {
      const type = steps[index].kind === 'variable' ? stepTypes(index, steps) : undefined;
      if (type) {
        if (types === noTypes) {
          types = [];
        }
        types[index] = type;
      }
    }
  }
  if (known && known.properties === properties && known.schema === schema && sameTypes(known.types, types, steps.length)) {
    return known;
  }
  const resolved = resolveChain({ steps }, properties, schema, types === noTypes ? undefined : (index) => types[index]);
  const chain: Memo = { head, steps, resolved, properties, schema, types };
  resolvedByNode.set(node, chain);
  return chain;
}

function sameTypes(a: readonly (ScriptDatatype | undefined)[], b: readonly (ScriptDatatype | undefined)[], length: number): boolean {
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}
