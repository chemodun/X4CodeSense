/** Bridges the expression tree and the chain resolver: a chain of property, dynamic and args nodes as resolver steps. */
import type { Expression } from './parser';
import type { ChainStep } from './propertyChain';

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
