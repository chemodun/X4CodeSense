/**
 * Which elements call, and where AI script names and order ids are written. `<run_script name="'order.x'">`,
 * `<run_interrupt_script>`, `<start_script>`, `<create_order id="'Attack'">`, `<run_actions ref="Lib">` and
 * `<cue ref="md.Script.Lib">` pass `<param name value>` children to the script, order or library they name.
 *
 * Which elements call is the schemas' (their `param` takes a `value`); which attribute names the target
 * is said by the schemas' documentation only, so it is listed here. AI script names are defined by
 * `<aiscript name>`, order ids by `<order id>` under it; the calls name them as strings, and so does
 * `clear_recurring_order_failure id`. What a call calls is `callTargets`.
 */
import type { ScriptSchema } from '../types';
import { attributeNamed, offsetInValue, type XmlAttribute, type XmlElement, type XmlStructure } from '../xml/xmlStructure';

export type CallTargetKind = 'script' | 'order' | 'library';

export interface CallSpec {
  attribute: string;
  kind: CallTargetKind;
}

/** The elements that call with `<param>`s, by script kind, and the attribute that names what they call. */
const calls: Record<ScriptSchema, ReadonlyMap<string, CallSpec>> = {
  aiscripts: new Map([
    ['run_script', { attribute: 'name', kind: 'script' }],
    ['run_interrupt_script', { attribute: 'name', kind: 'script' }],
    ['start_script', { attribute: 'name', kind: 'script' }],
    ['create_order', { attribute: 'id', kind: 'order' }],
  ]),
  md: new Map([
    ['run_actions', { attribute: 'ref', kind: 'library' }],
    ['cue', { attribute: 'ref', kind: 'library' }],
    ['start_script', { attribute: 'name', kind: 'script' }],
    ['create_order', { attribute: 'id', kind: 'order' }],
  ]),
};

/** Elements that name an order without calling it: the schemas document `clear_recurring_order_failure id` as an order id. */
const namesWithoutCall: ReadonlyMap<string, CallSpec> = new Map([['clear_recurring_order_failure', { attribute: 'id', kind: 'order' }]]);

/**
 * Elements whose `<param>`s pass values to what is not a script, order or library: the diplomacy action
 * `create_diplomacy_action_operation` names is one of the game's libraries.
 */
export const callsNotToScripts: readonly string[] = ['create_diplomacy_action_operation'];

/** The elements of a script kind that call a script, order or library with `<param>`s. */
export function callElements(schema: ScriptSchema): string[] {
  return [...calls[schema].keys()];
}

/** What an element of a script kind calls and by which attribute, when it is a calling element. */
export function callSpecOf(element: XmlElement, schema: ScriptSchema | undefined): CallSpec | undefined {
  return schema ? calls[schema].get(element.name) : undefined;
}

/** True when the element calls a script, order or library in a script of the kind. */
export function isCall(element: XmlElement, schema: ScriptSchema | undefined): boolean {
  const spec = callSpecOf(element, schema);
  return spec !== undefined && attributeNamed(element, spec.attribute) !== undefined;
}

/** The element that a `<param>` passes to, when it is a call. */
export function callOf(param: XmlElement, schema: ScriptSchema | undefined): XmlElement | undefined {
  const call = param.parent;
  return param.name === 'param' && call && isCall(call, schema) ? call : undefined;
}

/** The trimmed value of an attribute as text offsets. */
export function valueRange(attribute: XmlAttribute): { start: number; end: number } {
  const raw = attribute.rawValue;
  const trimmed = raw.trim();
  const start = attribute.valueStart + Math.max(0, raw.indexOf(trimmed));
  return { start, end: start + trimmed.length };
}

export type ScriptNameKind = 'script' | 'order';

/** What names an AI script or order in an element: the call's attribute, or `clear_recurring_order_failure id`. */
function scriptNameSpecOf(element: XmlElement, schema: ScriptSchema | undefined): { attribute: string; kind: ScriptNameKind } | undefined {
  const spec = callSpecOf(element, schema) ?? (schema ? namesWithoutCall.get(element.name) : undefined);
  return spec && spec.kind !== 'library' ? { attribute: spec.attribute, kind: spec.kind } : undefined;
}

/** The kind of name an attribute holds when it names an AI script or an order: `run_script name`, `create_order id`, …. */
export function scriptNameKindOf(element: XmlElement, attributeName: string, schema: ScriptSchema | undefined): ScriptNameKind | undefined {
  const spec = scriptNameSpecOf(element, schema);
  return spec?.attribute === attributeName ? spec.kind : undefined;
}

/** An AI script name or order id written in a document, with the text offsets of the name alone. */
export interface ScriptName {
  kind: ScriptNameKind;
  name: string;
  start: number;
  end: number;
  /** True where it is defined: `<aiscript name>`, a root `<order id>`. */
  defines: boolean;
}

/** The AI script name or order id an element names as a literal string (`'move.generic'`), the quotes left out. */
function scriptNameReferenceOf(element: XmlElement, schema: ScriptSchema | undefined): ScriptName | undefined {
  const spec = scriptNameSpecOf(element, schema);
  const attribute = spec && attributeNamed(element, spec.attribute);
  const match = attribute && attribute.quote !== '' ? /^(\s*)'([^'$%{}[\]]+)'\s*$/.exec(attribute.value) : null;
  if (!spec || !attribute || !match) {
    return undefined;
  }
  const from = match[1].length + 1;
  return { kind: spec.kind, name: match[2], start: offsetInValue(attribute, from), end: offsetInValue(attribute, from + match[2].length), defines: false };
}

/** The AI script name an `<aiscript>` root defines, or the order id an `<order>` under it defines. */
function scriptNameDefinitionOf(element: XmlElement, schema: ScriptSchema | undefined): ScriptName | undefined {
  const isRoot = element.name === 'aiscript' && !element.parent;
  const isOrder = element.name === 'order' && element.parent?.name === 'aiscript' && !element.parent.parent;
  const attribute = schema === 'aiscripts' && (isRoot || isOrder) ? attributeNamed(element, isRoot ? 'name' : 'id') : undefined;
  const name = attribute && attribute.quote !== '' ? attribute.value.trim() : '';
  if (!attribute || name === '') {
    return undefined;
  }
  const { start, end } = valueRange(attribute);
  return { kind: isRoot ? 'script' : 'order', name, start, end, defines: true };
}

/** The AI script name or order id an element defines or names literally. */
export function scriptNameOf(element: XmlElement, schema: ScriptSchema | undefined): ScriptName | undefined {
  return scriptNameReferenceOf(element, schema) ?? scriptNameDefinitionOf(element, schema);
}

/** Every AI script name and order id a structure defines or names literally, in text order. */
export function scriptNamesIn(structure: XmlStructure, schema: ScriptSchema | undefined): ScriptName[] {
  return schema ? structure.elements.flatMap((element) => scriptNameOf(element, schema) ?? []) : [];
}
