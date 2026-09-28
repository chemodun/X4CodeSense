import { describe, expect, it } from 'vitest';
import { parseExpression, walkExpression, type Expression } from '../src/expressions/parser';

/** Renders a tree as a compact s-expression for assertions. */
function print(node: Expression): string {
  switch (node.kind) {
    case 'number':
    case 'string':
      return node.text;
    case 'variable':
    case 'name':
      return node.name;
    case 'textref':
      return `{${print(node.page)},${print(node.id)}}`;
    case 'list':
      return `[${node.items.map(print).join(' ')}]`;
    case 'table':
      return `table[${node.entries.map((entry) => `${print(entry.key)}=${print(entry.value)}`).join(',')}]`;
    case 'property':
      return `(. ${print(node.object)} ${node.name})`;
    case 'dynamic':
      return `(.{ ${print(node.object)} ${print(node.key)})`;
    case 'args':
      return `(.[ ${print(node.object)} ${node.args.map(print).join(' ')})`;
    case 'call':
      return `(call ${node.name} ${node.args.map(print).join(' ')})`;
    case 'unary':
      return `(${node.operator} ${print(node.operand)})`;
    case 'exists':
      return `(? ${print(node.operand)})`;
    case 'cast':
      return `(cast ${print(node.operand)} ${node.suffix})`;
    case 'group':
      return `(group ${print(node.expression)})`;
    case 'binary':
      return `(${node.operator} ${print(node.left)} ${print(node.right)})`;
    case 'conditional':
      return `(if ${print(node.condition)} ${print(node.then)}${node.else ? ` ${print(node.else)}` : ''})`;
    case 'missing':
      return '<missing>';
  }
}

function tree(text: string): string {
  const parsed = parseExpression(text);
  expect(parsed.errors).toEqual([]);
  return print(parsed.expression);
}

function errors(text: string): string[] {
  return parseExpression(text).errors.map((error) => `${error.start}-${error.end} ${error.code}: ${error.message}`);
}

describe('parseExpression', () => {
  it('applies the operator precedence of the game', () => {
    expect(tree('1 + 2 * 3 ^ 2')).toBe('(+ 1 (* 2 (^ 3 2)))');
    expect(tree('8 / 2 / 2')).toBe('(/ (/ 8 2) 2)');
    expect(tree('$a lt $b == true and $c or $d')).toBe('(or (and (== (lt $a $b) true) $c) $d)');
    expect(tree('$a &lt; 3 or $b >= 4'.replace('&lt;', '<'))).toBe('(or (< $a 3) (>= $b 4))');
    expect(tree('not $a == $b')).toBe('(== (not $a) $b)');
    expect(tree('-$x * 2 + -1')).toBe('(+ (* (- $x) 2) (- 1))');
    expect(tree('typeof $x == datatype.list')).toBe('(== (typeof $x) (. datatype list))');
    expect(tree('$a % 2 != 0')).toBe('(!= (% $a 2) 0)');
  });

  it('parses conditionals, nested and without else', () => {
    expect(tree('if $a then 1 else 2')).toBe('(if $a 1 2)');
    expect(tree('if $a then 1')).toBe('(if $a 1)');
    expect(tree('if $a then 1 else if $b then 2 else 3')).toBe('(if $a 1 (if $b 2 3))');
    expect(tree('$a + (if $b then 1 else 2)')).toBe('(+ $a (group (if $b 1 2)))');
    expect(tree('if $a and $b then $c.name else $d')).toBe('(if (and $a $b) (. $c name) $d)');
  });

  it('parses property chains, dynamic keys, arguments and existence', () => {
    expect(tree('player.ship.cargo.{ware.energycells}.count')).toBe('(. (.{ (. (. player ship) cargo) (. ware energycells)) count)');
    expect(tree('$t.$k')).toBe('(. $t $k)');
    expect(tree("'%s: %s'.[$a, $b]")).toBe("(.[ '%s: %s' $a $b)");
    expect(tree('{1001, 5}.[$x]')).toBe('(.[ {1001,5} $x)');
    expect(tree('$x?')).toBe('(? $x)');
    expect(tree('$t.$key? and not $done')).toBe('(and (? (. $t $key)) (not $done))');
    expect(tree('@$a.b.c')).toBe('(@ (. (. $a b) c))');
    expect(tree('[1, 2].count')).toBe('(. [1 2] count)');
    expect(tree('$list.{$i}.name')).toBe('(. (.{ $list $i) name)');
    expect(tree('position.[$x, 0, $z]')).toBe('(.[ position $x 0 $z)');
    expect(tree('this.$Definition.$lines.{1}.$delay?')).toBe('(? (. (.{ (. (. this $Definition) $lines) 1) $delay))');
  });

  it('parses lists, tables, calls, casts and literals', () => {
    expect(tree('[]')).toBe('[]');
    expect(tree("['a', 'b', ]")).toBe("['a' 'b']");
    expect(tree('table[]')).toBe('table[]');
    expect(tree("table[$a = 1, {faction.argon} = 'x', $t = table[$n = []]]")).toBe("table[$a=1,(group (. faction argon))='x',$t=table[$n=[]]]");
    expect(tree('sin($a + 180deg)')).toBe('(call sin (+ $a 180deg))');
    expect(tree('abs(event.object.seed) % 10')).toBe('(% (call abs (. (. event object) seed)) 10)');
    expect(tree('($x)s')).toBe('(cast $x s)');
    expect(tree('(1 + 1)f')).toBe('(cast (+ 1 1) f)');
    expect(tree('($a + $b).min')).toBe('(. (group (+ $a $b)) min)');
    expect(tree('0xCAFE + 1.5e3LF')).toBe('(+ 0xCAFE 1.5e3LF)');
    expect(tree("'it\\'s'")).toBe("'it\\'s'");
    expect(tree('null')).toBe('null');
  });

  it('records spans', () => {
    const parsed = parseExpression('  $a + $b.c ');
    expect(parsed.expression).toMatchObject({ kind: 'binary', start: 2, end: 11 });
    const right = parsed.expression.kind === 'binary' ? parsed.expression.right : undefined;
    expect(right).toMatchObject({ kind: 'property', nameStart: 10, nameEnd: 11 });
    const names: string[] = [];
    walkExpression(parsed.expression, (node) => names.push(node.kind));
    expect(names).toEqual(['binary', 'variable', 'property', 'variable']);
  });

  it('reports missing operands, closers and names', () => {
    expect(errors('$a +')).toEqual(['4-4 syntax: Expression expected']);
    expect(errors('[1, 2')).toEqual(["5-5 syntax: ']' expected"]);
    expect(errors('$a.')).toEqual(["3-3 syntax: Property name expected after '.'"]);
    expect(errors('if $a 1')).toEqual(["6-6 syntax: 'then' expected"]);
    expect(errors("'abc")).toEqual(['0-4 syntax: String is not closed']);
    expect(errors('$t.{$k')).toEqual(["6-6 syntax: '}' expected"]);
    expect(errors('sin($a')).toEqual(["6-6 syntax: ')' expected"]);
  });

  it('reports unexpected tokens and recovers', () => {
    expect(errors('$a $b')).toEqual(["3-5 syntax: Unexpected '$b'"]);
    expect(errors(')')).toEqual(['0-0 syntax: Expression expected', "0-1 syntax: Unexpected ')'"]);
    expect(errors('1 +* 2')).toEqual(['3-3 syntax: Expression expected']);
    expect(print(parseExpression('1 +* 2').expression)).toBe('(+ 1 (* <missing> 2))');
    expect(errors('$a ~ $b')).toEqual(["3-4 syntax: Unexpected '~'"]);
    const parsed = parseExpression('$a $b $c $d $e $f $g');
    expect(parsed.errors.map((error) => error.message)).toEqual(["Unexpected '$b'", "Unexpected '$d'", "Unexpected '$f'"]);
    expect(print(parsed.expression)).toBe('$a');
    expect(parseExpression(') ) ) ) ) ) )').errors.length).toBe(5);
  });

  it('reports what the game rejects beyond syntax', () => {
    expect(errors('@$a.$b?')).toEqual(["6-7 null-safe-exists: '@' and '?' cannot be combined in one expression"]);
    expect(errors('@$a.$b? and $c?')).toEqual(["6-7 null-safe-exists: '@' and '?' cannot be combined in one expression"]);
    expect(errors('{1001, $x}')).toEqual(['7-9 text-reference: A text reference takes numeric literals only; resolve the text to a string first']);
    expect(errors('{1001}')).toEqual(['0-6 text-reference: A text reference is {page, id} with two numbers']);
    expect(errors('table[foo = 1]')).toEqual(['6-9 syntax: A table key is a $variable or a {braced expression}']);
    expect(errors('table[$a 1]')).toEqual([
      "9-9 syntax: '=' and a value expected",
      "9-9 syntax: ']' expected",
      "9-10 syntax: Unexpected '1'",
      "10-11 syntax: Unexpected ']'",
    ]);
  });

  it('never throws on fragments', () => {
    const fragments = [
      '',
      ' ',
      '$',
      '.',
      '..',
      '{',
      '}',
      '{,}',
      '[',
      '[,',
      'table[',
      'table[$a',
      'table[$a =',
      'if',
      'if $a then',
      'else',
      '(',
      ')',
      '()',
      '(1',
      'sin(',
      '@',
      '?',
      '$a?.b',
      "'",
      '%',
      '1 2 3',
      '$a.{}',
      "'%s'.[",
      'not',
      'typeof',
    ];
    for (const fragment of fragments) {
      expect(() => parseExpression(fragment)).not.toThrow();
    }
  });
});
