/**
 * Quick fixes that create what a name refers to and nothing defines: a cue or library of a Mission
 * Director script, in the script itself or in the script `md.Script.Cue` names; a label of an AI script; a
 * parameter a call passes, declared where its target declares its parameters.
 *
 * What is created has the shape the game's own scripts give such items most often (9.00 and the mods): a
 * cue that `signal_cue` or `signal_cue_instantly` names waits for the signal, `event_cue_signalled` being
 * the first condition of nine in ten of them; what `include_actions`, `run_actions` or `<cue ref>` names
 * is a library with actions, and with the parameters the call passes; other cues get actions only. A
 * label goes first in the actions of its attention block: where it belongs is the author's choice. A file
 * of the game or a DLC is never changed, since an extension patches those instead.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { DocumentAnalysis } from '../analysis/analyzeDocument';
import type { GameData } from '../gameData';
import { callTarget, callTargetLabel } from '../project/callTargets';
import { mdReferenceAt } from '../project/mdReferences';
import { attributeNamed, elementWithStartTagAt, type XmlAttribute, type XmlElement } from '../xml/xmlStructure';
import type { XsdElement, XsdSchema } from '../xsd/schema';

export interface CreationEdit {
  start: number;
  end: number;
  text: string;
}

export interface CreationFix {
  title: string;
  /** Edits of the analysed document. */
  edits: CreationEdit[];
  /** Edits of another file. */
  elsewhere?: { document: TextDocument; edits: CreationEdit[] };
}

/** Lines of new elements, each with its depth below the first. */
type Lines = [depth: number, text: string][];

/** Writes new elements into a text with its line breaks and indentation. */
class Layout {
  readonly newline: string;

  constructor(readonly text: string) {
    this.newline = text.includes('\r\n') ? '\r\n' : '\n';
  }

  /** The whitespace before an element on its line; undefined when other text precedes it there. */
  indentOf(element: XmlElement): string | undefined {
    const lineStart = this.text.lastIndexOf('\n', element.start - 1) + 1;
    const before = this.text.slice(lineStart, element.start);
    return /^[ \t]*$/.test(before) ? before : undefined;
  }

  /**
   * One step of indentation, as the text indents a child from its parent nearest the element; else two
   * spaces, or a tab where the text indents with tabs.
   */
  unitNear(element: XmlElement): string {
    for (let current: XmlElement | undefined = element; current; current = current.parent) {
      const outer = this.indentOf(current);
      for (const child of current.children) {
        const inner = this.indentOf(child);
        if (outer !== undefined && inner !== undefined && inner.length > outer.length && inner.startsWith(outer)) {
          return inner.slice(outer.length);
        }
      }
    }
    return /^\t/m.test(this.text) ? '\t' : '  ';
  }

  private render(lines: Lines, indent: string, unit: string): string {
    return lines.map(([depth, line]) => `${indent}${unit.repeat(depth)}${line}`).join(this.newline);
  }

  /** True when the element's text is whole: a closed self-closing tag, or a start tag with its end tag. */
  private isWhole(element: XmlElement): boolean {
    return element.startTagClosed && (element.selfClosing || (element.endTag !== undefined && this.text[element.endTag.end - 1] === '>'));
  }

  /** On a line of its own after the element, at its indentation. */
  after(element: XmlElement, lines: Lines): CreationEdit | undefined {
    const indent = this.indentOf(element);
    if (indent === undefined || !this.isWhole(element)) {
      return undefined;
    }
    return { start: element.end, end: element.end, text: `${this.newline}${this.render(lines, indent, this.unitNear(element))}` };
  }

  /** As the first child of the element, one step deeper; a self-closing element gets an end tag. */
  firstChild(element: XmlElement, lines: Lines): CreationEdit | undefined {
    const indent = this.indentOf(element);
    if (indent === undefined || !this.isWhole(element)) {
      return undefined;
    }
    const unit = this.unitNear(element);
    const body = `${this.newline}${this.render(lines, indent + unit, unit)}`;
    if (element.selfClosing) {
      // `<actions/>` becomes `<actions>`, the new child, `</actions>`.
      return { start: element.startTagEnd - 2, end: element.startTagEnd, text: `>${body}${this.newline}${indent}</${element.name}>` };
    }
    return { start: element.startTagEnd, end: element.startTagEnd, text: body };
  }

  /** After the element's last child, or as its first when it has none. */
  lastChild(element: XmlElement, lines: Lines): CreationEdit | undefined {
    const last = element.children[element.children.length - 1];
    return last ? this.after(last, lines) : this.firstChild(element, lines);
  }

  /** A new child named `name` at the first place the element's content model allows it; first without a model. */
  child(element: XmlElement, declaration: XsdElement | undefined, name: string, lines: Lines): CreationEdit | undefined {
    const names = element.children.map((child) => child.name);
    const model = declaration?.contentModel;
    let at = 0;
    if (model) {
      const problems = model.validate(names).length;
      const fits = (index: number): boolean => model.validate([...names.slice(0, index), name, ...names.slice(index)]).length <= problems;
      at = [...names.keys(), names.length].find(fits) ?? 0;
    }
    return at === 0 ? this.firstChild(element, lines) : this.after(element.children[at - 1], lines);
  }
}

/** True when the file lies in the extracted game files, its DLCs included. */
function isGameFile(file: string, game: GameData | undefined): boolean {
  if (!game || file === '') {
    return false;
  }
  const relative = path.relative(game.folder, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The declaration of an element of a file without an analysis: down from the root, else any of its name. */
function declarationByPath(xsd: XsdSchema | undefined, element: XmlElement): XsdElement | undefined {
  const steps: XmlElement[] = [];
  for (let current: XmlElement | undefined = element; current; current = current.parent) {
    steps.unshift(current);
  }
  let declaration = xsd?.root(steps[0].name);
  for (const step of steps.slice(1)) {
    declaration = declaration?.child(step.name);
  }
  return declaration ?? xsd?.anyDeclaration(element.name);
}

/** Elements whose `ref` runs or includes a library's actions, or makes a cue of the library. */
const libraryUsers: ReadonlySet<string> = new Set(['include_actions', 'run_actions', 'cue']);
/** Actions that signal the cue they name, which then waits for the signal. */
const signallers: ReadonlySet<string> = new Set(['signal_cue', 'signal_cue_instantly']);

/** The cue or library a name nothing defines asks for, by where it is written; `whole` when the name is the attribute's whole value. */
function cueLines(element: XmlElement, attribute: XmlAttribute, name: string, whole: boolean): { noun: 'cue' | 'library'; lines: Lines } {
  if (whole && attribute.name === 'ref' && libraryUsers.has(element.name)) {
    const params =
      element.name === 'include_actions'
        ? []
        : element.children.flatMap((child) => {
            const param = child.name === 'param' ? attributeNamed(child, 'name')?.value.trim() : undefined;
            return param && /^\w+$/.test(param) ? [param] : [];
          });
    const lines: Lines = [[0, `<library name="${name}">`]];
    if (params.length > 0) {
      lines.push([1, '<params>'], ...params.map((param): [number, string] => [2, `<param name="${param}"/>`]), [1, '</params>']);
    }
    lines.push([1, '<actions>'], [1, '</actions>'], [0, '</library>']);
    return { noun: 'library', lines };
  }
  const lines: Lines = [[0, `<cue name="${name}">`]];
  if (whole && attribute.name === 'cue' && signallers.has(element.name)) {
    lines.push([1, '<conditions>'], [2, '<event_cue_signalled/>'], [1, '</conditions>']);
  }
  lines.push([1, '<actions>'], [1, '</actions>'], [0, '</cue>']);
  return { noun: 'cue', lines };
}

/** A cue of this script that a name refers to: after the cue or library the name is written in. */
function ownCueFixes(analysis: DocumentAnalysis, start: number): CreationFix[] {
  const occurrence = analysis.names?.occurrenceAt(start);
  if (occurrence?.start !== start || occurrence.kind !== 'cue' || occurrence.role !== 'reference' || occurrence.external || !/^\w+$/.test(occurrence.name)) {
    return [];
  }
  let anchor: XmlElement | undefined = occurrence.element;
  while (anchor && anchor.name !== 'cue' && anchor.name !== 'library') {
    anchor = anchor.parent;
  }
  const value = occurrence.attribute.value.trim();
  const whole = value === occurrence.name || value === `md.${analysis.detection.script?.name ?? ''}.${occurrence.name}`;
  const { noun, lines } = cueLines(occurrence.element, occurrence.attribute, occurrence.name, whole);
  const layout = new Layout(analysis.document.getText());
  const cues = analysis.structure?.roots[0]?.children.find((child) => child.name === 'cues');
  const edit = anchor ? layout.after(anchor, lines) : cues && layout.lastChild(cues, lines);
  return edit ? [{ title: `Create ${noun} '${occurrence.name}'`, edits: [edit] }] : [];
}

/** A cue of another script that `md.Script.Cue` names: last in the root cues of that script. */
function otherCueFixes(analysis: DocumentAnalysis, start: number, game: GameData | undefined): CreationFix[] {
  const structure = analysis.structure;
  const index = game?.index;
  const element = structure && elementWithStartTagAt(structure, start);
  const attribute = element?.attributes.find((candidate) => candidate.quote !== '' && start >= candidate.valueStart && start <= candidate.valueEnd);
  const found = element && attribute ? mdReferenceAt(element, attribute, start) : undefined;
  const reference = found?.part === 'cue' ? found.reference : undefined;
  if (!index || !element || !attribute || !reference?.cue || !/^\w+$/.test(reference.cue)) {
    return [];
  }
  const scripts = index.scripts('md', reference.script);
  // The script a call finds: the last in load order.
  const file = scripts[scripts.length - 1]?.file;
  const parsed = file !== undefined && !isGameFile(file, game) ? index.parsedFile(file) : undefined;
  const cues = parsed?.structure.roots[0]?.children.find((child) => child.name === 'cues');
  if (!file || !parsed || !cues) {
    return [];
  }
  const whole = attribute.value.trim() === `md.${reference.script}.${reference.cue}`;
  const { noun, lines } = cueLines(element, attribute, reference.cue, whole);
  const edit = new Layout(parsed.text).lastChild(cues, lines);
  if (!edit) {
    return [];
  }
  const document = TextDocument.create(pathToFileURL(file).toString(), 'xml', 0, parsed.text);
  return [{ title: `Create ${noun} '${reference.cue}' in script '${reference.script}'`, edits: [], elsewhere: { document, edits: [edit] } }];
}

/** A label a `resume` names: first in the actions of its attention block, or of the first block. */
function labelFixes(analysis: DocumentAnalysis, start: number): CreationFix[] {
  const occurrence = analysis.names?.occurrenceAt(start);
  if (occurrence?.start !== start || occurrence.kind !== 'label' || occurrence.role !== 'reference' || occurrence.external || /["<>&]/.test(occurrence.name)) {
    return [];
  }
  const attention = occurrence.items[0]?.owner ?? analysis.structure?.roots[0]?.children.find((child) => child.name === 'attention');
  const actions = attention?.children.find((child) => child.name === 'actions');
  const edit = actions && new Layout(analysis.document.getText()).firstChild(actions, [[0, `<label name="${occurrence.name}"/>`]]);
  return edit ? [{ title: `Create label '${occurrence.name}' at the start of the actions`, edits: [edit] }] : [];
}

/**
 * A parameter a call passes, declared after the target's other parameters, with the attributes a
 * declaration requires there left empty; a `<params>` where the schema allows one when there is none.
 */
function parameterFixes(analysis: DocumentAnalysis, start: number, game: GameData | undefined): CreationFix[] {
  const param = analysis.structure && elementWithStartTagAt(analysis.structure, start);
  const name = param?.name === 'param' ? attributeNamed(param, 'name')?.value.trim() : undefined;
  const call = param?.parent;
  if (!call || !name || !/^\w+$/.test(name)) {
    return [];
  }
  const target = callTarget(analysis, call, game?.index);
  if (!target || isGameFile(target.file, game)) {
    return [];
  }
  const home = target.declaredIn;
  const own = home.document === analysis.document;
  const xsd = game?.schemas.schemas[target.kind === 'library' ? 'md' : 'aiscripts'];
  const ownerDeclaration = (own ? analysis.declarations.get(home.owner) : undefined) ?? declarationByPath(xsd, home.owner);
  const declared = ownerDeclaration?.child('params')?.child('param');
  const required = [...(declared?.attributes ?? [])]
    .filter(([attribute, value]) => value.required && attribute !== 'name')
    .map(([attribute]) => ` ${attribute}=""`);
  const line = `<param name="${name}"${required.join('')}/>`;
  const layout = new Layout(home.document.getText());
  const edit = home.params
    ? layout.lastChild(home.params, [[0, line]])
    : layout.child(home.owner, ownerDeclaration, 'params', [
        [0, '<params>'],
        [1, line],
        [0, '</params>'],
      ]);
  if (!edit) {
    return [];
  }
  const title = `Add the parameter '${name}' to ${callTargetLabel(target)}`;
  return own ? [{ title, edits: [edit] }] : [{ title, edits: [], elsewhere: { document: home.document, edits: [edit] } }];
}

/** The fixes that create what a diagnostic says is missing; none in a patch, whose content lands in another file. */
export function creationFixes(analysis: DocumentAnalysis, code: string, start: number, game: GameData | undefined): CreationFix[] {
  if (analysis.detection.isDiff) {
    return [];
  }
  switch (code) {
    case 'cue-undefined': {
      const own = ownCueFixes(analysis, start);
      return own.length > 0 ? own : otherCueFixes(analysis, start, game);
    }
    case 'label-undefined':
      return labelFixes(analysis, start);
    case 'param-unknown':
      return parameterFixes(analysis, start, game);
  }
  return [];
}
