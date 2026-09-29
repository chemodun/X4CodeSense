import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  loadGameData,
  loadScriptIndex,
  positionTokens,
  semanticTokenModifiers,
  semanticTokens,
  semanticTokensLegend,
  semanticTokenTypes,
  type AnalysisContext,
  type SemanticToken,
} from '../src';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
const game = loadGameData(path.join(fixtures, 'unpacked'));
const context: AnalysisContext = { schemas: game.schemas, properties: game.properties };

/** `text=type[.modifier]` of a token. */
function describeToken(text: string, token: SemanticToken): string {
  return `${text.slice(token.start, token.end)}=${token.type}${token.modifier ? `.${token.modifier}` : ''}`;
}

function tokensOf(text: string, withContext: AnalysisContext = context, uri?: string): SemanticToken[] {
  return semanticTokens(analyzeText(text, withContext, uri), game) ?? [];
}

/** The tokens of the line that holds `needle`, described. */
function onLine(text: string, needle: string, tokens: SemanticToken[] = tokensOf(text)): string[] {
  const at = text.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at);
  return tokens.filter((token) => token.start >= start && token.start < end).map((token) => describeToken(text, token));
}

/** Tokens in text order, apart, not empty, inside the text; on one line each once positioned. */
function checkShape(text: string, tokens: SemanticToken[]): void {
  let end = 0;
  for (const token of tokens) {
    expect(token.start).toBeGreaterThanOrEqual(end);
    expect(token.end).toBeGreaterThan(token.start);
    expect(token.end).toBeLessThanOrEqual(text.length);
    end = token.end;
  }
  const lines = text.split('\n');
  for (const positioned of positionTokens(TextDocument.create('untitled:x.xml', 'xml', 0, text), tokens)) {
    const line = lines[positioned.line].replace(/\r$/, '');
    expect(positioned.length).toBeGreaterThan(0);
    expect(positioned.character + positioned.length).toBeLessThanOrEqual(line.length);
  }
}

const mdScript = `<mdscript name="Highlight">
  <cues>
    <cue name="Start" instantiate="true" namespace="this">
      <actions>
        <set_value name="$count" exact="player.money / 2Cr + 1" />
        <set_value name="Later.$remote" exact="md.Highlight.Start" />
        <do_if value="$count gt 0 and not $flag? or player.ship.isclass.ship">
          <debug_text text="'count: %s'.[$count]" filter="error" />
        </do_if>
        <set_value name="$list" exact="[class.ship, tag.mission, ($count)s, abs(-1)]" />
        <set_value name="$table" exact="table[$key = 'value']" />
        <set_value name="$ship" exact="player.ship" />
        <set_value name="$ship.$mark" exact="$count &lt; 10" />
        <signal_cue_instantly cue="Later" param="if $count then this else true" />
        <run_actions ref="Lib" result="$result">
          <param name="target" value="player.ship" />
        </run_actions>
        <include_actions ref="Lib" />
      </actions>
    </cue>
    <cue name="Later" />
    <library name="Lib">
      <params>
        <param name="target" />
      </params>
      <actions>
        <set_value name="$result" exact="$target" />
      </actions>
    </library>
  </cues>
</mdscript>
`;

const aiScript = `<aiscript name="highlight" version="1">
  <params>
    <param name="target" default="player.ship" />
  </params>
  <interrupts>
    <library>
      <actions name="Prepare">
        <set_value name="$ready" exact="true" />
      </actions>
      <handler name="Watch">
        <conditions>
          <check_value value="$target.exists" />
        </conditions>
      </handler>
    </library>
    <handler ref="Watch" />
  </interrupts>
  <attention min="unknown">
    <actions>
      <label name="start" />
      <include_interrupt_actions ref="Prepare" />
      <do_if value="$target.exists and ($ready == true)">
        <set_value name="$distance" exact="if $target then 5km else 0m" />
      </do_if>
      <resume label="start" />
      <debug_text text="'first
second'" />
    </actions>
  </attention>
</aiscript>
`;

describe('semantic tokens', () => {
  it('announces its types and modifiers in the legend', () => {
    expect(semanticTokensLegend).toEqual({ tokenTypes: [...semanticTokenTypes], tokenModifiers: [...semanticTokenModifiers] });
    expect(semanticTokenTypes).toEqual(['namespace', 'function', 'label', 'variable', 'property', 'enumMember', 'keyword', 'number', 'string', 'operator']);
  });

  it('classifies a Mission Director script: variables, keywords, properties, lookups, cues, literals and operators', () => {
    const tokens = tokensOf(mdScript);
    checkShape(mdScript, tokens);
    const line = (needle: string): string[] => onLine(mdScript, needle, tokens);
    expect(line('<mdscript')).toEqual(['Highlight=namespace.declaration']);
    // Plain values keep the grammar's colour: `instantiate` and `namespace` are no expressions.
    expect(line('<cue name="Start"')).toEqual(['Start=namespace.declaration']);
    expect(line('player.money')).toEqual([
      '$count=variable.modification',
      'player=keyword',
      '.=operator',
      'money=property',
      '/=operator',
      '2Cr=number',
      '+=operator',
      '1=number',
    ]);
    // A cue's variable written from another cue, and the script and cue of `md.Script.Cue`.
    expect(line('Later.$remote')).toEqual([
      'Later=namespace',
      '.=operator',
      '$remote=variable.modification',
      'md=keyword',
      '.=operator',
      'Highlight=namespace',
      '.=operator',
      'Start=namespace',
    ]);
    // Word operators, `?`, and a bare value for a typed placeholder (`isclass.{$class}`).
    expect(line('$count gt 0')).toEqual([
      '$count=variable',
      'gt=operator',
      '0=number',
      'and=operator',
      'not=operator',
      '$flag=variable',
      '?=operator',
      'or=operator',
      'player=keyword',
      '.=operator',
      'ship=property',
      '.=operator',
      'isclass=property',
      '.=operator',
      'ship=enumMember',
    ]);
    // A whole value of the attribute's enumeration.
    expect(line('<debug_text')).toEqual(["'count: %s'=string", '.=operator', '[=operator', '$count=variable', ']=operator', 'error=enumMember']);
    // Lookup values, a placeholder a keyword names, a unit after a parenthesis, a call.
    expect(line('$list')).toEqual([
      '$list=variable.modification',
      '[=operator',
      'class=keyword',
      '.=operator',
      'ship=enumMember',
      ',=operator',
      'tag=keyword',
      '.=operator',
      'mission=enumMember',
      ',=operator',
      '(=operator',
      '$count=variable',
      ')=operator',
      's=number',
      ',=operator',
      'abs=function',
      '(=operator',
      '-=operator',
      '1=number',
      ')=operator',
      ']=operator',
    ]);
    // A table's key is no variable of the script, nor is a variable on a value; `&lt;` is one operator.
    expect(line('table[')).toEqual([
      '$table=variable.modification',
      'table=keyword',
      '[=operator',
      '$key=property',
      '==operator',
      "'value'=string",
      ']=operator',
    ]);
    expect(line('$ship.$mark')).toEqual(['$ship=variable', '.=operator', '$mark=property', '$count=variable', '&lt;=operator', '10=number']);
    expect(line('signal_cue_instantly')).toEqual([
      'Later=namespace',
      'if=keyword',
      '$count=variable',
      'then=keyword',
      'this=keyword',
      'else=keyword',
      'true=keyword',
    ]);
    // Libraries and their parameters, where they are called and where they are defined.
    expect(line('<run_actions')).toEqual(['Lib=namespace', '$result=variable.modification']);
    expect(line('<param name="target" value')).toEqual(['target=variable.declaration', 'player=keyword', '.=operator', 'ship=property']);
    expect(line('<include_actions')).toEqual(['Lib=namespace']);
    expect(line('<library')).toEqual(['Lib=namespace.declaration']);
    expect(line('<param name="target" />')).toEqual(['target=variable.declaration']);
  });

  it('classifies an AI script: parameters, labels and interrupt library items', () => {
    const tokens = tokensOf(aiScript);
    checkShape(aiScript, tokens);
    const line = (needle: string): string[] => onLine(aiScript, needle, tokens);
    expect(line('<aiscript')).toEqual([]);
    expect(line('<param name')).toEqual(['target=variable.declaration', 'player=keyword', '.=operator', 'ship=property']);
    expect(line('<actions name="Prepare"')).toEqual(['Prepare=function.declaration']);
    expect(line('<handler name="Watch"')).toEqual(['Watch=function.declaration']);
    expect(line('<handler ref="Watch"')).toEqual(['Watch=function']);
    expect(line('<include_interrupt_actions')).toEqual(['Prepare=function']);
    // A bare name that is the whole value: a value the attribute takes as is.
    expect(line('<attention')).toEqual(['unknown=enumMember']);
    expect(line('<label')).toEqual(['start=label.declaration']);
    expect(line('<resume')).toEqual(['start=label']);
    expect(line('($ready == true)')).toEqual([
      '$target=variable',
      '.=operator',
      'exists=property',
      'and=operator',
      '(=operator',
      '$ready=variable',
      '===operator',
      'true=keyword',
      ')=operator',
    ]);
    expect(line('5km')).toEqual([
      '$distance=variable.modification',
      'if=keyword',
      '$target=variable',
      'then=keyword',
      '5km=number',
      'else=keyword',
      '0m=number',
    ]);
  });

  it('splits a token that spans lines, and positions tokens in UTF-16 characters of each line', () => {
    const document = TextDocument.create('untitled:ai.xml', 'xml', 0, aiScript);
    const tokens = tokensOf(aiScript);
    const string = tokens.find((token) => token.type === 'string');
    expect(string && aiScript.slice(string.start, string.end)).toBe("'first\nsecond'");
    const positioned = positionTokens(document, [string as SemanticToken]);
    const lines = aiScript.split('\n');
    const first = lines.findIndex((line) => line.includes("'first"));
    expect(positioned).toEqual([
      { line: first, character: lines[first].indexOf("'first"), length: "'first".length, tokenType: semanticTokenTypes.indexOf('string'), tokenModifiers: 0 },
      { line: first + 1, character: 0, length: "second'".length, tokenType: semanticTokenTypes.indexOf('string'), tokenModifiers: 0 },
    ]);
    // Modifiers are bits in the order of the legend; a line break of CRLF text is left out too.
    const crlf = mdScript.replace(/\n/g, '\r\n');
    const crlfTokens = tokensOf(crlf);
    checkShape(crlf, crlfTokens);
    const declaration = positionTokens(TextDocument.create('untitled:md.xml', 'xml', 0, crlf), crlfTokens).find(
      (token) => token.tokenType === semanticTokenTypes.indexOf('namespace')
    );
    expect(declaration).toEqual({ line: 0, character: '<mdscript name="'.length, length: 'Highlight'.length, tokenType: 0, tokenModifiers: 1 });
  });

  it('classifies only the values that reach into a range', () => {
    const analysis = analyzeText(mdScript, context);
    const start = mdScript.indexOf('<set_value name="$table"');
    const end = mdScript.indexOf('\n', start);
    const tokens = semanticTokens(analysis, game, { start, end }) ?? [];
    expect(tokens.map((token) => describeToken(mdScript, token))).toEqual(onLine(mdScript, '<set_value name="$table"'));
  });

  it('takes what a patch brings in from its target, where it lands', () => {
    const gameFolder = path.join(fixtures, 'patches', 'game');
    const index = loadScriptIndex(gameFolder, [path.join(fixtures, 'patches', 'mods')], game.schemas);
    const file = path.join(fixtures, 'patches', 'mods', 'late_mod', 'md', 'setup.xml');
    const text = readFileSync(file, 'utf8');
    const tokens = tokensOf(text, { ...context, index }, pathToFileURL(file).toString());
    checkShape(text, tokens);
    expect(tokens.map((token) => describeToken(text, token))).toEqual([
      'Late=namespace.declaration',
      // The text of a `replace` that sets an attribute, as the value it becomes.
      '2=number',
      '$a=variable.modification',
      '1=number',
      '$b=variable.modification',
      '2=number',
    ]);
    // Without the index there is no target to classify in; the patch's own paths get nothing either way.
    expect(tokensOf(text, context, pathToFileURL(file).toString())).toEqual([]);
  });

  it('has nothing without the game schemas, and leaves other XML to other tooling', () => {
    expect(semanticTokens(analyzeText(mdScript), undefined)).toEqual([]);
    expect(semanticTokens(analyzeText(aiScript), undefined)).toEqual([]);
    expect(semanticTokens(analyzeText('<macros><macro name="m"/></macros>', context), game)).toBeUndefined();
  });

  describe('while typing', () => {
    it('classifies what the analysis still understands around a value whose quote is missing', () => {
      const text = mdScript.replace('<set_value name="$ship" exact="player.ship" />', '<set_value name="$ship exact="player.ship" />');
      const tokens = tokensOf(text);
      checkShape(text, tokens);
      expect(onLine(text, 'table[', tokens)).toContain('$key=property');
      expect(onLine(text, '<run_actions', tokens)).toEqual(['Lib=namespace', '$result=variable.modification']);
    });

    it('classifies the start tag that is being written, before its end tags', () => {
      const cut = mdScript.indexOf('<set_value name="$list"');
      const text = `${mdScript.slice(0, cut)}<set_value name="$list" exact="[class.ship, $cou`;
      const tokens = tokensOf(text);
      checkShape(text, tokens);
      expect(onLine(text, '$list', tokens)).toEqual([
        '$list=variable.modification',
        '[=operator',
        'class=keyword',
        '.=operator',
        'ship=enumMember',
        ',=operator',
        '$cou=variable',
      ]);
    });

    it('keeps its shape at every cut of the scripts', () => {
      for (const script of [mdScript, aiScript]) {
        for (let cut = 0; cut <= script.length; cut += 7) {
          const text = script.slice(0, cut);
          checkShape(text, tokensOf(text));
        }
      }
    });
  });
});
