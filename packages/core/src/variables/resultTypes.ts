/**
 * The type of what an action writes into a variable. The game's files state it for few actions:
 * `create_ship name` is typed `lvaluename`, "Name of the value that will receive the result". So it is
 * told by the schema's types where they say it, and otherwise guessed from the game's own words. No
 * action is named here: the rules read the schema and the datatypes of the script properties.
 *
 * - Stated by the schema: an attribute typed or named `groupname` receives a group; one typed
 *   `countresult` receives a list when the element's `multiple` holds.
 * - Guessed, in this order: the noun phrase the attribute's documentation starts with, when it is wholly a
 *   datatype ("Result loadout", "A list of loadouts", "… that will receive a list of …"); for `name` and
 *   `result` the head noun of the element's name after its first word and before a preposition
 *   (`create_ship`, `find_object_component` → component, `find_ship_by_true_owner` → ship), for other
 *   attributes the attribute's name (`sector`, `wares`); for `name` and `result`, the noun phrase of the
 *   element's documentation after a verb that makes or finds something, when it is wholly a datatype or
 *   names one in parentheses ("Create an orientation(rotation) value"). A plural is a list. On an element
 *   with `multiple`, its `name` or `result`, and an attribute whose documentation names `multiple`, are
 *   lists when it holds.
 *
 * Measured on the game, its DLCs and a set of mods: of the 111 `name` and `result` of `create_`, `find_`
 * and `count_` elements, 72 get a type, and what scripts read on them contradicts two, both properties
 * scriptproperties.xml does not describe (the order `create_trade_order` gives has a `tradedeal`).
 */
import type { ScriptProperties } from '../properties/scriptProperties';
import { attributeNamed, type XmlElement } from '../xml/xmlStructure';
import { typeNamesOf, type XsdElement } from '../xsd/schema';

/** Where the type of a definition comes from. */
export type TypeSource =
  /** `<param type="ship">`. */
  | 'param type'
  /** The value a `set_value` or `param` sets. */
  | 'value'
  /** The schema's types: `groupname`, `countresult`. */
  | 'schema'
  /** A list, as the element's `multiple` holds. */
  | 'multiple'
  | 'element name'
  | 'attribute name'
  | 'attribute documentation'
  | 'element documentation';

/** The datatype a definition gives its variable. */
export interface WrittenType {
  name: string;
  /** Guessed from the names and documentation of the game's actions, not stated by the script or the schema. */
  guessed: boolean;
  source: TypeSource;
}

/** What an attribute receives, by its declaration alone. */
interface DeclaredResult {
  /** Datatype of one result; `list` for a plural. */
  type?: string;
  source?: TypeSource;
  /** A list when the element's `multiple` holds: as the schema states (`countresult`), or as guessed. */
  multiple?: 'stated' | 'guessed';
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(' '));
const prepositions = words('by in for with at from of outside inside to on near within between into around along towards over under per');
/** Words a noun phrase ends before. */
const stops = new Set([
  ...prepositions,
  ...words('and or that which if where when as so based attached using containing is are will can may must should returns return whose than'),
]);
/** Words a noun phrase may start with that do not name what it is. */
const determiners = words(
  'a an the all any some its this that these those one each every matching resulting result created found new given specified closest nearest random first last next single optional resultvalue'
);
/** Verbs whose object is what the element gives: "Create a ship", not "Traverse a list". */
const producing = /^(create|find|get|generate|launch|spawn|select|search|calculate|evaluate|count|request|retrieve|determine|compute)(s|es)?$/;

interface Phrase {
  words: string[];
  /** A word in parentheses right after the phrase: `orientation(rotation)`. */
  alias?: string;
}

/** The noun phrase a text starts with, after its verb when `afterVerb`, up to a stop word or punctuation. */
function phraseOf(text: string, afterVerb: boolean): Phrase {
  let rest = text.toLowerCase().replace(/\(s\)/g, '');
  const receive = /\bwill receive\b(.*)$/.exec(rest);
  if (receive) {
    rest = receive[1];
  }
  // "(optional, resultvalue) the found resource area"
  rest = rest.replace(/^\s*\([^)]*\)/, '');
  const tokens = rest.match(/[a-z]+|[^a-z\s]/g) ?? [];
  const words: string[] = [];
  let alias: string | undefined;
  let first = true;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!/^[a-z]/.test(token)) {
      if (token === '(' && words.length > 0 && /^[a-z]/.test(tokens[index + 1] ?? '') && tokens[index + 2] === ')') {
        alias = tokens[index + 1];
      }
      if (words.length > 0 || !first) {
        break;
      }
      continue;
    }
    if (first && afterVerb) {
      if (!producing.test(token)) {
        return { words: [] };
      }
      first = false;
      continue;
    }
    first = false;
    if (words.length === 0 && (determiners.has(token) || token === 'and')) {
      continue;
    }
    if (stops.has(token)) {
      break;
    }
    words.push(token);
  }
  return alias === undefined ? { words } : { words, alias };
}

/** A word as a datatype, or a plural of one. */
function typeOfWord(word: string, properties: ScriptProperties): { type: string; plural: boolean } | undefined {
  const usable = (name: string): boolean => {
    const datatype = properties.datatype(name);
    return datatype !== undefined && !datatype.pseudo;
  };
  if (usable(word)) {
    return { type: word, plural: false };
  }
  for (const [ending, replacement] of [
    ['ies', 'y'],
    ['es', ''],
    ['s', ''],
  ]) {
    if (word.endsWith(ending) && word.length > ending.length + 2) {
      const stem = word.slice(0, -ending.length) + replacement;
      if (usable(stem)) {
        return { type: stem, plural: true };
      }
    }
  }
  return undefined;
}

/** The head noun of a name's words: the longest compound ending at its last word that is a datatype. */
function headOf(words: readonly string[], properties: ScriptProperties): { type: string; plural: boolean } | undefined {
  for (let from = 0; from < words.length; from++) {
    const found = typeOfWord(words.slice(from).join(''), properties);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** A documentation phrase that is wholly a datatype, or whose word in parentheses is one. */
function phraseType(phrase: Phrase, properties: ScriptProperties): { type: string; plural: boolean } | undefined {
  const whole = phrase.words.length > 0 ? typeOfWord(phrase.words.join(''), properties) : undefined;
  return whole ?? (phrase.alias !== undefined ? typeOfWord(phrase.alias, properties) : undefined);
}

/** The words of an element's name after its first, before a preposition: `find_ship_by_true_owner` → ship. */
function nameWords(elementName: string): string[] {
  let words = elementName.split('_').filter((word) => word !== '');
  if (words.length > 1) {
    words = words.slice(1);
  }
  const cut = words.findIndex((word, index) => index > 0 && prepositions.has(word));
  return cut > 0 ? words.slice(0, cut) : words;
}

function declaredResult(declaration: XsdElement, attributeName: string, properties: ScriptProperties): DeclaredResult {
  const declared = declaration.attributes.get(attributeName);
  const typeNames = declared ? [...typeNamesOf(declared.type)] : [];
  if (typeNames.includes('groupname') || attributeName === 'groupname') {
    return { type: 'group', source: 'schema' };
  }
  const named = attributeName === 'name' || attributeName === 'result';
  const multiple = declaration.attributes.has('multiple');
  const documentation = declared?.documentation?.replace(/\s+/g, ' ');
  const attributeDoc = documentation !== undefined ? phraseType(phraseOf(documentation, false), properties) : undefined;
  const byName = named ? headOf(nameWords(declaration.name), properties) : headOf(attributeName.toLowerCase().split('_'), properties);
  const elementDoc = named && declaration.documentation ? phraseType(phraseOf(declaration.documentation.replace(/\s+/g, ' '), true), properties) : undefined;
  let chosen: { type: string; plural: boolean } | undefined;
  let source: TypeSource | undefined;
  if (attributeDoc && byName && !attributeDoc.plural && !byName.plural && properties.datatype(byName.type)?.isA(attributeDoc.type)) {
    // "Result operation" on `create_boarding_operation`: the name's type is the narrower.
    chosen = byName;
    source = 'element name';
  } else if (attributeDoc) {
    chosen = attributeDoc;
    source = 'attribute documentation';
  } else if (byName) {
    chosen = byName;
    source = named ? 'element name' : 'attribute name';
  } else if (elementDoc) {
    chosen = elementDoc;
    source = 'element documentation';
  }
  const listWhenMultiple = multiple && (named || /\bmultiple\b/i.test(documentation ?? ''));
  const result: DeclaredResult = {};
  if (chosen && source) {
    // A plural is a list, but where `multiple` decides, the name is plural for the many it may find.
    result.type = chosen.plural && !listWhenMultiple ? 'list' : chosen.type;
    result.source = source;
  }
  if (typeNames.includes('countresult')) {
    result.multiple = 'stated';
  } else if (listWhenMultiple) {
    result.multiple = 'guessed';
  }
  return result;
}

const declaredByProperties = new WeakMap<ScriptProperties, WeakMap<XsdElement, Map<string, DeclaredResult>>>();

function declaredResultOf(declaration: XsdElement, attributeName: string, properties: ScriptProperties): DeclaredResult {
  let byDeclaration = declaredByProperties.get(properties);
  if (!byDeclaration) {
    byDeclaration = new WeakMap();
    declaredByProperties.set(properties, byDeclaration);
  }
  let byAttribute = byDeclaration.get(declaration);
  if (!byAttribute) {
    byAttribute = new Map();
    byDeclaration.set(declaration, byAttribute);
  }
  let result = byAttribute.get(attributeName);
  if (!result) {
    result = declaredResult(declaration, attributeName, properties);
    byAttribute.set(attributeName, result);
  }
  return result;
}

/**
 * Whether an element's `multiple` holds: true, false, or undefined for an expression or a value being
 * typed. Absent, it is the default the attribute's documentation states, else the one the schema's
 * `findmultiple` documents: true for `count_` conditions, false for the others.
 */
export function multipleOf(element: XmlElement, declaration: XsdElement): boolean | undefined {
  const value = attributeNamed(element, 'multiple')?.value.trim();
  if (value === undefined) {
    const documentation = declaration.attributes.get('multiple')?.documentation ?? '';
    const stated = /\bdefault(?: is|:)? (true|false)\b/i.exec(documentation) ?? /\b(true|false) \(default\)/i.exec(documentation);
    return stated ? stated[1].toLowerCase() === 'true' : element.name.startsWith('count_');
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return undefined;
}

/**
 * The type an attribute that receives a value gives the variable it names, or undefined when nothing
 * tells it. Without `guess`, only what the schema's types state.
 */
export function writtenTypeOf(
  element: XmlElement,
  attributeName: string,
  declaration: XsdElement,
  properties: ScriptProperties,
  guess: boolean
): WrittenType | undefined {
  const declared = declaredResultOf(declaration, attributeName, properties);
  if (declared.multiple === 'guessed' && !guess) {
    return undefined;
  }
  if (declared.multiple) {
    const multiple = multipleOf(element, declaration);
    if (multiple === undefined) {
      return undefined;
    }
    if (multiple) {
      return { name: 'list', guessed: declared.multiple === 'guessed', source: 'multiple' };
    }
  }
  if (declared.type === undefined || declared.source === undefined) {
    return undefined;
  }
  const guessed = declared.source !== 'schema';
  return guessed && !guess ? undefined : { name: declared.type, guessed, source: declared.source };
}
