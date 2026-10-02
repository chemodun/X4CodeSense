import { fileURLToPath } from 'node:url';
import type { ParameterInformation, SignatureHelp } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import { analyzeText, formatPlaceholders, formatSignatureHelp, loadGameData } from '../src';

const unpacked = fileURLToPath(new URL('./fixtures/unpacked', import.meta.url));
const game = loadGameData(unpacked);

const script = (value: string): string =>
  `<mdscript name="S">\n  <cues>\n    <cue name="A">\n      <actions>\n        <debug_text text="${value}"/>\n      </actions>\n    </cue>\n  </cues>\n</mdscript>\n`;

/** Signature help at the `|` of a value of debug_text. */
function helpAt(value: string): SignatureHelp | undefined {
  const marked = script(value);
  const offset = marked.indexOf('|');
  const analysis = analyzeText(marked.slice(0, offset) + marked.slice(offset + 1), { schemas: game.schemas, properties: game.properties });
  return formatSignatureHelp(analysis, offset, game);
}

/** The label and its parameters as the parts of the label they mark, the active one in brackets. */
function shown(help: SignatureHelp | undefined): string | undefined {
  const signature = help?.signatures[0];
  if (!signature) {
    return undefined;
  }
  const parts = (signature.parameters ?? []).map((parameter: ParameterInformation, index) => {
    const [start, end] = parameter.label as [number, number];
    const text = signature.label.slice(start, end);
    return index === help.activeParameter ? `[${text}]` : text;
  });
  return `${signature.label} | ${parts.join(' ')}`;
}

describe('format placeholders', () => {
  const placeholders = (format: string): string[] =>
    formatPlaceholders(format).map((placeholder) => `${placeholder.argument}:${format.slice(placeholder.start, placeholder.end)}`);

  it('takes the next argument for %s, with flags, and the numbered one for %1', () => {
    expect(placeholders('%s of %s')).toEqual(['0:%s', '1:%s']);
    expect(placeholders('%,s and %!s')).toEqual(['0:%,s', '1:%!s']);
    expect(placeholders('%2 before %1, %2 again')).toEqual(['1:%2', '0:%1', '1:%2']);
  });

  it('reads letters after the digits as text, %% as a percent sign, other letters as nothing', () => {
    expect(placeholders('time out: %4s, %3Cr')).toEqual(['3:%4', '2:%3']);
    expect(placeholders('100%% of %s')).toEqual(['0:%s']);
    expect(placeholders('%d and %x')).toEqual([]);
    expect(placeholders('%0')).toEqual([]);
  });
});

describe('signature help for formats', () => {
  it('marks the placeholder of the argument at the caret', () => {
    expect(shown(helpAt("'%s of %s'.[$a, |$b]"))).toBe("'%s of %s' | %s [%s]");
    expect(shown(helpAt("'%s of %s'.[|$a, $b]"))).toBe("'%s of %s' | [%s] %s");
    expect(shown(helpAt("'%2 before %1'.[$a, |$b]"))).toBe("'%2 before %1' | %1 [%2]");
    expect(helpAt("'%s of %s'.[$a, |$b]")?.signatures[0].documentation).toEqual({ kind: 'markdown', value: 'The format takes 2 arguments.' });
  });

  it('shows a text of the game that is the format', () => {
    expect(shown(helpAt('{2000, 1}.[$ship, |$buyer, $price]'))).toBe('{2000, 1}: %1 sold to %2 for %3Cr | %1 [%2] %3');
    expect(helpAt('{2000, 99}.[$ship, |$buyer]')).toBeUndefined();
  });

  it('tells about an argument the format does not use', () => {
    const help = helpAt("'%s'.[$a, |$b]");
    expect(help?.activeParameter).toBe(1);
    expect(help?.signatures[0].documentation).toEqual({ kind: 'markdown', value: 'The format takes 1 argument; this is argument 2, which it does not use.' });
    expect(helpAt("'no placeholder'.[|$a]")?.signatures[0].documentation).toEqual({ kind: 'markdown', value: 'The format takes no argument.' });
  });

  it('follows nested formats, strings and lists in the arguments', () => {
    expect(shown(helpAt("'%s: %s'.['%s and %s'.[$x, |$y], $z]"))).toBe("'%s and %s' | %s [%s]");
    expect(shown(helpAt("'%s: %s'.['%s and %s'.[$x, $y], |$z]"))).toBe("'%s: %s' | %s [%s]");
    expect(shown(helpAt("'%s: %s'.['a, b', |[1, 2]]"))).toBe("'%s: %s' | %s [%s]");
    // An escaped quote does not end a string.
    expect(shown(helpAt("'%s and %s'.['it\\'s, so', |$b]"))).toBe("'%s and %s' | %s [%s]");
  });

  it('gives nothing outside the arguments of a format', () => {
    expect(helpAt("'%s'|.[$a]")).toBeUndefined();
    expect(helpAt('$list.[|1]')).toBeUndefined();
    expect(helpAt("'%s'.[$a] + |1")).toBeUndefined();
  });

  describe('while typing', () => {
    it('helps in arguments not closed yet, and in every cut of the value', () => {
      expect(shown(helpAt("'%s of %s'.[$a, |"))).toBe("'%s of %s' | %s [%s]");
      const value = "'%s: %s'.['%s and %s'.[$x, $y], {2000, 1}.[$a, $b, $c]]";
      const outerArguments = value.indexOf('[') + 1;
      for (let cut = 0; cut <= value.length; cut++) {
        const label = helpAt(`${value.slice(0, cut)}|`)?.signatures[0]?.label;
        // Before the outer arguments and after them nothing; inside them the help of the format they belong to.
        if (cut < outerArguments || cut === value.length) {
          expect(label, value.slice(0, cut)).toBeUndefined();
        } else {
          expect(label, value.slice(0, cut)).toMatch(/^('%s: %s'|'%s and %s'|\{2000, 1\}: )/);
        }
      }
    });
  });
});
